// Analiza cualquier archivo por su CONTENIDO (no por nombre ni tipo declarado) y lo deja en una forma que Claude pueda leer.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { maxBuffer: 200 * 1024 * 1024, timeout: 90000, ...opts });
export const hasBin = (cmd) => !run('which', [cmd]).status;

const TEXT_EXT = new Set(['txt', 'md', 'csv', 'tsv', 'log', 'json', 'xml', 'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'h', 'cpp', 'cs', 'go', 'rs', 'rb', 'php', 'sh', 'sql', 'yaml', 'yml', 'toml', 'ini', 'env', 'conf', 'vcf', 'ics', 'srt', 'svg', 'rtf', 'tex']);

/** Detecta el tipo real mirando los primeros bytes. Devuelve { type, ext, mime }. */
export function detect(buf, fileName = '') {
  const at = (s, o = 0) => buf.subarray(o, o + s.length).toString('latin1') === s;
  const ext0 = path.extname(fileName).slice(1).toLowerCase();
  const T = (type, ext, mime) => ({ type, ext, mime });

  if (at('%PDF')) return T('pdf', 'pdf', 'application/pdf');
  if (buf[0] === 0x89 && at('PNG', 1)) return T('image', 'png', 'image/png');
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return T('image', 'jpg', 'image/jpeg');
  if (at('GIF8')) return T('image', 'gif', 'image/gif');
  if (at('RIFF') && at('WEBP', 8)) return T('image', 'webp', 'image/webp');
  if (at('BM') && buf.length > 26 && buf.readUInt32LE(2) === buf.length) return T('image', 'bmp', 'image/bmp');
  if (at('II*\0') || at('MM\0*')) return T('image', 'tiff', 'image/tiff');
  if (at('RIFF') && at('WAVE', 8)) return T('audio', 'wav', 'audio/wav');
  if (at('RIFF') && at('AVI ', 8)) return T('video', 'avi', 'video/x-msvideo');
  if (at('OggS')) return T('audio', 'ogg', 'audio/ogg');
  if (at('fLaC')) return T('audio', 'flac', 'audio/flac');
  if (at('#!AMR')) return T('audio', 'amr', 'audio/amr');
  if (at('ID3') || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0)) return T('audio', 'mp3', 'audio/mpeg');
  if (at('ftyp', 4)) {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (/^(heic|heix|hevc|heim|mif1|msf1)/.test(brand)) return T('image', 'heic', 'image/heic');
    if (/^avif/.test(brand)) return T('image', 'avif', 'image/avif');
    if (/^(M4A |M4B |F4A )/.test(brand)) return T('audio', 'm4a', 'audio/mp4');
    if (/^qt/.test(brand)) return T('video', 'mov', 'video/quicktime');
    if (/^3g/.test(brand)) return T('video', '3gp', 'video/3gpp');
    return T('video', 'mp4', 'video/mp4');
  }
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return T('video', 'webm', 'video/webm');
  if (at('PK\x03\x04') || at('PK\x05\x06')) return T('zip', 'zip', 'application/zip'); // se afina con los nombres internos
  if (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0) return T('binary', ext0 || 'bin', 'application/x-ole-storage'); // doc/xls/ppt antiguos
  if (buf[0] === 0x1f && buf[1] === 0x8b) return T('archive', 'gz', 'application/gzip');
  if (at('7z\xbc\xaf')) return T('archive', '7z', 'application/x-7z-compressed');
  if (at('Rar!')) return T('archive', 'rar', 'application/vnd.rar');
  if (at('ustar', 257)) return T('archive', 'tar', 'application/x-tar');

  // ¿texto? sin bytes nulos y que decodifique como UTF-8 (o casi todo imprimible)
  const sample = buf.subarray(0, 8192);
  if (!sample.includes(0)) {
    let ok = true;
    try { new TextDecoder('utf-8', { fatal: true }).decode(sample, { stream: true }); }
    catch { ok = sample.filter((c) => c === 9 || c === 10 || c === 13 || (c >= 32 && c < 127) || c >= 160).length / Math.max(sample.length, 1) > 0.95; }
    if (ok) {
      const head = sample.toString('utf8').trimStart().slice(0, 200).toLowerCase();
      let ext = TEXT_EXT.has(ext0) ? ext0 : 'txt';
      if (!TEXT_EXT.has(ext0)) {
        if (head.startsWith('{') || head.startsWith('[')) { try { JSON.parse(buf.toString('utf8')); ext = 'json'; } catch {} }
        else if (/^<!doctype html|^<html/.test(head)) ext = 'html';
        else if (head.startsWith('<?xml')) ext = 'xml';
        else if (head.startsWith('begin:vcard')) ext = 'vcf';
        else if (head.startsWith('begin:vcalendar')) ext = 'ics';
        else if (head.startsWith('{\\rtf')) ext = 'rtf';
      }
      return T('text', ext, 'text/plain');
    }
  }
  return T('binary', ext0 || 'bin', 'application/octet-stream');
}

// ---------- Office / OpenDocument ----------
const unzipP = (file, entry) => { const r = run('unzip', ['-p', file, entry]); return r.status === 0 ? r.stdout.toString('utf8') : ''; };
const zipNames = (file) => { const r = run('unzip', ['-Z1', file]); return r.status === 0 ? r.stdout.toString('utf8').split('\n').filter(Boolean) : []; };
const decode = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
const strip = (xml) => decode(xml.replace(/<[^>]+>/g, ''));

/** Qué es un .zip: docx/xlsx/pptx/odt/ods/odp o un zip común. */
export function zipKind(file) {
  const n = zipNames(file);
  if (n.includes('word/document.xml')) return { kind: 'docx', ext: 'docx' };
  if (n.includes('xl/workbook.xml')) return { kind: 'xlsx', ext: 'xlsx' };
  if (n.includes('ppt/presentation.xml')) return { kind: 'pptx', ext: 'pptx' };
  if (n.includes('mimetype')) {
    const m = unzipP(file, 'mimetype').trim();
    if (m.endsWith('.text')) return { kind: 'odf', ext: 'odt' };
    if (m.endsWith('.spreadsheet')) return { kind: 'odf', ext: 'ods' };
    if (m.endsWith('.presentation')) return { kind: 'odf', ext: 'odp' };
  }
  return { kind: 'zip', ext: 'zip', names: n };
}

export function extractOffice(file, kind) {
  let out = '';
  if (kind === 'docx') {
    out = strip(unzipP(file, 'word/document.xml').replace(/<\/w:p>/g, '\n').replace(/<w:tab\/>/g, '\t').replace(/<w:br\/>/g, '\n'));
  } else if (kind === 'odf') {
    out = strip(unzipP(file, 'content.xml').replace(/<\/text:p>|<\/text:h>|<\/table:table-row>/g, '\n').replace(/<\/table:table-cell>/g, ' | '));
  } else if (kind === 'pptx') {
    const slides = zipNames(file).filter((n) => /^ppt\/slides\/slide\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    slides.forEach((n, i) => { out += `## Diapositiva ${i + 1}\n${strip(unzipP(file, n).replace(/<\/a:p>/g, '\n'))}\n`; });
  } else if (kind === 'xlsx') {
    const shared = [...unzipP(file, 'xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => strip(m[1]));
    const wb = unzipP(file, 'xl/workbook.xml');
    const names = [...wb.matchAll(/<sheet [^>]*name="([^"]*)"/g)].map((m) => decode(m[1]));
    const sheets = zipNames(file).filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n)).sort((a, b) => parseInt(a.match(/\d+/)[0]) - parseInt(b.match(/\d+/)[0]));
    sheets.forEach((n, i) => {
      out += `## Hoja: ${names[i] || i + 1}\n`;
      let rows = 0;
      for (const r of unzipP(file, n).matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
        if (++rows > 2000) { out += '… (más filas omitidas)\n'; break; }
        const cells = [...r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((c) => {
          const attrs = c[1], inner = c[2] || '';
          const ref = (attrs.match(/r="([^"]+)"/) || [])[1] || '';
          const t = (attrs.match(/t="([^"]+)"/) || [])[1];
          let v = (inner.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
          if (t === 's' && v != null) v = shared[+v];
          else if (t === 'inlineStr') v = strip(inner);
          else if (v != null) v = decode(v);
          return v == null || v === '' ? null : `${ref}=${v}`;
        }).filter(Boolean);
        if (cells.length) out += cells.join(' | ') + '\n';
      }
    });
  }
  return out.replace(/\n{3,}/g, '\n\n').trim();
}

// ---------- archivos comprimidos y binarios ----------
export function listArchive(file, ext) {
  let r;
  if (ext === 'zip') r = run('unzip', ['-l', file]);
  else if (ext === 'tar') r = run('tar', ['-tvf', file]);
  else if (ext === 'gz') r = run('tar', ['-tzvf', file]);
  else return '';
  return r?.status === 0 ? r.stdout.toString('utf8').replace(/^Archive:.*\n/m, '').slice(0, 20000) : '';
}

export function binaryReport(buf, { name, declaredMime, detectedExt }) {
  const hex = [...buf.subarray(0, 48)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
  const ascii = [...buf.toString('latin1').matchAll(/[\x20-\x7e]{6,}/g)].map((m) => m[0]);
  const utf16 = [...buf.toString('utf16le').matchAll(/[\x20-\x7e -ɏ]{6,}/g)].map((m) => m[0]);
  const strings = [...new Set([...ascii, ...utf16])].slice(0, 400).join('\n').slice(0, 20000);
  return [`Archivo binario sin formato reconocido.`, `Nombre: ${name || '(sin nombre)'}`, `Tamaño: ${buf.length} bytes`, `Tipo declarado: ${declaredMime || '(ninguno)'}`,
    `Extensión probable: ${detectedExt || '(ninguna)'}`, `Primeros bytes (hex): ${hex}`, '', 'Cadenas de texto legibles que contiene:', strings || '(ninguna)'].join('\n');
}

// ---------- ffmpeg ----------
export function ffprobeInfo(file) {
  const r = run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration:stream=codec_type', '-of', 'json', file]);
  try { const j = JSON.parse(r.stdout.toString()); return { duration: parseFloat(j.format?.duration) || 0, hasAudio: (j.streams || []).some((s) => s.codec_type === 'audio'), hasVideo: (j.streams || []).some((s) => s.codec_type === 'video') }; }
  catch { return { duration: 0, hasAudio: false, hasVideo: false }; }
}
export function toMp3(file, out) { return run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-vn', '-ac', '1', '-ar', '16000', '-b:a', '48k', out]).status === 0 && fs.existsSync(out); }
export function toPng(file, out) { return run('ffmpeg', ['-y', '-v', 'error', '-i', file, '-frames:v', '1', out]).status === 0 && fs.existsSync(out); }
export function frames(file, duration, outPrefix, n = 4) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const t = duration ? (duration * (i + 0.5)) / n : 0;
    const f = `${outPrefix}-f${i + 1}.jpg`;
    const r = run('ffmpeg', ['-y', '-v', 'error', '-ss', t.toFixed(2), '-i', file, '-frames:v', '1', '-vf', "scale='min(1024,iw)':-2", f]);
    if (r.status === 0 && fs.existsSync(f)) out.push(f);
  }
  return out;
}

/**
 * Extrae un zip de forma segura y devuelve las rutas de lo que Claude puede leer (texto, PDF, imágenes, Office → texto).
 * Límites contra zip-bombs; se descartan enlaces simbólicos (podrían apuntar fuera del inbox).
 */
export function extractZip(file, outDir, { maxFiles = 12, maxTotal = 50 * 1024 * 1024, maxEach = 5 * 1024 * 1024 } = {}) {
  const total = [...run('unzip', ['-l', file]).stdout.toString('utf8').matchAll(/^\s*(\d+)\s+\d+\s+files?\s*$/gm)].map((m) => +m[1])[0] ?? Infinity;
  if (total > maxTotal) return { files: [], note: 'El zip descomprimido es demasiado grande para abrirlo (más de 50 MB).' };
  fs.mkdirSync(outDir, { recursive: true });
  if (run('unzip', ['-o', '-q', file, '-d', outDir]).status > 1) return { files: [], note: 'No se pudo descomprimir el zip (¿tiene contraseña?).' };

  const found = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d)) {
      const f = path.join(d, e), st = fs.lstatSync(f);
      if (st.isSymbolicLink()) { fs.rmSync(f, { force: true }); continue; }
      if (st.isDirectory()) walk(f); else if (st.isFile()) found.push({ f, size: st.size });
    }
  };
  walk(outDir);

  const files = [];
  for (const { f, size } of found.sort((a, b) => a.f.localeCompare(b.f))) {
    if (files.length >= maxFiles) break;
    if (size > maxEach || size === 0) continue;
    const buf = fs.readFileSync(f);
    const d = detect(buf, f);
    if (d.type === 'text' || d.type === 'pdf' || (d.type === 'image' && ['png', 'jpg', 'gif', 'webp'].includes(d.ext))) files.push(f);
    else if (d.type === 'zip') {
      const z = zipKind(f);
      if (z.kind !== 'zip') { const text = extractOffice(f, z.kind); if (text) { fs.writeFileSync(`${f}.txt`, text.slice(0, 200000)); files.push(`${f}.txt`); } }
    }
  }
  const note = found.length > files.length ? `Se dejaron para leer ${files.length} de ${found.length} archivos (solo texto, PDF, imágenes y documentos Office).` : '';
  return { files, note };
}

// ---------- salida: describir un archivo para enviarlo por WhatsApp ----------
const MIME = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', odt: 'application/vnd.oasis.opendocument.text', ods: 'application/vnd.oasis.opendocument.spreadsheet',
  odp: 'application/vnd.oasis.opendocument.presentation', csv: 'text/csv', json: 'application/json', html: 'text/html', xml: 'application/xml', md: 'text/markdown', txt: 'text/plain',
  svg: 'image/svg+xml', vcf: 'text/vcard', ics: 'text/calendar', zip: 'application/zip', pdf: 'application/pdf', gz: 'application/gzip', '7z': 'application/x-7z-compressed', rar: 'application/vnd.rar',
};

/** Tipo real de un archivo en disco → { ext, mime, mediatype } (mediatype según Evolution: image | video | audio | document). */
export function describe(file, nameHint = '') {
  const fd = fs.openSync(file, 'r');
  const head = Buffer.alloc(16384);
  const n = fs.readSync(fd, head, 0, head.length, 0);
  fs.closeSync(fd);
  const d = detect(head.subarray(0, n), nameHint || file);
  let { ext, mime, type } = d;
  if (type === 'zip') { const z = zipKind(file); ext = z.ext; mime = MIME[ext] || mime; type = 'document'; }
  if (type === 'text') mime = MIME[ext] || mime;
  if (type === 'binary' || type === 'archive' || type === 'pdf') mime = MIME[ext] || mime;
  let mediatype = 'document';
  if (type === 'image' && ['jpg', 'png', 'webp', 'gif'].includes(ext)) mediatype = 'image';
  else if (type === 'video' && ['mp4', '3gp', 'mov'].includes(ext)) mediatype = 'video';
  else if (type === 'audio') mediatype = 'audio';
  return { ext, mime, mediatype };
}

/** Tamaño total (bytes) de una carpeta, recursivo. */
export function dirSize(dir) {
  let total = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    total += e.isDirectory() ? dirSize(f) : e.isFile() ? fs.statSync(f).size : 0;
  }
  return total;
}
// Topes internos (el disco del contenedor es un volumen fijo de 40 GB; esto evita llegar a llenarlo del todo)
export const QUOTA_BYTES = (Number(process.env.KIRI_CONTACT_QUOTA_MB) || 2048) * 1024 * 1024; // por contacto y por carpeta (recibidos / para enviar)
export const WORK_QUOTA_BYTES = (Number(process.env.KIRI_WORK_QUOTA_GB) || 30) * 1024 * 1024 * 1024; // total de descargas
