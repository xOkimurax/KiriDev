// Convierte lo que llega por WhatsApp (audio, imagen, documento, video, ubicación…) en un prompt para Claude.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import * as evo from './evolution.js';
import * as F from './files.js';
import { AGENT_DIR } from './persona.js';
import { groqKey } from './secrets.js';

// Todo lo que se recibe o se genera vive dentro del volumen del contenedor (disco fijo de 40 GB montado en /data).
export const WORK_DIR = path.resolve(process.env.WORK_DIR || path.join(os.tmpdir(), 'kiri-work'));
export const INBOX = path.join(WORK_DIR, 'inbox');
const MAX_BYTES = 20 * 1024 * 1024;

/** Error cuyo mensaje se le puede mostrar tal cual a quien escribió. */
export class UserFacingError extends Error {}

export const safe = (s) => String(s).replace(/[^a-z0-9._-]/gi, '_').slice(0, 60);
export const inboxDir = (jid) => path.join(INBOX, safe(jid));

function cleanDir(root, maxAgeMs) {
  if (!fs.existsSync(root)) return;
  // un error limpiando NUNCA debe tumbar el servidor (un archivo suelto en la raíz del outbox lo dejó en bucle de reinicios)
  const sweep = (x) => {
    for (const e of fs.readdirSync(x)) {
      try {
        const f = path.join(x, e), st = fs.lstatSync(f);
        if (st.isDirectory()) { sweep(f); if (!fs.readdirSync(f).length) fs.rmdirSync(f); }
        else if (Date.now() - st.mtimeMs > maxAgeMs) fs.rmSync(f, { force: true });
      } catch (err) { console.error(`[limpieza] no se pudo revisar ${path.join(x, e)}: ${err.message}`); }
    }
  };
  sweep(root); // recursivo: el inbox puede tener subcarpetas (zips extraídos) y la raíz puede tener archivos sueltos
  for (const dir of fs.readdirSync(root)) {
    const d = path.join(root, dir);
    try { if (fs.lstatSync(d).isDirectory() && !fs.readdirSync(d).length) fs.rmSync(d, { recursive: true, force: true }); } catch { /* se reintenta en la próxima pasada */ }
  }
}
export const OUTBOX = path.join(WORK_DIR, 'outbox');
export const outboxDir = (jid) => path.join(OUTBOX, safe(jid));
export function cleanInbox() {
  for (const [dir, ms] of [[INBOX, 3 * 864e5], [OUTBOX, 864e5]]) { try { cleanDir(dir, ms); } catch (e) { console.error(`[limpieza] ${dir}: ${e.message}`); } }
}

// ---------- descarga y descifrado de medios de WhatsApp (sin depender de que Evolution guarde mensajes) ----------
const HKDF_INFO = { audio: 'WhatsApp Audio Keys', image: 'WhatsApp Image Keys', video: 'WhatsApp Video Keys', document: 'WhatsApp Document Keys' };
const toBytes = (v) => {
  if (!v) return null;
  if (typeof v === 'string') return Buffer.from(v, 'base64');
  if (Array.isArray(v)) return Buffer.from(v);
  if (typeof v === 'object') return Buffer.from(Object.keys(v).sort((a, b) => a - b).map((k) => v[k])); // Buffer serializado como {"0":12,"1":34…}
  return null;
};
const isWhatsAppHost = (u) => { try { const x = new URL(u); return x.protocol === 'https:' && /(^|\.)whatsapp\.(net|com)$/.test(x.hostname); } catch { return false; } };

async function downloadWhatsAppMedia(m, kind) {
  const key = toBytes(m.mediaKey);
  if (!key?.length) throw new Error('el evento no trae mediaKey');
  const urls = [m.url, m.directPath && `https://mmg.whatsapp.net${m.directPath}`].filter((u) => u && isWhatsAppHost(u));
  if (!urls.length) throw new Error('el evento no trae una URL de WhatsApp válida');
  // la CDN de WhatsApp a veces corta la primera conexión (ETIMEDOUT): reintentar con espera
  let enc, lastErr;
  for (let attempt = 1; attempt <= 4 && !enc; attempt++) {
    for (const u of urls) {
      try {
        const r = await fetch(u, { signal: AbortSignal.timeout(25000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        enc = Buffer.from(await r.arrayBuffer());
        break;
      } catch (e) {
        lastErr = new Error(`${e.message}${e.cause?.code ? ` (${e.cause.code})` : ''}`);
        if (/HTTP 4(0[0-9]|1[0-9])/.test(e.message)) continue; // 4xx: probar la otra URL, reintentar no ayuda
      }
    }
    if (!enc && attempt < 4) await new Promise((r) => setTimeout(r, 800 * attempt));
  }
  if (!enc) throw lastErr;
  if (enc.length > MAX_BYTES * 1.1) throw new UserFacingError('Ese archivo es demasiado pesado para mí (máximo 20 MB).');
  const k = Buffer.from(crypto.hkdfSync('sha256', key, Buffer.alloc(0), HKDF_INFO[kind === 'sticker' ? 'image' : kind] || HKDF_INFO.document, 112));
  const iv = k.subarray(0, 16), body = enc.subarray(0, -10), mac = enc.subarray(-10);
  const expected = crypto.createHmac('sha256', k.subarray(48, 80)).update(iv).update(body).digest().subarray(0, 10);
  if (!crypto.timingSafeEqual(expected, mac)) throw new Error('el archivo descargado no pasa la verificación (MAC)');
  const d = crypto.createDecipheriv('aes-256-cbc', k.subarray(16, 48), iv);
  return Buffer.concat([d.update(body), d.final()]);
}

async function download(evt) {
  const tooBig = () => new UserFacingError('Ese archivo es demasiado pesado para mí (máximo 20 MB).');
  const result = (buf, mime, fileName) => { if (buf.length > MAX_BYTES) throw tooBig(); return { buf, mime: mime || 'application/octet-stream', fileName: fileName || '' }; };

  // 1) El webhook ya trae el archivo en base64
  if (evt.base64) return result(Buffer.from(evt.base64, 'base64'), evt.mimetype, evt.fileName);
  // 2) Lo normal con esta Evolution: bajarlo de WhatsApp y descifrarlo con la mediaKey del evento
  if (evt.media?.mediaKey) {
    try { return result(await downloadWhatsAppMedia(evt.media, evt.kind), evt.media.mimetype || evt.mimetype, evt.fileName); }
    catch (e) { if (e instanceof UserFacingError) throw e; console.error(`[media] descarga directa falló (${evt.kind} ${evt.key?.id || ''}): ${e.message}`); }
  }
  // 3) Respaldo: pedírselo a Evolution (solo funciona si esa instancia guarda mensajes)
  if (evt.key?.id) {
    try {
      const m = await evo.getMedia(evt.key.id);
      if (m?.base64) return result(Buffer.from(m.base64, 'base64'), m.mimetype || evt.mimetype, m.fileName || evt.fileName);
    } catch (e) {
      if (e instanceof UserFacingError) throw e;
      console.error(`[media] getBase64FromMediaMessage falló para ${evt.key.id}: ${e.message}`);
    }
  }
  console.error(`[media] sin archivo para ${evt.kind} ${evt.key?.id || '(sin id)'}: ni base64, ni media descifrable, ni Evolution`);
  throw new UserFacingError('No pude descargar el archivo que me mandaste, ¿probás de nuevo?');
}

async function transcribeBuf(buf, mime, name) {
  const key = groqKey();
  if (!key) throw new UserFacingError('Todavía no puedo escuchar audios, ¿me lo escribís?');
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: mime.split(';')[0] }), name);
  fd.append('model', 'whisper-large-v3');
  fd.append('response_format', 'json');
  const res = await fetch((process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1') + '/audio/transcriptions', {
    method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: fd, signal: AbortSignal.timeout(90000),
  });
  if (!res.ok) throw new Error(`Transcripción falló (${res.status}): ${(await res.text()).slice(0, 200)}`);
  return String((await res.json()).text || '').trim();
}

const GROQ_EXT = new Set(['flac', 'mp3', 'mp4', 'mpeg', 'mpga', 'm4a', 'ogg', 'opus', 'wav', 'webm']);
async function transcribeFile(file, ext, forceConvert = false) {
  if (!forceConvert && GROQ_EXT.has(ext)) return transcribeBuf(fs.readFileSync(file), 'audio/' + ext, `audio.${ext}`);
  const mp3 = file.replace(/\.[^.]*$/, '') + '-audio.mp3';
  if (!F.toMp3(file, mp3)) return '';
  return transcribeBuf(fs.readFileSync(mp3), 'audio/mpeg', 'audio.mp3');
}
export const transcribe = transcribeBuf;

/** Guarda el archivo, detecta su tipo real por contenido y deja versiones legibles para Claude. */
async function analyze(evt) {
  const { buf, mime, fileName } = await download(evt);
  return analyzeBuffer(evt, buf, mime, fileName);
}

/** Guarda tal cual (sin analizar ni transcribir) un archivo que llegó a un grupo donde no lo mencionaron, para poder verlo si después lo mencionan. */
export async function stashMedia(evt, { transcribe = false } = {}) {
  try {
    const { buf, mime, fileName } = await download(evt);
    const dir = path.join(INBOX, safe(evt.jid), 'grupo');
    fs.mkdirSync(dir, { recursive: true });
    if (F.dirSize(WORK_DIR) + buf.length > F.WORK_QUOTA_BYTES || F.dirSize(path.join(INBOX, safe(evt.jid))) + buf.length > F.QUOTA_BYTES) return null;
    const file = path.join(dir, `${Date.now()}-${crypto.randomBytes(3).toString('hex')}.bin`);
    fs.writeFileSync(file, buf);
    let transcript = '';
    if (transcribe && evt.kind === 'audio') { try { transcript = await transcribeBuf(buf, 'audio/ogg', 'audio.ogg'); } catch (e) { console.error(`[media] no se pudo transcribir el audio del grupo: ${e.message}`); } } // para saber si lo nombran
    return { path: file, kind: evt.kind, mime, fileName, seconds: evt.seconds || 0, animated: !!evt.animated, ...(transcript ? { transcript } : {}) };
  } catch (e) { console.error(`[media] no se pudo guardar el archivo del grupo (${evt.kind}): ${e.message}`); return null; }
}

/** Convierte archivos guardados del grupo en texto para Claude: transcribe audios, extrae fotogramas de videos y deja imágenes/documentos legibles. */
export async function describeStashed(jid, items) {
  const out = [];
  for (const it of items) {
    const who = it.sender || 'alguien';
    try {
      if (!fs.existsSync(it.media.path)) { out.push(`[${who}] mandó ${it.media.kind === 'audio' ? 'una nota de voz' : 'un archivo'} que ya no está disponible.`); continue; }
      if (it.media.transcript) { out.push(`[${who}] mandó una nota de voz${it.media.seconds ? ` de ${it.media.seconds} s` : ''}. Transcripción automática: ${quote(it.media.transcript)}`); continue; }
      const a = await analyzeBuffer({ jid, kind: it.media.kind }, fs.readFileSync(it.media.path), it.media.mime, it.media.fileName || '');
      const cap = it.caption ? ` con el texto «${it.caption}»` : '';
      const open = a.readable.length ? ` Abrilo con Read: ${a.readable.join(', ')}` : '';
      if (a.type === 'audio') out.push(`[${who}] mandó una nota de voz${it.media.seconds ? ` de ${it.media.seconds} s` : ''}. Transcripción automática: ${quote(a.transcript || '(no se entendió)')}`);
      else if (a.type === 'video') out.push(`[${who}] mandó un video${cap}${a.duration ? ` de ${a.duration} s` : ''}.${a.transcript ? ` Se escucha: ${quote(a.transcript)}.` : ''}${open ? ` Fotogramas:${open.replace(' Abrilo con Read:', '')}` : ''}`);
      else if (it.media.kind === 'sticker') out.push(`[${who}] mandó un sticker.${open}`);
      else out.push(`[${who}] mandó ${a.type === 'image' ? 'una imagen' : `un archivo ${it.media.fileName ? `"${it.media.fileName}"` : `.${a.ext}`}`}${cap}.${open}`);
    } catch (e) { out.push(`[${who}] mandó un archivo que no pude procesar (${String(e.message).slice(0, 80)}).`); }
  }
  return out;
}

async function analyzeBuffer(evt, buf, mime, fileName) {
  const dir = path.join(INBOX, safe(evt.jid));
  fs.mkdirSync(dir, { recursive: true });
  if (F.dirSize(WORK_DIR) + buf.length > F.WORK_QUOTA_BYTES) throw new UserFacingError('Estoy con el almacenamiento temporal lleno ahora mismo. Probá de nuevo en un rato.');
  if (F.dirSize(dir) + buf.length > F.QUOTA_BYTES) throw new UserFacingError('Tengo llena la carpeta de archivos que me mandaste (se vacía sola cada 3 días). Probá de nuevo más tarde.');
  const prefix = path.join(dir, `${Date.now()}-${safe(path.basename(fileName || '', path.extname(fileName || ''))) || 'archivo'}`);
  const det = F.detect(buf, fileName);
  let { type, ext } = det;
  let original = `${prefix}.${ext}`;
  fs.writeFileSync(original, buf);
  const a = { type, ext, original, readable: [], transcript: '', notes: [], duration: 0, fileName };
  const report = (txt) => { const f = `${prefix}-info.txt`; fs.writeFileSync(f, txt); a.readable = [f]; };

  if (type === 'zip') {
    const z = F.zipKind(original);
    ext = z.ext;
    const renamed = `${prefix}.${ext}`;
    if (renamed !== original) { fs.renameSync(original, renamed); original = renamed; a.original = renamed; }
    if (z.kind === 'zip') { type = 'archive'; } else {
      type = 'office';
      const text = F.extractOffice(original, z.kind);
      if (text) { const f = `${prefix}.txt`; fs.writeFileSync(f, text.slice(0, 300000)); a.readable = [f]; if (text.length > 300000) a.notes.push('El texto es muy largo y se recortó.'); }
      else report(F.binaryReport(buf, { name: fileName, declaredMime: mime, detectedExt: ext }));
    }
    a.type = type; a.ext = ext;
  }

  switch (type) {
    case 'pdf': case 'text': a.readable = [original]; break;
    case 'image':
      if (evt.kind === 'sticker' && ext === 'webp') { const png = `${prefix}.png`; a.readable = [F.toPng(original, png) ? png : original]; } // sticker: primer cuadro como PNG (el animado no se lee directo)
      else if (['png', 'jpg', 'gif', 'webp'].includes(ext)) a.readable = [original];
      else { const png = `${prefix}.png`; if (F.toPng(original, png)) a.readable = [png]; else { a.type = 'binary'; report(F.binaryReport(buf, { name: fileName, declaredMime: mime, detectedExt: ext })); } }
      break;
    case 'audio':
      a.transcript = await transcribeFile(original, ext);
      break;
    case 'video': {
      const info = F.ffprobeInfo(original);
      a.duration = Math.round(info.duration);
      if (info.hasVideo) a.readable = F.frames(original, info.duration, prefix);
      if (info.hasAudio) { try { a.transcript = await transcribeFile(original, ext, true); } catch (e) { if (e instanceof UserFacingError) throw e; } }
      break;
    }
    case 'archive': {
      const list = F.listArchive(original, ext);
      report(`Archivo comprimido (${ext}), ${buf.length} bytes.\n\nContenido:\n${list || '(no se pudo listar; formato sin soporte)'}`);
      if (ext === 'zip') {
        const z = F.extractZip(original, `${prefix}-contenido`);
        a.readable.push(...z.files);
        if (z.note) a.notes.push(z.note);
      }
      break;
    }
    case 'binary': report(F.binaryReport(buf, { name: fileName, declaredMime: mime, detectedExt: ext })); break;
    default: break;
  }
  return a;
}

const quote = (t) => `«${String(t).replace(/\s+/g, ' ').trim()}»`;

/**
 * Devuelve { prompt, display }: `prompt` es lo que ve Claude, `display` lo que se guarda/muestra en el panel.
 * Devuelve null si el evento no merece respuesta (reacciones, etc.).
 */
export async function buildPrompt(evt) {
  const kind = evt.kind || 'text';
  const caption = (evt.text || '').trim();
  let body, display;

  switch (kind) {
    case 'text':
      body = display = caption;
      break;
    case 'audio': case 'image': case 'document': case 'video': case 'sticker': {
      const f = await analyze(evt);
      const name = f.fileName ? `"${f.fileName}"` : 'sin nombre';
      const cap = caption ? ` Texto que acompaña: ${quote(caption)}.` : '';
      const list = f.readable.map((p) => `  - ${p}`).join('\n');
      const open = f.readable.length ? `\nAbrí con la herramienta Read ${f.readable.length > 1 ? 'estos archivos' : 'este archivo'} antes de responder y contestá sobre su contenido:\n${list}` : '';
      const orig = f.readable.includes(f.original) ? '' : `\n(El original está en ${f.original}; usalo solo si hace falta.)`;
      const notes = f.notes.length ? `\nNota: ${f.notes.join(' ')}` : '';

      if (kind === 'sticker' && f.type === 'image') {
        body = `El usuario te mandó un STICKER${evt.animated ? ' animado (ves su primer cuadro)' : ''}: es una imagen que expresa una emoción o reacción, no un archivo. Abrila con Read para ver qué muestra y respondé con naturalidad a lo que expresa (humor, cariño, queja, saludo…), en tu estilo y brevemente, como lo haría una persona al recibir un sticker.${open}`;
        display = '🏷️ Sticker';
      } else if (f.type === 'audio') {
        if (!f.transcript) throw new UserFacingError('No logré entender el audio, ¿me lo escribís o lo grabás de nuevo?');
        const what = kind === 'audio' ? `una nota de voz${evt.seconds ? ` de ${evt.seconds} s` : ''}` : `un archivo de audio ${name}`;
        body = `El usuario te mandó ${what}.${cap} Esto es lo que dice (transcripción automática, puede tener errores): ${quote(f.transcript)}`;
        display = `🎤 ${f.transcript}`;
      } else if (f.type === 'video') {
        body = `El usuario te mandó un video ${name}${f.duration ? ` de ${f.duration} s` : ''}.${cap}` +
          (f.readable.length ? `\nPara que puedas "verlo" se extrajeron ${f.readable.length} fotogramas repartidos a lo largo del video (en orden).` : ' No se pudieron extraer imágenes.') +
          (f.transcript ? `\nLo que se escucha (transcripción automática): ${quote(f.transcript)}` : '\nNo se distingue ninguna voz.') + open + orig;
        display = `🎬 Video${f.fileName ? ` ${f.fileName}` : ''}${caption ? `\n${caption}` : ''}${f.transcript ? `\n🎤 ${f.transcript}` : ''}`;
      } else {
        const KIND = { image: 'una imagen', pdf: 'un PDF', text: `un archivo de texto (${f.ext})`, office: `un documento .${f.ext}`, archive: `un archivo comprimido (.${f.ext})`, binary: 'un archivo de formato desconocido' };
        const extra = f.type === 'binary' ? '\nEs un binario sin formato reconocido: el archivo informativo trae sus bytes iniciales y el texto legible que contiene. Explicale qué pudiste deducir y qué no.' : '';
        const long = f.type === 'pdf' ? '\nSi el PDF tiene muchas páginas, leelo por rangos (parámetro pages).' : '';
        body = `El usuario te mandó ${KIND[f.type] || 'un archivo'} ${name}.${cap}${open}${extra}${long}${notes}${orig}\nSi no se puede abrir, decíselo con naturalidad y proponé una alternativa.`;
        display = `${f.type === 'image' ? '🖼️ Imagen' : `📎 ${f.fileName || `Archivo .${f.ext}`}`}${caption ? `\n${caption}` : ''}`;
      }
      break;
    }
    case 'location': {
      const l = evt.location || {};
      body = `El usuario te compartió una ubicación${l.name ? ` ("${l.name}")` : ''}${l.address ? `, dirección: ${l.address}` : ''}. Coordenadas: ${l.lat}, ${l.lng}.`;
      display = `📍 ${l.name || 'Ubicación'} (${l.lat}, ${l.lng})`;
      break;
    }
    case 'contact': {
      const c = evt.contact || {};
      body = `El usuario te compartió un contacto: ${c.name || 'sin nombre'}${c.phones?.length ? `, teléfono(s): ${c.phones.join(', ')}` : ''}.`;
      display = `👤 Contacto: ${c.name || ''} ${c.phones?.join(' ') || ''}`.trim();
      break;
    }
    default:
      return null; // sticker, reacción, etc.
  }
  if (!body) return null;

  let prompt = body;
  if (evt.quoted) prompt = `(El usuario está respondiendo a este mensaje: ${quote(evt.quoted)})\n${prompt}`;
  if (evt.jid.endsWith('@g.us') && evt.name) prompt = `[${evt.name}]: ${prompt}`;
  return { prompt, display };
}
