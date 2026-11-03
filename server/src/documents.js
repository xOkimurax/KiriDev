// Documentos guardados en el panel: archivos que el agente crea o envía (o que sube el administrador), con dueño (igual que los paneles),
// almacenamiento propio con límites y vista previa dentro del panel (PDF, imágenes, Word, Excel, CSV, texto) sin descargar.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import JSZip from 'jszip';
import ExcelJS from 'exceljs';
import { DATA_DIR } from './db.js';
import { pdb } from './panels.js';
import { detect } from './files.js';

const DIR = path.join(DATA_DIR, 'docs');
fs.mkdirSync(DIR, { recursive: true });
pdb.exec(`CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY AUTOINCREMENT, owner TEXT, name TEXT NOT NULL, title TEXT, mime TEXT NOT NULL, view TEXT NOT NULL, size INTEGER NOT NULL,
  sha TEXT NOT NULL, file TEXT NOT NULL, created_by TEXT NOT NULL DEFAULT 'panel', created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
pdb.exec('CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner, id)');

export const DOC_LIMITS = { file: 25 * 1048576, perOwner: 300 * 1048576, count: 500 };
const fail = (status, message) => Object.assign(new Error(message), { status });
const inScope = (d, owner) => owner === undefined || (d.owner ?? null) === owner;
const safeName = (n) => String(n || 'archivo').replace(/[\\/\0]/g, '_').replace(/[^\p{L}\p{N}._ ()-]/gu, '_').trim().slice(0, 120) || 'archivo';
const ownerDir = (owner) => path.join(DIR, owner ? crypto.createHash('sha1').update(owner).digest('hex').slice(0, 16) : 'hub');

/** Cómo se muestra: pdf | image | text | md | table (csv/tsv/xlsx) | doc (docx) | none (solo descarga). Se decide por el CONTENIDO, no por el nombre. */
export function viewKind(buf, name) {
  const d = detect(buf, name), ext = path.extname(name).slice(1).toLowerCase();
  if (d.type === 'pdf') return { view: 'pdf', mime: 'application/pdf' };
  if (d.type === 'image' && ['png', 'jpg', 'gif', 'webp'].includes(d.ext)) return { view: 'image', mime: d.mime };
  if (d.type === 'zip' && ['docx', 'xlsx'].includes(ext)) return { view: ext === 'docx' ? 'doc' : 'table', mime: ext === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
  if (d.type === 'text') {
    if (ext === 'csv' || ext === 'tsv') return { view: 'table', mime: 'text/csv' };
    if (ext === 'md') return { view: 'md', mime: 'text/markdown' };
    if (['html', 'htm', 'svg', 'xml'].includes(ext) || d.ext === 'html' || d.ext === 'svg') return { view: 'text', mime: 'application/octet-stream' }; // se muestra como TEXTO, nunca se ejecuta
    return { view: 'text', mime: 'text/plain' };
  }
  return { view: 'none', mime: d.mime || 'application/octet-stream' };
}

const out = (d) => d && { id: d.id, owner: d.owner, name: d.name, title: d.title, mime: d.mime, view: d.view, size: d.size, created_by: d.created_by, created_at: d.created_at };
export const listDocuments = ({ owner } = {}) => pdb.prepare('SELECT * FROM documents ORDER BY id DESC').all().filter((d) => inScope(d, owner)).map(out);
export const getDocument = (id, { owner } = {}) => { const d = pdb.prepare('SELECT * FROM documents WHERE id = ?').get(Number(id)); return d && inScope(d, owner) ? d : null; };
const usage = (owner) => pdb.prepare('SELECT COUNT(*) n, COALESCE(SUM(size),0) b FROM documents WHERE owner IS ?').get(owner ?? null);

/** Guarda un archivo. Si ya está (mismo contenido y nombre) devuelve el existente. */
export function saveDocument({ owner = null, name, buffer, title = null, by = 'panel' }) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw fail(400, 'El archivo está vacío.');
  if (buffer.length > DOC_LIMITS.file) throw fail(413, `El archivo supera el máximo de ${DOC_LIMITS.file / 1048576} MB.`);
  const n = safeName(name), sha = crypto.createHash('sha256').update(buffer).digest('hex');
  const dup = pdb.prepare('SELECT * FROM documents WHERE owner IS ? AND sha = ? AND name = ?').get(owner, sha, n);
  if (dup) return { ...out(dup), duplicate: true };
  const u = usage(owner);
  if (u.n >= DOC_LIMITS.count) throw fail(409, `Se alcanzó el máximo de ${DOC_LIMITS.count} documentos.`);
  if (u.b + buffer.length > DOC_LIMITS.perOwner) throw fail(409, `No hay espacio: el máximo es ${DOC_LIMITS.perOwner / 1048576} MB por persona. Borrá documentos viejos.`);
  const v = viewKind(buffer, n);
  const dir = ownerDir(owner); fs.mkdirSync(dir, { recursive: true });
  const file = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}.bin`; // el nombre real vive en la base: nunca se usa en el disco
  fs.writeFileSync(path.join(dir, file), buffer);
  const id = Number(pdb.prepare('INSERT INTO documents (owner, name, title, mime, view, size, sha, file, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(owner, n, title ? String(title).slice(0, 120) : null, v.mime, v.view, buffer.length, sha, path.join(path.basename(dir), file), by).lastInsertRowid);
  return out(pdb.prepare('SELECT * FROM documents WHERE id = ?').get(id));
}
export function deleteDocument(id, ctx = {}) {
  const d = getDocument(id, ctx); if (!d) throw fail(404, 'Ese documento no existe.');
  fs.rmSync(path.join(DIR, d.file), { force: true });
  pdb.prepare('DELETE FROM documents WHERE id = ?').run(d.id);
}
export const readDocument = (d) => fs.readFileSync(path.join(DIR, d.file));

/** Guarda automáticamente los archivos que el agente le mandó a una persona (opción del administrador). Nunca lanza. */
export function autoSave(owner, attachments = []) {
  for (const a of attachments) {
    try { if (a.src && fs.existsSync(a.src)) saveDocument({ owner, name: a.fileName, buffer: fs.readFileSync(a.src), by: 'agente' }); }
    catch (e) { console.error(`[documentos] no se pudo guardar ${a.fileName}: ${e.message}`); }
  }
}

// ---------- vistas previas ----------
const dec = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');
function parseCsv(text, delim) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length && rows.length < 600; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += c; }
    else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
async function docxBlocks(buf) {
  const zip = await JSZip.loadAsync(buf), f = zip.file('word/document.xml');
  if (!f) throw fail(422, 'No pude leer este Word.');
  const xml = await f.async('string'), blocks = [];
  const runs = (p) => [...p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)].map((r) => ({ text: dec([...r[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>|<w:tab\/>/g)].map((t) => (t[1] === undefined ? '\t' : t[1])).join('')), b: /<w:b(?: [^>]*)?\/>|<w:b w:val="(?:1|true)"/.test(r[0]), i: /<w:i(?: [^>]*)?\/>/.test(r[0]) })).filter((r) => r.text);
  const para = (p) => {
    const st = /<w:pStyle w:val="([^"]+)"/.exec(p)?.[1] || '';
    const t = /^(Title|Heading ?1)$/i.test(st) ? 'h1' : /^Heading ?2$/i.test(st) ? 'h2' : /^Heading ?[3-9]$/i.test(st) ? 'h3' : /<w:numPr>/.test(p) || /^List/i.test(st) ? 'li' : 'p';
    return { t, runs: runs(p) };
  };
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => `\u0001${Buffer.from(tbl).toString('base64')}\u0001`);
  for (const part of body.split('\u0001')) {
    if (/^[A-Za-z0-9+/=]{20,}$/.test(part) && !part.includes('<')) {
      const tbl = Buffer.from(part, 'base64').toString();
      blocks.push({ t: 'table', rows: [...tbl.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].slice(0, 200).map((tr) => [...tr[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((tc) => dec([...tc[0].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((x) => x[1]).join(' ')))) });
    } else for (const p of part.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) { const b = para(p[0]); if (b.runs.length) blocks.push(b); }
    if (blocks.length > 3000) break;
  }
  return blocks;
}
async function xlsxSheets(buf) {
  const wb = new ExcelJS.Workbook(); await wb.xlsx.load(buf);
  return wb.worksheets.slice(0, 6).map((ws) => {
    const rows = [];
    ws.eachRow({ includeEmpty: false }, (row, i) => {
      if (i > 400) return;
      const vals = [];
      for (let c = 1; c <= Math.min(30, ws.columnCount); c++) {
        let v = row.getCell(c).value;
        if (v && typeof v === 'object') v = v.richText ? v.richText.map((x) => x.text).join('') : v.result !== undefined ? v.result : v.text ?? v.hyperlink ?? '';
        vals.push(v instanceof Date ? v.toISOString().slice(0, 10) : v === null || v === undefined ? '' : String(v));
      }
      rows.push(vals);
    });
    return { name: ws.name, rows };
  });
}
/** Contenido para mostrar dentro del panel (PDF e imágenes se piden como archivo). */
export async function preview(d) {
  const buf = readDocument(d);
  if (d.view === 'table') {
    if (/\.xlsx$/i.test(d.name)) return { kind: 'table', sheets: await xlsxSheets(buf) };
    const t = buf.toString('utf8').replace(/^﻿/, ''), first = t.split('\n')[0] || '';
    const delim = /\.tsv$/i.test(d.name) || (first.match(/\t/g) || []).length > (first.match(/[,;]/g) || []).length ? '\t' : (first.match(/;/g) || []).length > (first.match(/,/g) || []).length ? ';' : ',';
    return { kind: 'table', sheets: [{ name: d.name, rows: parseCsv(t, delim) }] };
  }
  if (d.view === 'doc') return { kind: 'doc', blocks: await docxBlocks(buf) };
  if (d.view === 'text' || d.view === 'md') return { kind: d.view, text: buf.toString('utf8').slice(0, 200000), truncated: buf.length > 200000 };
  throw fail(400, 'Este tipo de archivo se abre como archivo o se descarga.');
}
