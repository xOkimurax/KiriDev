#!/usr/bin/env node
// Servidor MCP (stdio) con las herramientas de archivos del agente. Lo lanza Claude Code por cada mensaje.
// No ejecuta comandos de shell: cada herramienta valida sus argumentos y solo toca el outbox/inbox de ese contacto.
import fs from 'node:fs';
import path from 'node:path';
import dns from 'node:dns';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import PDFDocument from 'pdfkit';
import { Document, Packer, Paragraph, HeadingLevel, TextRun } from 'docx';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, dirSize, QUOTA_BYTES, WORK_QUOTA_BYTES } from './files.js';

const OUTBOX = path.resolve(process.env.KIRI_OUTBOX || '');
const INBOX = process.env.KIRI_INBOX ? path.resolve(process.env.KIRI_INBOX) : null;
if (!process.env.KIRI_OUTBOX) { console.error('KIRI_OUTBOX no definido'); process.exit(1); }
fs.mkdirSync(OUTBOX, { recursive: true });
const QUEUE = path.join(OUTBOX, '.queue.jsonl');
const MAX_BYTES = 50 * 1024 * 1024;

const ok = (text) => ({ content: [{ type: 'text', text }] });
const fail = (text) => ({ content: [{ type: 'text', text: `Error: ${text}` }], isError: true });
const safeName = (n, fallback = 'archivo') => (path.basename(String(n || '')).replace(/[^\p{L}\p{N}._ -]/gu, '_').replace(/^\.+/, '').slice(0, 80) || fallback);

/** Resuelve una ruta y exige que sea un archivo normal dentro del outbox o del inbox de ESTE contacto. */
function resolveAllowed(p) {
  const abs = path.isAbsolute(p) ? p : path.join(OUTBOX, p);
  if (!fs.existsSync(abs)) throw new Error(`no existe: ${p}`);
  if (fs.lstatSync(abs).isSymbolicLink()) throw new Error('no se permiten enlaces simbólicos');
  const real = fs.realpathSync(abs);
  const roots = [OUTBOX, INBOX].filter(Boolean).map((r) => (fs.existsSync(r) ? fs.realpathSync(r) : r));
  if (!roots.some((r) => real.startsWith(r + path.sep))) throw new Error('solo podés usar archivos de tu carpeta de envío o los que te mandó esta persona');
  if (!fs.statSync(real).isFile()) throw new Error('no es un archivo');
  return real;
}
const checkQuota = (extra = 0) => {
  if (dirSize(OUTBOX) + extra > QUOTA_BYTES) throw new Error(`tu carpeta de envío está llena (máximo ${Math.round(QUOTA_BYTES / 1048576)} MB); se vacía sola cada 24 horas`);
  if (process.env.KIRI_WORK && dirSize(process.env.KIRI_WORK) + extra > WORK_QUOTA_BYTES) throw new Error('el almacenamiento temporal está lleno ahora mismo; probá de nuevo en un rato');
};
const save = (name, buf) => {
  if (buf.length > MAX_BYTES) throw new Error('el archivo supera los 50 MB');
  checkQuota(buf.length);
  const file = path.join(OUTBOX, safeName(name));
  fs.writeFileSync(file, buf);
  return file;
};
const withExt = (name, ext) => (path.extname(name) ? name : `${name}.${ext}`);

// ---------- generadores ----------
const latin = (s) => String(s).replace(/\*\*|__|`/g, '').replace(/[^\x20-\x7E\xA0-\xFF‘’“”–—•€\n\t]/g, '');
async function makePdf(title, text) {
  const doc = new PDFDocument({ margin: 56, info: { Title: latin(title || '') } });
  const chunks = [];
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((r) => doc.on('end', () => r(Buffer.concat(chunks))));
  if (title) doc.font('Helvetica-Bold').fontSize(20).text(latin(title)).moveDown();
  doc.font('Helvetica').fontSize(11);
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (!line.trim()) { doc.moveDown(0.5); continue; }
    if ((m = line.match(/^(#{1,3})\s+(.*)/))) { doc.moveDown(0.3).font('Helvetica-Bold').fontSize([18, 15, 12.5][m[1].length - 1]).text(latin(m[2])).moveDown(0.2).font('Helvetica').fontSize(11); continue; }
    if ((m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/))) { doc.text(`•  ${latin(m[1])}`, { indent: 12 }); continue; }
    doc.text(latin(line));
  }
  doc.end();
  return done;
}
const runs = (t) => String(t).split(/(\*\*[^*]+\*\*)/).filter(Boolean).map((p) => (p.startsWith('**') ? new TextRun({ text: p.slice(2, -2), bold: true }) : new TextRun(p)));
async function makeDocx(title, text) {
  const kids = [];
  if (title) kids.push(new Paragraph({ text: title, heading: HeadingLevel.TITLE }));
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\s+$/, ''); let m;
    if (!line.trim()) kids.push(new Paragraph(''));
    else if ((m = line.match(/^(#{1,3})\s+(.*)/))) kids.push(new Paragraph({ text: m[2], heading: [HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3][m[1].length - 1] }));
    else if ((m = line.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)/))) kids.push(new Paragraph({ children: runs(m[1]), bullet: { level: 0 } }));
    else kids.push(new Paragraph({ children: runs(line) }));
  }
  return Packer.toBuffer(new Document({ sections: [{ children: kids }] }));
}
async function makeXlsx(sheets) {
  const wb = new ExcelJS.Workbook();
  sheets.forEach((s, i) => {
    const ws = wb.addWorksheet(String(s.name || `Hoja${i + 1}`).replace(/[\\/?*[\]:]/g, '_').slice(0, 31));
    ws.addRows(s.rows);
    ws.getRow(1).font = { bold: true };
    ws.columns.forEach((c) => { let w = 8; c.eachCell({ includeEmpty: false }, (cell) => { w = Math.max(w, Math.min(60, String(cell.value ?? '').length + 2)); }); c.width = w; });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------- descarga segura (con motivos claros cuando falla) ----------
const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = (n) => (n / 1048576).toFixed(n < 10485760 ? 1 : 0);
class DownloadError extends Error {}

const httpReason = (st) => ({
  400: 'el sitio rechazó el pedido (400)', 401: 'requiere iniciar sesión (401)', 403: 'el sitio bloqueó la descarga automática (403)',
  404: 'el archivo ya no existe en esa dirección (404)', 410: 'el archivo fue eliminado (410)', 429: 'el sitio me limitó por exceso de pedidos (429); conviene probar más tarde',
  451: 'está bloqueado por razones legales (451)',
}[st] || (st >= 500 ? `el servidor del sitio está fallando (${st})` : `el servidor respondió ${st}`));

const isPrivateIp = (ip) => {
  if (net.isIPv6(ip)) { const l = ip.toLowerCase(); if (l === '::1' || l === '::' || l.startsWith('fe8') || l.startsWith('fe9') || l.startsWith('fea') || l.startsWith('feb') || /^f[cd]/.test(l)) return true; const m = l.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/); return m ? isPrivateIp(m[1]) : false; }
  const [a, b] = ip.split('.').map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
};
async function assertPublic(u) {
  if (!/^https?:$/.test(u.protocol)) throw new DownloadError('solo puedo descargar enlaces http(s)');
  let addrs;
  try { addrs = net.isIP(u.hostname) ? [{ address: u.hostname }] : await dns.promises.lookup(u.hostname, { all: true }); }
  catch { throw new DownloadError(`no encontré el sitio "${u.hostname}" (el dominio no existe o no responde)`); }
  if (!addrs.length || addrs.some((a) => isPrivateIp(a.address))) throw new DownloadError('esa dirección es interna/privada; por seguridad solo descargo de internet pública');
}

async function download(urlStr) {
  let url;
  try { url = new URL(urlStr); } catch { throw new DownloadError('el enlace no es una URL válida'); }
  let referer = null, netTries = 0;
  for (let hop = 0; hop < 8; hop++) {
    await assertPublic(url);
    let res;
    try {
      res = await fetch(url, { redirect: 'manual', signal: AbortSignal.timeout(60000), headers: { 'user-agent': UA, accept: '*/*', 'accept-language': 'es,en;q=0.8', ...(referer ? { referer } : {}) } });
    } catch (e) {
      if (netTries++ < 2) { await sleep(700 * netTries); hop--; continue; } // red inestable: reintentar
      const code = e.cause?.code || e.name;
      throw new DownloadError(code === 'TimeoutError' ? `${url.hostname} tardó demasiado en responder` : `no pude conectarme con ${url.hostname} (${code || e.message})`);
    }
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location'), url); continue; }
    if ((res.status === 403 || res.status === 401) && !referer) { referer = `${url.origin}/`; hop--; continue; } // muchos sitios exigen un Referer propio
    if (!res.ok) throw new DownloadError(httpReason(res.status));
    const len = Number(res.headers.get('content-length') || 0);
    if (len > MAX_BYTES) throw new DownloadError(`el archivo pesa ${MB(len)} MB y mi límite para enviar es ${MB(MAX_BYTES)} MB`);
    const chunks = []; let total = 0;
    try {
      for await (const c of res.body) { total += c.length; if (total > MAX_BYTES) throw new DownloadError(`el archivo supera ${MB(MAX_BYTES)} MB, mi límite para enviar`); chunks.push(c); }
    } catch (e) { if (e instanceof DownloadError) throw e; throw new DownloadError(`la descarga se cortó a mitad de camino (${e.cause?.code || e.message})`); }
    const cd = (res.headers.get('content-disposition') || '').match(/filename\*?=(?:UTF-8'')?"?([^";]+)/i)?.[1];
    let name = 'descarga';
    try { name = cd ? decodeURIComponent(cd) : decodeURIComponent(path.basename(url.pathname)) || 'descarga'; } catch { /* nombre tal cual */ }
    return { buf: Buffer.concat(chunks), name, ctype: (res.headers.get('content-type') || '').toLowerCase() };
  }
  throw new DownloadError('demasiadas redirecciones seguidas');
}

// ---------- video / audio de sitios (yt-dlp) ----------
const ytReason = (err) => {
  const e = String(err).toLowerCase();
  if (/sign in to confirm|not a bot|confirm you.re not a bot/.test(e)) return process.env.KIRI_COOKIES ? 'YouTube sigue pidiendo verificar que no soy un robot incluso con las cookies cargadas (pueden haber vencido o la cuenta fue marcada): hay que volver a exportarlas desde el panel' : 'el sitio (suele pasar con YouTube) bloquea las descargas hechas desde servidores y pide verificar que no soy un robot (se soluciona cargando en el panel las cookies de una cuenta de YouTube)';
  if (/private video|video is private|login required|log.?in|logged.?in|--cookies|sign in|members-only|premium|subscription|age.restricted|confirm your age/.test(e)) return 'el contenido es privado, tiene restricción de edad o requiere iniciar sesión / suscripción';
  if (/not available in your country|geo.?restrict|blocked it in your country|not made this video available|region/.test(e)) return 'no está disponible en la región donde está el servidor';
  if (/drm/.test(e)) return 'está protegido con DRM y no se puede descargar';
  if (/unsupported url/.test(e)) return 'ese sitio o enlace no es compatible para descargar medios';
  if (/video unavailable|has been removed|no longer available|does not exist|deleted|not found/.test(e)) return 'el contenido ya no está disponible (eliminado, privado o el enlace es incorrecto)';
  if (/http error 429|too many requests/.test(e)) return 'el sitio me limitó por exceso de pedidos; conviene probar más tarde';
  if (/http error 403|forbidden/.test(e)) return 'el sitio bloqueó la descarga (403)';
  if (/larger than max-filesize|file is larger/.test(e)) return `pesa más de ${MB(MAX_BYTES)} MB incluso en la menor calidad`;
  if (/live (event|stream)|is live|premieres/.test(e)) return 'es una transmisión en vivo o un estreno aún no disponible';
  if (/timed out|timeout/.test(e)) return 'la descarga tardó demasiado';
  return null;
};
let jsRuntimeFlag;
const ytdlp = (args, timeoutMs = 230000) => new Promise((resolve) => {
  const child = spawn('yt-dlp', args, { stdio: ['ignore', 'pipe', 'pipe'], env: { PATH: process.env.PATH, HOME: process.env.TMPDIR || '/tmp' } });
  let out = '', err = '';
  const timer = setTimeout(() => { child.kill('SIGKILL'); err += '\ntimed out'; }, timeoutMs);
  child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
  child.on('error', (e) => { clearTimeout(timer); resolve({ code: -1, out, err: e.code === 'ENOENT' ? 'yt-dlp no está instalado' : e.message }); });
  child.on('close', (code) => { clearTimeout(timer); resolve({ code, out, err }); });
});
async function downloadMedia(url, kind, maxHeight) {
  await assertPublic(new URL(url));
  try { checkQuota(MAX_BYTES); } catch (e) { throw new DownloadError(e.message); }
  // yt-dlp reescribe el archivo de cookies: se usa una copia temporal fuera del outbox (que se puede enviar) y se borra al terminar
  let cookieCopy = null;
  if (process.env.KIRI_COOKIES && fs.existsSync(process.env.KIRI_COOKIES)) { cookieCopy = path.join(process.env.TMPDIR || '/tmp', `kiri-ck-${process.pid}-${Date.now()}.txt`); fs.copyFileSync(process.env.KIRI_COOKIES, cookieCopy); fs.chmodSync(cookieCopy, 0o600); }
  try { return await downloadMediaInner(url, kind, maxHeight, cookieCopy); } finally { if (cookieCopy) fs.rmSync(cookieCopy, { force: true }); }
}
async function downloadMediaInner(url, kind, maxHeight, cookieCopy) {
  if (jsRuntimeFlag === undefined) { const h = await ytdlp(['--help'], 20000); jsRuntimeFlag = /--js-runtimes/.test(h.out) ? ['--js-runtimes', 'node'] : []; }
  const base = ['--no-playlist', '--no-warnings', '--no-progress', '--socket-timeout', '20', '--retries', '3', '--max-filesize', `${MAX_BYTES / 1048576}M`, '--restrict-filenames', '-o', path.join(OUTBOX, '%(title).70s-%(id)s.%(ext)s'), '--print', 'after_move:filepath', ...jsRuntimeFlag, ...(cookieCopy ? ['--cookies', cookieCopy] : [])];
  const heights = kind === 'audio' ? [0] : [...new Set([maxHeight, 480, 360].filter((h) => h <= maxHeight))];
  let last = '';
  for (const h of heights) {
    const args = kind === 'audio' ? [...base, '-x', '--audio-format', 'mp3', '--audio-quality', '5', url]
      : [...base, '-f', `bv*[height<=${h}]+ba/b[height<=${h}]/b`, '--merge-output-format', 'mp4', url];
    const r = await ytdlp(args);
    const file = r.out.split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (r.code === 0 && file && fs.existsSync(file)) return file;
    last = r.err.split('\n').filter(Boolean).slice(-2).join(' ').slice(0, 300) || `código ${r.code}`;
    if (!/larger than max-filesize|file is larger/i.test(last)) break; // solo se reintenta con menor calidad si el problema es el peso
  }
  const why = ytReason(last);
  throw new DownloadError(`${why || 'error desconocido al descargar el medio'}${/larger/i.test(last) && kind === 'video' ? '. Alternativa: pedir solo el audio' : ''} [detalle: ${last.slice(0, 160)}]`);
}

// ---------- herramientas ----------
const server = new McpServer({ name: 'kiri', version: '1.0.0' });

server.registerTool('write_file', {
  description: 'Crea un archivo en tu carpeta de envío. Sirve para texto, código, CSV, JSON, HTML, SVG, ICS, VCF, etc. (content en texto) o cualquier binario pequeño (content en base64 con base64=true). NO lo envía: después llamá a send_file.',
  inputSchema: { name: z.string().describe('Nombre con extensión, ej. "lista.csv"'), content: z.string(), base64: z.boolean().optional() },
}, async ({ name, content, base64 }) => {
  try { const f = save(name, base64 ? Buffer.from(content, 'base64') : Buffer.from(content, 'utf8')); return ok(`Archivo creado: ${f}`); } catch (e) { return fail(e.message); }
});

server.registerTool('make_document', {
  description: 'Genera un documento real: pdf o docx (a partir de texto con formato simple: "# Título", "- viñetas", **negrita**), xlsx (a partir de filas) o zip (comprimiendo archivos tuyos o recibidos). NO lo envía: después llamá a send_file.',
  inputSchema: {
    format: z.enum(['pdf', 'docx', 'xlsx', 'zip']), name: z.string().describe('Nombre sin o con extensión'),
    title: z.string().optional(), content: z.string().optional().describe('Texto del documento (pdf/docx)'),
    sheets: z.array(z.object({ name: z.string().optional(), rows: z.array(z.array(z.union([z.string(), z.number(), z.boolean(), z.null()]))) })).optional().describe('Hojas (xlsx); la primera fila es el encabezado'),
    files: z.array(z.string()).optional().describe('Rutas de archivos a comprimir (zip)'),
  },
}, async ({ format, name, title, content, sheets, files }) => {
  try {
    let buf;
    if (format === 'pdf') buf = await makePdf(title, content);
    else if (format === 'docx') buf = await makeDocx(title, content);
    else if (format === 'xlsx') { if (!sheets?.length) throw new Error('falta "sheets"'); buf = await makeXlsx(sheets); }
    else { if (!files?.length) throw new Error('falta "files"'); const z = new JSZip(); for (const p of files) { const r = resolveAllowed(p); z.file(path.basename(r), fs.readFileSync(r)); } buf = await z.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }); }
    return ok(`Documento creado: ${save(withExt(name, format), buf)}`);
  } catch (e) { return fail(e.message); }
});

server.registerTool('download_file', {
  description: 'Descarga un archivo desde un enlace público (imagen, PDF, zip, documento, instalador… lo que sea; máx. 50 MB) a tu carpeta de envío. NO lo envía: después llamá a send_file. Si falla, el mensaje de error dice el MOTIVO exacto: contáselo a la persona. Para videos o música de sitios como TikTok, Instagram, Twitter/X, Vimeo, SoundCloud, etc. usá download_media.',
  inputSchema: { url: z.string(), name: z.string().optional(), allow_html: z.boolean().optional().describe('true solo si realmente querés guardar la página HTML tal cual') },
}, async ({ url, name, allow_html }) => {
  try {
    const { buf, name: n, ctype } = await download(url);
    if (ctype.includes('text/html') && !allow_html && !/\.html?$/i.test(name || n))
      throw new DownloadError('esa dirección devuelve una página web (HTML), no un archivo descargable. Si lo que querés es el contenido de la página, leelo con WebFetch y armá un PDF con make_document; si buscás un archivo concreto, hace falta el enlace directo al archivo');
    if (buf.length === 0) throw new DownloadError('el archivo descargado está vacío');
    const tmp = save(safeName(name || n), buf);
    const d = describe(tmp); // si no tiene extensión, ponerle la real según su contenido
    let final = tmp;
    if (!path.extname(tmp) && d.ext && d.ext !== 'bin') { final = `${tmp}.${d.ext}`; fs.renameSync(tmp, final); }
    return ok(`Descargado: ${final} (${d.mime}, ${MB(buf.length)} MB)`);
  } catch (e) { return fail(e instanceof DownloadError ? `No pude descargarlo: ${e.message}` : e.message); }
});

server.registerTool('download_media', {
  description: 'Descarga un VIDEO o el AUDIO (mp3) de un enlace de sitios como TikTok, Instagram, Twitter/X, Facebook, Vimeo, SoundCloud, Reddit, Twitch, Dailymotion, etc. (cientos de sitios). Máx. 50 MB: baja la calidad solo si hace falta. YouTube suele bloquear los servidores. NO lo envía: después llamá a send_file. Si falla, el error trae el MOTIVO: contáselo a la persona.',
  inputSchema: { url: z.string(), kind: z.enum(['video', 'audio']).default('video'), max_height: z.number().int().min(144).max(1080).optional().describe('Altura máxima en píxeles del video (por defecto 720)') },
}, async ({ url, kind, max_height }) => {
  try {
    const f = await downloadMedia(url, kind, max_height || 720);
    return ok(`Descargado: ${f} (${MB(fs.statSync(f).size)} MB)`);
  } catch (e) { return fail(e instanceof DownloadError ? `No pude descargarlo: ${e.message}` : e.message); }
});

server.registerTool('send_file', {
  description: 'ENVÍA por WhatsApp a la persona un archivo (cualquier tipo): uno que creaste/descargaste (nombre o ruta de tu carpeta de envío) o uno que ella te mandó. Imágenes, videos y audios se mandan como tales; el resto como documento. Podés llamarla varias veces (máx. 5 por respuesta).',
  inputSchema: { path: z.string().describe('Nombre o ruta del archivo'), caption: z.string().optional().describe('Texto corto que acompaña (opcional)'), name: z.string().optional().describe('Nombre con el que lo ve la persona') },
}, async ({ path: p, caption, name }) => {
  try {
    const real = resolveAllowed(p);
    const size = fs.statSync(real).size;
    if (size > MAX_BYTES) throw new Error('el archivo supera los 50 MB');
    const queued = fs.existsSync(QUEUE) ? fs.readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).length : 0;
    if (queued >= 5) throw new Error('ya hay 5 archivos para enviar en esta respuesta');
    fs.appendFileSync(QUEUE, JSON.stringify({ path: real, name: name || path.basename(real), caption: caption || '' }) + '\n');
    return ok(`Listo: "${name || path.basename(real)}" se enviará junto con tu respuesta.`);
  } catch (e) { return fail(e.message); }
});

// Memoria (memoria.md) y programación: hablan con el hub por el token interno; el contacto sale de KIRI_JID (no se puede elegir otro).
async function hubPost(route, body, timeoutMs = 20000) {
  const res = await fetch(`${process.env.KIRI_HUB_URL}${route}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kiri-token': process.env.KIRI_HUB_TOKEN || '' }, body: JSON.stringify({ jid: process.env.KIRI_JID, ...body }), signal: AbortSignal.timeout(timeoutMs) });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `el servidor respondió ${res.status}`);
  return j;
}
if (process.env.KIRI_HUB_URL) {
  server.registerTool('remember', {
    description: 'Anota en tu memoria sobre ESTA conversación un dato duradero y útil (preferencias, datos que la persona compartió sobre sí o su situación, decisiones, pedidos recurrentes, fechas importantes, pendientes). Una línea, completa y autosuficiente. No guardes cosas pasajeras, charla trivial, claves ni contraseñas.',
    inputSchema: { fact: z.string().min(4).max(320).describe('El dato a recordar, en una línea') },
  }, async ({ fact }) => { try { return ok((await hubPost('/internal/memory', { action: 'add', text: fact })).message); } catch (e) { return fail(e.message); } });
  server.registerTool('forget', {
    description: 'Borra de tu memoria de esta conversación los datos que contengan ese texto (cuando la persona te pide olvidar algo o el dato quedó desactualizado).',
    inputSchema: { match: z.string().min(3).max(120).describe('Palabra o frase que identifica el dato a olvidar') },
  }, async ({ match }) => { try { return ok((await hubPost('/internal/memory', { action: 'remove', text: match })).message); } catch (e) { return fail(e.message); } });
}
// Notas de voz (ElevenLabs): el hub genera el audio; la clave nunca llega acá. Se encola como cualquier otro archivo.
if (process.env.KIRI_HUB_URL && process.env.KIRI_VOICE === '1') {
  server.registerTool('send_voice', {
    description: 'Convierte un texto en una nota de voz y la ENVÍA junto con tu respuesta. Escribí el texto como se dice en voz alta, en primera persona, sin emojis, sin markdown ni enlaces (seguí la guía de NOTAS DE VOZ). Máx. 5 archivos por respuesta.',
    inputSchema: { text: z.string().min(2).max(4000).describe('Lo que se dice en el audio, en frases naturales') },
  }, async ({ text }) => {
    try {
      const queued = fs.existsSync(QUEUE) ? fs.readFileSync(QUEUE, 'utf8').split('\n').filter(Boolean).length : 0;
      if (queued >= 5) throw new Error('ya hay 5 archivos para enviar en esta respuesta');
      const r = await hubPost('/internal/voice', { text }, 90000);
      const file = save(`nota-de-voz-${Date.now().toString(36)}.mp3`, Buffer.from(r.audio, 'base64'));
      fs.appendFileSync(QUEUE, JSON.stringify({ path: file, name: path.basename(file), caption: '' }) + '\n');
      return ok(`Listo: el audio (${r.chars} caracteres) se enviará junto con tu respuesta.`);
    } catch (e) { return fail(e.message); }
  });
}
if (!process.env.KIRI_SUB && process.env.KIRI_HUB_URL) {
  server.registerTool('schedule_create', {
    description: 'Programa un recordatorio o una tarea para más tarde o repetida, para ESTA conversación. Usá at (una sola vez, hora local "AAAA-MM-DD HH:mm") O cron (repetida, 5 campos: minuto hora día mes díaSemana, ej. "0 9 * * 1-5"). En instructions escribí qué decirle o hacer cuando llegue la hora, con todos los datos necesarios.',
    inputSchema: { title: z.string().min(3).max(80).describe('Título corto'), instructions: z.string().min(5).max(2000).describe('Qué decirle o hacer a la hora indicada'), at: z.string().optional().describe('Una sola vez: "AAAA-MM-DD HH:mm" en hora local'), cron: z.string().optional().describe('Repetida: expresión cron de 5 campos') },
  }, async (a) => {
    try { const r = await hubPost('/internal/schedules', { action: 'create', ...a }); return ok(`Programado #${r.id}: ${r.description}. Confirmale a la persona qué quedó y cuándo.`); } catch (e) { return fail(e.message); }
  });
  server.registerTool('schedule_list', { description: 'Lista lo que hay programado en esta conversación.', inputSchema: {} }, async () => {
    try { const r = await hubPost('/internal/schedules', { action: 'list' }); return ok(r.items.length ? r.items.map((s) => `#${s.id} «${s.title}» — ${s.description} [${s.status}]`).join('\n') : 'No hay nada programado.'); } catch (e) { return fail(e.message); }
  });
  server.registerTool('schedule_cancel', { description: 'Cancela una tarea programada de esta conversación por su número.', inputSchema: { id: z.number().int().positive() } }, async ({ id }) => {
    try { await hubPost('/internal/schedules', { action: 'cancel', id }); return ok(`Cancelada la tarea programada #${id}.`); } catch (e) { return fail(e.message); }
  });
}

if (!process.env.KIRI_SUB && process.env.KIRI_HUB_URL && process.env.KIRI_HANDOFF === '1') {
  server.registerTool('request_human', {
    description: 'Pide ayuda de una persona humana (el dueño) para ESTA conversación y le avisa por WhatsApp. Usala cuando no sepas la respuesta y no deba inventarse, cuando la persona pida hablar con alguien, esté molesta o frustrada, haya un reclamo, un pago/decisión importante o algo fuera de lo que podés hacer. Después de llamarla, avisale a la persona con naturalidad que una persona la va a atender.',
    inputSchema: { reason: z.string().min(3).max(300).describe('Motivo en una frase'), summary: z.string().max(1500).optional().describe('Resumen de la situación para quien la atienda (qué pidió, qué se habló, qué falta)'), urgency: z.enum(['alta', 'normal', 'baja']).optional() },
  }, async (a) => { try { const r = await hubPost('/internal/attention', a); return ok(`Aviso enviado${r.paused ? '; este chat queda en pausa hasta que una persona lo retome' : ''}. Ahora escribile a la persona, en tu estilo, que alguien la va a atender pronto.`); } catch (e) { return fail(e.message); } });
}

// Escribirle a otras personas (solo en chats de quien está autorizado a pedirlo) y cambiar/cancelar lo que está pendiente de aprobación.
if (!process.env.KIRI_SUB && process.env.KIRI_HUB_URL && (process.env.KIRI_OUTREACH === '1' || process.env.KIRI_OUTREACH_DECIDE === '1')) {
  const oc = async (body) => { try { return ok((await hubPost('/internal/outreach', body)).message); } catch (e) { return fail(e.message); } };
  if (process.env.KIRI_OUTREACH === '1') {
    server.registerTool('contact_start', {
      description: 'Escribile por WhatsApp a OTRA persona (para iniciar una conversación), SOLO porque quien te escribe te lo pidió. recipient = nombre del contacto, número de teléfono con código de país, o nombre de alguien de un grupo (opcional group para aclarar de cuál). Pasá EXACTAMENTE UNO: text (el texto tal cual, cuando la persona te lo dicta) u objective (qué querés lograr con el mensaje, cuando te pide que lo redactes vos). Si no te dijo cuál de los dos, preguntale antes de usar la herramienta. Puede quedar pendiente de aprobación por WhatsApp.',
      inputSchema: { recipient: z.string().min(2).max(120).describe('Nombre o número de teléfono con código de país'), group: z.string().max(120).optional().describe('Nombre del grupo, si el destinatario es alguien de un grupo'), text: z.string().min(1).max(1500).optional().describe('Texto exacto a enviar'), objective: z.string().min(3).max(500).optional().describe('Objetivo del mensaje, para que lo redactes vos') },
    }, (a) => oc({ action: 'start', ...a }));
  }
  server.registerTool('contact_pending', { description: 'Lista los mensajes que están pendientes de aprobación de esta persona (con su número).', inputSchema: {} }, () => oc({ action: 'pending' }));
  server.registerTool('contact_edit', { description: 'Cambia el texto de un mensaje pendiente de aprobación (por su número) cuando la persona te pide modificarlo. Pasá el texto nuevo COMPLETO. Vuelve a pedir la aprobación; vos nunca aprobás ni enviás.', inputSchema: { id: z.number().int().positive(), text: z.string().min(1).max(1500) } }, (a) => oc({ action: 'edit', ...a }));
  server.registerTool('contact_cancel', { description: 'Cancela un mensaje pendiente de aprobación (por su número) cuando la persona te pide dejarlo sin efecto.', inputSchema: { id: z.number().int().positive() } }, (a) => oc({ action: 'cancel', ...a }));
}

// Paneles del usuario (tablas, calendario, tablero, notas). Solo si el administrador lo habilitó para esta personalidad.
// Apps en el Docker aislado del agente: publicar con una URL (cada publicación la aprueba una persona por WhatsApp)
if (process.env.KIRI_HUB_URL && process.env.KIRI_APPS === '1') {
  const ac = async (body) => { try { return ok((await hubPost('/internal/apps', body)).message); } catch (e) { return fail(e.message); } };
  server.registerTool('publish_app', {
    description: 'Publica una app que está corriendo en tu Docker para que tenga una URL de internet. Antes tenés que haber creado el contenedor con el puerto PUBLICADO (docker run -p 3000 … o ports: - "3000" en compose; sin fijar un puerto de afuera). Pasá el nombre del contenedor (docker ps), el puerto DE LA APP dentro del contenedor y un nombre corto. Queda pendiente de aprobación por WhatsApp: no digas que está lista hasta que la aprueben (a la persona le llega el enlace). access="login" pide usuario y contraseña del panel; por defecto es pública.',
    inputSchema: { name: z.string().describe('nombre corto, minúsculas, números y guiones (ej. mi-tienda)'), container: z.string().describe('nombre del contenedor, como figura en docker ps'), port: z.number().int().min(1).max(65535).describe('puerto de la app dentro del contenedor'), access: z.enum(['public', 'login']).optional().describe('public (por defecto) o login'), description: z.string().max(300).optional().describe('qué es la app, en una frase (se le muestra a quien aprueba)') },
  }, (a) => ac({ action: 'publish', ...a }));
  server.registerTool('unpublish_app', { description: 'Quita de internet una app tuya publicada (o cancela una pendiente de aprobación). El contenedor sigue en tu Docker. Pasá su nombre o número.', inputSchema: { app: z.string().describe('nombre o número de la app') } }, (a) => ac({ action: 'unpublish', ...a }));
  server.registerTool('list_apps', { description: 'Lista tus apps publicadas o pendientes de aprobación, con su URL.', inputSchema: {} }, () => ac({ action: 'list' }));
}
if (process.env.KIRI_HUB_URL && process.env.KIRI_PANELS === '1') {
  const call = async (action, body, fmt) => { try { return ok(fmt(await hubPost('/internal/panels', { action, ...body }))); } catch (e) { return fail(e.message); } };
  const J = (r) => JSON.stringify(r);
  const fieldSchema = z.object({ label: z.string().min(1).max(60), type: z.enum(['text', 'number', 'money', 'date', 'datetime', 'select', 'checkbox', 'url']).optional().describe('Por defecto text. money = importes; select = lista de opciones'), options: z.array(z.string()).optional().describe('Solo para type=select') });
  const widgetSchema = z.object({ type: z.enum(['table', 'calendar', 'board', 'note', 'stat', 'documents']), title: z.string().max(80).optional(), collection: z.string().optional().describe('Nombre o id de la colección. Para un calendario con los recordatorios/tareas programadas usá "reminders". No va en las notas.'), config: z.record(z.any()).optional().describe('Todas las secciones de datos aceptan config.filter = {match, conds[{field,op,value,value2}], sort{field,dir}} como vista por defecto (ej. solo pedidos pendientes, ordenados por entrega). table: {columns:[campos]} · calendar: {dateField, titleField} · board: {groupField (campo select), titleField} · note: {text} · stat: {fn:"count"|"sum"|"avg", field} · documents: sin configuración (muestra los archivos guardados de esta persona)') });
  server.registerTool('panel_link', { description: 'Devuelve el ENLACE PERSONAL de esta persona a sus paneles: lo abre en el celular o el navegador, sin contraseña, y ve y edita SOLO sus propios paneles (nada de otras personas ni del panel de administración). Pasáselo COMPLETO, tal cual, y avisale que es personal.', inputSchema: {} }, () => call('panel_link', {}, (r) => `${r.url}\n${r.note}`));
  server.registerTool('document_save', { description: 'Guarda un archivo (uno que creaste con make_document/write_file o que la persona te mandó) en la sección Documentos de su panel, para que lo vea y lo abra desde su enlace personal sin descargarlo. Se ve mejor con PDF, imágenes, Word, Excel, CSV y texto.', inputSchema: { path: z.string().describe('Nombre o ruta del archivo'), title: z.string().max(120).optional().describe('Título para mostrar (opcional)') } }, async ({ path: p, title }) => {
    try {
      const real = resolveAllowed(p), buf = fs.readFileSync(real);
      if (buf.length > 25 * 1048576) return fail('El archivo supera los 25 MB.');
      const res = await fetch(`${process.env.KIRI_HUB_URL}/internal/documents`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kiri-token': process.env.KIRI_HUB_TOKEN || '' }, body: JSON.stringify({ jid: process.env.KIRI_JID, name: path.basename(real), title, data_b64: buf.toString('base64') }), signal: AbortSignal.timeout(90000) });
      const j = await res.json().catch(() => ({}));
      return res.ok ? ok(`Guardado en Documentos: «${j.title || j.name}»${j.duplicate ? ' (ya estaba)' : ''}. Para que lo vea, agregá una sección "documents" al panel (panel_update add_widgets [{type:"documents"}]) si todavía no la tiene, y dale su enlace con panel_link.`) : fail(j.error || `el servidor respondió ${res.status}`);
    } catch (e) { return fail(e.message); }
  });
  server.registerTool('panel_overview', { description: 'Lista los paneles y colecciones (tablas de datos) que ya existen en el panel del usuario, con sus campos. Llamala ANTES de crear algo, para modificar lo que ya hay en vez de duplicarlo.', inputSchema: {} }, () => call('overview', {}, J));
  server.registerTool('collection_create', { description: 'Crea una colección (tabla de datos) para guardar listas: precios, clientes, pedidos, nombres, lo que sea. Define los campos (columnas) con su tipo y puede cargar filas iniciales. Después se muestra en un panel con panel_create/panel_update.', inputSchema: { name: z.string().min(1).max(60), fields: z.array(fieldSchema).min(1).max(30), rows: z.array(z.record(z.any())).max(200).optional().describe('Filas iniciales: objetos con el nombre del campo como clave') } }, (a) => call('collection_create', a, J));
  server.registerTool('collection_add_field', { description: 'Agrega un campo (columna) a una colección existente.', inputSchema: { collection: z.string(), label: z.string().min(1).max(60), type: z.enum(['text', 'number', 'money', 'date', 'datetime', 'select', 'checkbox', 'url']).optional(), options: z.array(z.string()).optional() } }, (a) => call('collection_add_field', a, J));
  server.registerTool('rows_add', { description: 'Agrega filas a una colección (hasta 200 por vez). Cada fila es un objeto {campo: valor}.', inputSchema: { collection: z.string(), rows: z.array(z.record(z.any())).min(1).max(200) } }, (a) => call('rows_add', a, J));
  const filterSchema = z.object({ match: z.enum(['all', 'any']).optional().describe('all = cumplir TODAS las condiciones (por defecto); any = cumplir ALGUNA'), conds: z.array(z.object({ field: z.string().describe('Campo (clave o nombre)'), op: z.string().describe('texto: contains, not_contains, eq, neq, starts, ends, empty, not_empty · número/dinero: eq, neq, gt, gte, lt, lte, between, empty, not_empty · fecha: on, before, after, between, today, yesterday, tomorrow, this_week, this_month, last_month, last_7, next_7, past, future, empty, not_empty · selección: in, not_in, empty, not_empty · casilla: is_true, is_false'), value: z.any().optional(), value2: z.any().optional().describe('Segundo valor (solo between)') })).max(20).optional(), sort: z.object({ field: z.string(), dir: z.enum(['asc', 'desc']).optional() }).optional() });
  server.registerTool('rows_find', { description: 'Busca filas de una colección por texto y/o con filtros de cualquier tipo (por campo y operador: mayor que, entre fechas, es uno de, etc.) y las ordena. Devuelve cada fila con su id, para poder modificarla.', inputSchema: { collection: z.string(), query: z.string().optional(), filter: filterSchema.optional(), limit: z.number().int().min(1).max(50).optional() } }, (a) => call('rows_find', a, J));
  server.registerTool('rows_update', { description: 'Modifica campos de una fila (por su id).', inputSchema: { collection: z.string(), row_id: z.number().int().positive(), set: z.record(z.any()) } }, (a) => call('rows_update', a, J));
  server.registerTool('rows_delete', { description: 'Borra filas. SOLO después de que la persona lo haya pedido o confirmado en la charla; recién ahí llamala con confirmed=true. Queda en el historial para poder deshacer.', inputSchema: { collection: z.string(), row_ids: z.array(z.number().int().positive()).min(1).max(50), confirmed: z.boolean() } }, (a) => call('rows_delete', a, J));
  server.registerTool('panel_create', { description: 'Crea un panel (sección del panel web del usuario) con varias secciones (widgets). O pasá template ("agenda", "precios", "clientes", "pedidos", "notas") para arrancar de una plantilla. Antes de crear mirá panel_overview: si ya hay uno parecido, modificalo con panel_update.', inputSchema: { title: z.string().min(1).max(80), folder: z.string().max(40).optional(), template: z.enum(['agenda', 'precios', 'clientes', 'pedidos', 'notas', 'documentos', 'vacio']).optional(), widgets: z.array(widgetSchema).max(12).optional() } }, (a) => call('panel_create', a, J));
  server.registerTool('panel_update', { description: 'Modifica un panel existente: cambia el título/carpeta, agrega secciones (add_widgets) o reemplaza todas (widgets).', inputSchema: { panel: z.string().describe('Título o id del panel'), title: z.string().max(80).optional(), folder: z.string().max(40).optional(), add_widgets: z.array(widgetSchema).max(12).optional(), widgets: z.array(widgetSchema).max(12).optional() } }, (a) => call('panel_update', a, J));
}

// Solo el agente principal (el que le contesta a la persona) puede citar un mensaje al responder.
if (!process.env.KIRI_SUB) {
  server.registerTool('quote_message', {
    description: 'Hace que tu respuesta de WhatsApp salga CITANDO (función "responder") un mensaje concreto. Usala por tu cuenta, sin que te lo pidan, SIEMPRE que tu respuesta se refiera a un mensaje puntual (de la persona, tuyo o de otra persona del grupo) o la persona te esté contestando/citando algo: "¿dónde/cuándo dije…?", "¿qué te dije de…?", aclarar o retomar algo dicho antes, o contestar entre varios temas o personas. No la uses cuando simplemente contestás lo último que se dijo en un intercambio de a dos. Llamala ANTES de escribir tu respuesta. Pasá el número N del mensaje (aparece como #N; el actual figura al principio como [mensaje #N]). Ese número es interno: nunca lo escribas en tu respuesta.',
    inputSchema: { message_ref: z.number().int().positive().describe('El número N del mensaje a citar (#N)') },
  }, async ({ message_ref }) => {
    fs.writeFileSync(path.join(OUTBOX, '.quote.json'), JSON.stringify({ ref: message_ref }));
    return ok(`Listo: tu respuesta saldrá citando el mensaje #${message_ref}. Ahora escribí la respuesta normalmente.`);
  });
}

// Solo el agente principal delega (los sub agentes no: evita cadenas infinitas). Habla con el hub por un token interno.
if (!process.env.KIRI_SUB && process.env.KIRI_HUB_URL) {
  server.registerTool('delegate_task', {
    description: 'Delega un trabajo a un SUB AGENTE que lo hace en segundo plano (con las mismas herramientas: archivos, descargas, web, comandos). Usala para todo lo que lleve más que una respuesta corta. Las instrucciones deben ser completas y autosuficientes: el sub agente NO ve esta conversación. Cuando termine, el sistema te avisa y le escribís a la persona. Después de llamarla, respondé con un mensaje corto avisando que ya estás en eso.',
    inputSchema: { title: z.string().min(3).max(80).describe('Título corto de la tarea'), instructions: z.string().min(20).max(8000).describe('Qué hacer, con todos los datos exactos (enlaces, nombres, formato) y qué archivos entregar') },
  }, async ({ title, instructions }) => {
    try {
      const res = await fetch(`${process.env.KIRI_HUB_URL}/internal/tasks`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kiri-token': process.env.KIRI_HUB_TOKEN || '' }, body: JSON.stringify({ jid: process.env.KIRI_JID, title, instructions }), signal: AbortSignal.timeout(15000) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return fail(j.error || `el servidor respondió ${res.status}`);
      return ok(`Tarea #${j.id} «${j.title}» delegada: el sub agente ya está trabajando en segundo plano. AHORA escribile a la persona un mensaje corto y en tu estilo avisando que ya estás en eso y que le avisás cuando termine. No esperes ni inventes el resultado.`);
    } catch (e) { return fail(e.message); }
  });
}

// Solo los sub agentes (los que trabajan) pueden sumar MCPs; quedan disponibles desde la PRÓXIMA tarea.
if (process.env.KIRI_SUB && process.env.KIRI_HUB_URL) {
  server.registerTool('mcp_login_link', {
    description: 'Genera el enlace para que la persona inicie sesión en un MCP remoto que lo pide (Supabase, Notion, Linear…). Pasale el enlace COMPLETO, tal cual; lo abre en su celular o navegador. Cuando termina, el sistema le avisa solo que quedó conectado.',
    inputSchema: { name: z.string().min(1).max(60).describe('Nombre del MCP tal como figura en el panel') },
  }, async ({ name }) => {
    try {
      const res = await fetch(`${process.env.KIRI_HUB_URL}/internal/mcp-login`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kiri-token': process.env.KIRI_HUB_TOKEN || '' }, body: JSON.stringify({ jid: process.env.KIRI_JID, name }), signal: AbortSignal.timeout(60000) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return fail(j.error || `el servidor respondió ${res.status}`);
      return ok(`Enlace de inicio de sesión para «${name}» (vale ~${j.expires_in_min} minutos): ${j.url}\nPasáselo a la persona COMPLETO, tal cual.`);
    } catch (e) { return fail(e.message); }
  });
  server.registerTool('add_mcp_server', {
    description: 'Agrega un servidor MCP (herramientas externas) al agente. Aceptá el JSON de "mcpServers", una URL, un comando como "npx -y paquete" o una línea "claude mcp add ...", tal cual te lo pasaron. Se guarda, se prueba la conexión y devuelve las herramientas que expone. Queda disponible en la PRÓXIMA tarea (no en esta): avisale a la persona que ya está instalado y que puede pedirte que lo uses. Si necesita una clave que no tenés, pedísela a la persona.',
    inputSchema: { config: z.string().min(3).max(20000).describe('La configuración del MCP, tal cual (JSON, URL, comando o "claude mcp add ...")') },
  }, async ({ config }) => {
    try {
      const res = await fetch(`${process.env.KIRI_HUB_URL}/internal/mcp`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-kiri-token': process.env.KIRI_HUB_TOKEN || '' }, body: JSON.stringify({ config, jid: process.env.KIRI_JID }), signal: AbortSignal.timeout(120000) });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) return fail(j.error || `el servidor respondió ${res.status}`);
      return ok(j.servers.map((s) => s.status === 'ok' ? `✅ ${s.name}: conectado, ${s.tools.length} herramientas (${s.tools.map((t) => t.name).slice(0, 12).join(', ')}). Disponible desde la próxima tarea.` : s.status === 'auth_required' ? (s.login_url ? `🔐 ${s.name}: se instaló, pero PIDE INICIAR SESIÓN. Pasale a la persona este enlace COMPLETO, tal cual, para que lo abra en su celular o navegador e inicie sesión (vale ~20 minutos): ${s.login_url}\nCuando termine, el sistema le avisa solo que quedó conectado.` : `🔐 ${s.name}: pide iniciar sesión pero no pude armar el enlace (${s.login_error}). Contale a la persona que hace falta un token de acceso.`) : `⚠️ ${s.name}: se guardó pero la prueba falló: ${s.status_msg}`).join('\n'));
    } catch (e) { return fail(e.message); }
  });
}

await server.connect(new StdioServerTransport());
