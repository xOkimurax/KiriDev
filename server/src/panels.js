// Paneles: secciones que el agente (o el usuario) arma en el panel web. Los DATOS (colecciones y filas) están separados de las VISTAS
// (widgets: tabla, calendario, tablero, nota, resumen). El agente describe un panel de forma declarativa y la interfaz lo dibuja:
// nunca escribe HTML ni código. Base propia (paneles.db) para no mezclarla con el resto y poder respaldarla/exportarla sola.
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import crypto from 'node:crypto';
import { Cron } from 'croner';
import { DATA_DIR, db as hub } from './db.js';
import { splitKey } from './accounts.js';
import { readSettings } from './persona.js';
import { cleanSpec, applySpec, hasSpec } from './filters.js';
import { listSchedules } from './schedules.js';

export const pdb = new DatabaseSync(path.join(DATA_DIR, 'paneles.db'));
pdb.exec(`
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS panels (
  id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, folder TEXT, instance TEXT, widgets TEXT NOT NULL DEFAULT '[]',
  created_by TEXT NOT NULL DEFAULT 'panel', created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS collections (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, fields TEXT NOT NULL DEFAULT '[]', instance TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS rows (
  id INTEGER PRIMARY KEY AUTOINCREMENT, collection_id INTEGER NOT NULL, data TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_rows_col ON rows(collection_id, id);
CREATE TABLE IF NOT EXISTS history (
  id INTEGER PRIMARY KEY AUTOINCREMENT, collection_id INTEGER NOT NULL, row_id INTEGER NOT NULL, action TEXT NOT NULL,
  before TEXT, after TEXT, by TEXT, at TEXT NOT NULL DEFAULT (datetime('now')), reverted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_history_col ON history(collection_id, id);
CREATE TABLE IF NOT EXISTS panel_links (
  owner TEXT PRIMARY KEY, token TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')), last_used TEXT, uses INTEGER NOT NULL DEFAULT 0
);
`);
// dueño de cada panel/colección: NULL = del hub (lo ve y edita el administrador); si no, la clave del chat al que pertenece
for (const t of ['ALTER TABLE panels ADD COLUMN owner TEXT', 'ALTER TABLE collections ADD COLUMN owner TEXT']) { try { pdb.exec(t); } catch { /* ya existe */ } }

const fail = (status, message) => Object.assign(new Error(message), { status });
/**
 * Alcance: `owner === undefined` = el administrador del hub ve todo; `null` = solo lo del hub; una clave de chat = solo lo de ese chat.
 * Es la barrera que impide que los datos de un contacto se mezclen con los de otro (el agente y los enlaces personales siempre van con su dueño).
 */
const inScope = (row, owner) => owner === undefined || (row.owner ?? null) === owner;
const LIMITS = { panels: 100, collections: 100, fields: 30, rowsPerCollection: 20000, batch: 200, widgets: 12 };
export const FIELD_TYPES = ['text', 'number', 'money', 'date', 'datetime', 'select', 'checkbox', 'url'];
export const WIDGET_TYPES = ['table', 'calendar', 'board', 'note', 'stat', 'documents'];

export { readPanelSettings, writePanelSettings, panelsOnFor, PANEL_DEFAULTS } from './panel-settings.js';

// ---------- valores ----------
const slug = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40) || 'campo';
export function parseNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v ?? '').trim().replace(/[^\d,.\-]/g, '');
  if (!s) return null;
  const lc = s.lastIndexOf(','), ld = s.lastIndexOf('.');
  if (lc > -1 && ld > -1) s = lc > ld ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  else if (lc > -1) s = /,\d{1,2}$/.test(s) ? s.replace(',', '.') : s.replace(/,/g, '');
  else if (ld > -1 && /\.\d{3}(\.|$)/.test(s) && !/\.\d{1,2}$/.test(s)) s = s.replace(/\./g, '');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
function parseDate(v) {
  const s = String(v ?? '').trim();
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) { const d = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})/.exec(s); if (d) m = [0, d[3], d[2].padStart(2, '0'), d[1].padStart(2, '0')]; }
  if (!m) return null;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return dt.getUTCMonth() === +m[2] - 1 && dt.getUTCDate() === +m[3] ? `${m[1]}-${m[2]}-${m[3]}` : null;
}
export function coerce(field, v) {
  if (v === undefined || v === null || v === '') return field.type === 'checkbox' ? false : null;
  switch (field.type) {
    case 'number': case 'money': return parseNum(v);
    case 'checkbox': return v === true || /^(si|sí|true|1|x|yes|listo|hecho)$/i.test(String(v).trim());
    case 'date': return parseDate(v);
    case 'datetime': {
      const d = parseDate(v), t = /(\d{1,2}):(\d{2})/.exec(String(v));
      return d ? `${d} ${t ? `${t[1].padStart(2, '0')}:${t[2]}` : '00:00'}` : null;
    }
    case 'url': return String(v).trim().slice(0, 500);
    default: return String(v).slice(0, 2000);
  }
}
export function cleanFields(fields) {
  if (!Array.isArray(fields) || !fields.length) throw fail(400, 'Indicá al menos un campo (columna).');
  if (fields.length > LIMITS.fields) throw fail(400, `Máximo ${LIMITS.fields} campos por colección.`);
  const seen = new Set();
  return fields.map((f) => {
    const label = String(f?.label ?? f?.name ?? f ?? '').trim().slice(0, 60);
    if (!label) throw fail(400, 'Cada campo necesita un nombre.');
    let key = String(f?.key || slug(label)), n = 2; const base = key;
    while (seen.has(key)) key = `${base}_${n++}`;
    seen.add(key);
    const type = FIELD_TYPES.includes(f?.type) ? f.type : 'text';
    const options = type === 'select' ? [...new Set((Array.isArray(f?.options) ? f.options : []).map((o) => String(o).trim().slice(0, 60)).filter(Boolean))].slice(0, 40) : undefined;
    return { key, label, type, ...(options ? { options } : {}) };
  });
}

// ---------- colecciones ----------
const colOut = (c) => c && { ...c, fields: JSON.parse(c.fields), rowCount: pdb.prepare('SELECT COUNT(*) n FROM rows WHERE collection_id = ?').get(c.id).n };
/** Colecciones visibles en ese alcance (ver `inScope`). */
export const listCollections = ({ owner } = {}) => pdb.prepare('SELECT * FROM collections ORDER BY name COLLATE NOCASE').all().filter((c) => inScope(c, owner)).map(colOut);
/** Una colección por id; con `owner` solo si le pertenece (si no, es como si no existiera). */
export const getCollection = (id, { owner } = {}) => { const c = pdb.prepare('SELECT * FROM collections WHERE id = ?').get(Number(id)); return c && inScope(c, owner) ? colOut(c) : null; };
/** Busca por id o por nombre (sin mayúsculas ni tildes), siempre dentro del alcance. */
export function findCollection(ref, { owner } = {}) {
  if (ref === undefined || ref === null || ref === '') return null;
  const byId = /^\d+$/.test(String(ref)) ? getCollection(ref, { owner }) : null;
  if (byId) return byId;
  const want = slug(ref);
  return listCollections({ owner }).find((c) => slug(c.name) === want) || null;
}
export function createCollection({ name, fields, rows, owner = null }) {
  const n = String(name || '').trim().slice(0, 60);
  if (!n) throw fail(400, 'La colección necesita un nombre.');
  if (listCollections({ owner }).length >= LIMITS.collections) throw fail(409, `Ya hay ${LIMITS.collections} colecciones.`);
  if (findCollection(n, { owner })) throw fail(409, `Ya existe una colección llamada «${n}»: usala o agregale filas.`);
  const f = cleanFields(fields);
  const id = Number(pdb.prepare('INSERT INTO collections (name, fields, owner) VALUES (?, ?, ?)').run(n, JSON.stringify(f), owner).lastInsertRowid);
  if (rows?.length) addRows(id, rows, 'sistema');
  return getCollection(id);
}
export function addField(id, field, ctx = {}) {
  const c = getCollection(id, ctx); if (!c) throw fail(404, 'Esa colección no existe.');
  const fields = cleanFields([...c.fields, field]);
  pdb.prepare("UPDATE collections SET fields = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(fields), c.id);
  return getCollection(c.id);
}
export function updateField(id, key, patch, ctx = {}) {
  const c = getCollection(id, ctx); if (!c) throw fail(404, 'Esa colección no existe.');
  if (!c.fields.some((f) => f.key === key)) throw fail(404, 'Ese campo no existe.');
  const fields = c.fields.map((f) => (f.key === key ? cleanFields([{ ...f, ...patch, key }])[0] : f));
  pdb.prepare("UPDATE collections SET fields = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(fields), c.id);
  return getCollection(c.id);
}
export function renameCollection(id, name, ctx = {}) {
  if (!getCollection(id, ctx)) throw fail(404, 'Esa colección no existe.');
  const n = String(name || '').trim().slice(0, 60); if (!n) throw fail(400, 'Poné un nombre.');
  pdb.prepare("UPDATE collections SET name = ?, updated_at = datetime('now') WHERE id = ?").run(n, Number(id));
  return getCollection(id);
}
export function deleteCollection(id, ctx = {}) {
  if (!getCollection(id, ctx)) throw fail(404, 'Esa colección no existe.');
  const used = listPanels().filter((p) => p.widgets.some((w) => String(w.collection) === String(id)));
  if (used.length) throw fail(409, `Esta colección la usan los paneles: ${used.map((p) => p.title).join(', ')}. Quitá esas secciones primero.`);
  pdb.prepare('DELETE FROM rows WHERE collection_id = ?').run(Number(id));
  pdb.prepare('DELETE FROM history WHERE collection_id = ?').run(Number(id));
  pdb.prepare('DELETE FROM collections WHERE id = ?').run(Number(id));
}

// ---------- filas (con historial para deshacer) ----------
const rowOut = (r) => ({ id: r.id, ...JSON.parse(r.data), _created: r.created_at, _updated: r.updated_at });
const logH = (cid, rid, action, before, after, by) => pdb.prepare('INSERT INTO history (collection_id, row_id, action, before, after, by) VALUES (?, ?, ?, ?, ?, ?)').run(cid, rid, action, before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null, by || null);
function shape(c, input) {
  const out = {};
  for (const f of c.fields) if (f.key in input || f.label in input) out[f.key] = coerce(f, f.key in input ? input[f.key] : input[f.label]);
  return out;
}
export function addRows(collectionId, rows, by = 'panel', ctx = {}) {
  const c = getCollection(collectionId, ctx); if (!c) throw fail(404, 'Esa colección no existe.');
  if (!Array.isArray(rows) || !rows.length) throw fail(400, 'No hay filas para agregar.');
  if (rows.length > LIMITS.batch) throw fail(400, `Máximo ${LIMITS.batch} filas por vez.`);
  if (c.rowCount + rows.length > LIMITS.rowsPerCollection) throw fail(409, `La colección llegó al máximo de ${LIMITS.rowsPerCollection} filas.`);
  const ids = [];
  pdb.exec('BEGIN');
  try {
    for (const r of rows) {
      const data = shape(c, r || {});
      const id = Number(pdb.prepare('INSERT INTO rows (collection_id, data) VALUES (?, ?)').run(c.id, JSON.stringify(data)).lastInsertRowid);
      logH(c.id, id, 'add', null, data, by); ids.push(id);
    }
    pdb.exec('COMMIT');
  } catch (e) { pdb.exec('ROLLBACK'); throw e; }
  return { added: ids.length, ids };
}
export function updateRow(collectionId, rowId, patch, by = 'panel', ctx = {}) {
  const c = getCollection(collectionId, ctx); if (!c) throw fail(404, 'Esa colección no existe.');
  const cur = pdb.prepare('SELECT * FROM rows WHERE id = ? AND collection_id = ?').get(Number(rowId), c.id);
  if (!cur) throw fail(404, 'Esa fila no existe.');
  const before = JSON.parse(cur.data), after = { ...before, ...shape(c, patch || {}) };
  pdb.prepare("UPDATE rows SET data = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(after), cur.id);
  logH(c.id, cur.id, 'update', before, after, by);
  return rowOut({ ...cur, data: JSON.stringify(after) });
}
export function deleteRow(collectionId, rowId, by = 'panel', ctx = {}) {
  if (!getCollection(collectionId, ctx)) throw fail(404, 'Esa colección no existe.');
  const cur = pdb.prepare('SELECT * FROM rows WHERE id = ? AND collection_id = ?').get(Number(rowId), Number(collectionId));
  if (!cur) throw fail(404, 'Esa fila no existe.');
  pdb.prepare('DELETE FROM rows WHERE id = ?').run(cur.id);
  logH(cur.collection_id, cur.id, 'delete', JSON.parse(cur.data), null, by);
}
/** Hoy en la zona horaria del sistema ('AAAA-MM-DD'): los filtros de fecha relativos (esta semana, próximos 7 días…) cuentan desde acá. */
export const todayStr = () => new Intl.DateTimeFormat('en-CA', { timeZone: readSettings().timezone || 'America/Asuncion' }).format(new Date());
/** Filas de una colección. `filter` = { match, conds[], sort } (ver filters.js): se valida contra los campos y se aplica sobre TODAS las filas (no solo las cargadas). */
export function listRows(collectionId, { q = '', filter = null, limit = 500, offset = 0 } = {}, ctx = {}) {
  const c = getCollection(collectionId, ctx); if (!c) throw fail(404, 'Esa colección no existe.');
  const spec = cleanSpec(filter, c.fields);
  const like = q ? `%${String(q).replace(/[%_]/g, '')}%` : null;
  const where = like ? 'collection_id = ? AND data LIKE ?' : 'collection_id = ?';
  const args = like ? [c.id, like] : [c.id];
  const lim = Math.min(2000, Math.max(1, Number(limit) || 500)), off = Math.max(0, Number(offset) || 0);
  if (!hasSpec(spec)) {
    const total = pdb.prepare(`SELECT COUNT(*) n FROM rows WHERE ${where}`).get(...args).n;
    return { collection: c, rows: pdb.prepare(`SELECT * FROM rows WHERE ${where} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...args, lim, off).map(rowOut), total, filtered: false };
  }
  const all = applySpec(pdb.prepare(`SELECT * FROM rows WHERE ${where} ORDER BY id DESC`).all(...args).map(rowOut), c.fields, spec, todayStr());
  return { collection: c, rows: all.slice(off, off + lim), total: all.length, filtered: true, matched: all.length, spec };
}
export const historyOf = (collectionId, limit = 30, ctx = {}) => (getCollection(collectionId, ctx) ? historyRaw(collectionId, limit) : []);
const historyRaw = (collectionId, limit) => pdb.prepare('SELECT * FROM history WHERE collection_id = ? ORDER BY id DESC LIMIT ?').all(Number(collectionId), limit)
  .map((h) => ({ ...h, before: h.before && JSON.parse(h.before), after: h.after && JSON.parse(h.after) }));
/** Deshace un cambio del historial (agregar → borra, editar → restaura, borrar → vuelve a crear). */
export function revert(historyId, ctx = {}) {
  const h = pdb.prepare('SELECT * FROM history WHERE id = ?').get(Number(historyId));
  if (!h || !getCollection(h.collection_id, ctx)) throw fail(404, 'Ese cambio no existe.');
  if (h.reverted) throw fail(409, 'Ese cambio ya se deshizo.');
  const before = h.before && JSON.parse(h.before);
  if (h.action === 'add') pdb.prepare('DELETE FROM rows WHERE id = ?').run(h.row_id);
  else if (h.action === 'update') pdb.prepare("UPDATE rows SET data = ?, updated_at = datetime('now') WHERE id = ?").run(h.before, h.row_id);
  else pdb.prepare('INSERT OR REPLACE INTO rows (id, collection_id, data) VALUES (?, ?, ?)').run(h.row_id, h.collection_id, h.before);
  pdb.prepare('UPDATE history SET reverted = 1 WHERE id = ?').run(h.id);
  return { ok: true, action: h.action, before };
}
export function exportCollection(id, format = 'csv', ctx = {}, filter = null) {
  const { collection: c, rows } = listRows(id, { limit: 2000, filter }, ctx);
  if (format === 'json') return { type: 'application/json', name: `${slug(c.name)}.json`, body: JSON.stringify({ name: c.name, fields: c.fields, rows: rows.map(({ _created, _updated, ...r }) => r) }, null, 2) };
  const esc = (v) => { const s = v === null || v === undefined ? '' : typeof v === 'boolean' ? (v ? 'sí' : 'no') : String(v); return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const body = `﻿${[c.fields.map((f) => esc(f.label)).join(';'), ...rows.slice().reverse().map((r) => c.fields.map((f) => esc(r[f.key])).join(';'))].join('\r\n')}\r\n`;
  return { type: 'text/csv; charset=utf-8', name: `${slug(c.name)}.csv`, body };
}

// ---------- recordatorios (colección del sistema: salen de las tareas programadas) ----------
/** Eventos de recordatorios entre dos instantes (ms). Los repetidos se muestran una vez por día. */
export function reminderEvents(from, to, { owner } = {}) {
  const out = [];
  for (const s of listSchedules().filter((x) => x.status === 'active')) {
    if (typeof owner === 'string' && s.jid !== owner) continue; // un panel de un contacto solo muestra SUS recordatorios
    const who = hub.prepare('SELECT name FROM contacts WHERE jid = ?').get(s.jid)?.name || splitKey(s.jid).jid.split('@')[0];
    if (s.kind === 'once' || !s.cron) { if (s.next_run && s.next_run >= from && s.next_run <= to) out.push({ id: `s${s.id}`, title: s.title, at: s.next_run, recurring: false, contact: who }); continue; }
    try {
      const days = new Set();
      for (const d of new Cron(s.cron, { timezone: s.tz }).nextRuns(400, new Date(from))) {
        if (d.getTime() > to) break;
        const k = d.toLocaleDateString('en-CA', { timeZone: s.tz });
        if (!days.has(k)) { days.add(k); out.push({ id: `s${s.id}-${k}`, title: s.title, at: d.getTime(), recurring: true, contact: who }); }
      }
    } catch { /* cron inválido: se omite */ }
  }
  return out.sort((a, b) => a.at - b.at);
}

// ---------- paneles y widgets ----------
const wid = () => crypto.randomBytes(3).toString('hex');
export function cleanWidgets(widgets, { owner } = {}) {
  if (!Array.isArray(widgets)) throw fail(400, 'Las secciones del panel deben ser una lista.');
  if (widgets.length > LIMITS.widgets) throw fail(400, `Máximo ${LIMITS.widgets} secciones por panel.`);
  return widgets.map((w, i) => {
    const type = w?.type;
    if (!WIDGET_TYPES.includes(type)) throw fail(400, `Sección ${i + 1}: tipo «${type}» no válido (usá ${WIDGET_TYPES.join(', ')}).`);
    const base = { id: String(w.id || wid()).slice(0, 12), type, title: String(w.title || '').trim().slice(0, 80) };
    if (type === 'documents') return { ...base, config: {} };
    if (type === 'note') return { ...base, config: { text: String(w.config?.text ?? w.text ?? '').slice(0, 20000) } };
    const reminders = type === 'calendar' && (w.collection === 'reminders' || w.collection === 'recordatorios');
    if (reminders) return { ...base, collection: 'reminders', config: {} };
    const c = findCollection(w.collection, { owner });
    if (!c) throw fail(400, `Sección «${base.title || type}»: la colección «${w.collection}» no existe. Creala primero con collection_create.`);
    const cfg = w.config || {}, has = (k, types) => c.fields.find((f) => f.key === k && (!types || types.includes(f.type)));
    const pick = (k, types) => { const v = cfg[k]; if (!v) return undefined; const f = has(v, types) || c.fields.find((x) => slug(x.label) === slug(v) && (!types || types.includes(x.type))); if (!f) throw fail(400, `Sección «${base.title || type}»: el campo «${v}» no existe${types ? ` o no es de tipo ${types.join('/')}` : ''} en «${c.name}».`); return f.key; };
    const config = {};
    if (type === 'table') config.columns = (Array.isArray(cfg.columns) ? cfg.columns : []).map((k) => pick2(c, k)).filter(Boolean);
    if (cfg.filter) { const f = cleanSpec(cfg.filter, c.fields); if (f) config.filter = f; } // filtro/orden por defecto de la sección (la persona puede cambiarlo)
    if (type === 'calendar') { config.dateField = pick('dateField', ['date', 'datetime']) || c.fields.find((f) => ['date', 'datetime'].includes(f.type))?.key; config.titleField = pick('titleField') || c.fields.find((f) => f.type === 'text')?.key || c.fields[0].key; if (!config.dateField) throw fail(400, `«${c.name}» no tiene un campo de fecha: agregalo con collection_add_field.`); }
    if (type === 'board') { config.groupField = pick('groupField', ['select']) || c.fields.find((f) => f.type === 'select')?.key; config.titleField = pick('titleField') || c.fields.find((f) => f.type === 'text')?.key || c.fields[0].key; if (!config.groupField) throw fail(400, `«${c.name}» no tiene un campo de tipo selección para agrupar el tablero.`); }
    if (type === 'stat') { config.fn = ['count', 'sum', 'avg'].includes(cfg.fn) ? cfg.fn : 'count'; if (config.fn !== 'count') { config.field = pick('field', ['number', 'money']); if (!config.field) throw fail(400, 'Para sumar o promediar indicá un campo numérico (field).'); } }
    return { ...base, collection: c.id, config };
  });
}
function pick2(c, k) { return c.fields.find((f) => f.key === k)?.key || c.fields.find((f) => slug(f.label) === slug(k))?.key; }
const panelOut = (p) => p && { ...p, widgets: JSON.parse(p.widgets) };
export const listPanels = ({ owner } = {}) => pdb.prepare('SELECT * FROM panels ORDER BY COALESCE(folder, \'\') COLLATE NOCASE, title COLLATE NOCASE').all().filter((p) => inScope(p, owner)).map(panelOut);
export const getPanel = (id, { owner } = {}) => { const p = pdb.prepare('SELECT * FROM panels WHERE id = ?').get(Number(id)); return p && inScope(p, owner) ? panelOut(p) : null; };
export function findPanel(ref, { owner } = {}) {
  if (/^\d+$/.test(String(ref))) return getPanel(ref, { owner });
  const want = slug(ref); return listPanels({ owner }).find((p) => slug(p.title) === want) || null;
}
/** `owner`: null = del hub; clave de chat = de ese contacto. */
export function createPanel({ title, folder, widgets = [], owner = null }, by = 'panel') {
  const t = String(title || '').trim().slice(0, 80); if (!t) throw fail(400, 'El panel necesita un título.');
  if (listPanels({ owner }).length >= LIMITS.panels) throw fail(409, `Ya hay ${LIMITS.panels} paneles.`);
  if (findPanel(t, { owner })) throw fail(409, `Ya existe un panel llamado «${t}»: modificalo en vez de crear otro.`);
  const w = cleanWidgets(widgets, { owner });
  const id = Number(pdb.prepare('INSERT INTO panels (title, folder, owner, widgets, created_by) VALUES (?, ?, ?, ?, ?)').run(t, folder ? String(folder).trim().slice(0, 40) : null, owner, JSON.stringify(w), by).lastInsertRowid);
  return getPanel(id);
}
export function updatePanel(id, { title, folder, widgets }, ctx = {}) {
  const p = getPanel(id, ctx); if (!p) throw fail(404, 'Ese panel no existe.');
  const w = widgets === undefined ? p.widgets : cleanWidgets(widgets, { owner: p.owner ?? null }); // las secciones solo pueden usar datos del MISMO dueño que el panel
  pdb.prepare("UPDATE panels SET title = ?, folder = ?, widgets = ?, updated_at = datetime('now') WHERE id = ?")
    .run(title === undefined ? p.title : String(title).trim().slice(0, 80) || p.title, folder === undefined ? p.folder : folder ? String(folder).trim().slice(0, 40) : null, JSON.stringify(w), p.id);
  return getPanel(p.id);
}
export const deletePanel = (id, ctx = {}) => { if (!getPanel(id, ctx)) throw fail(404, 'Ese panel no existe.'); pdb.prepare('DELETE FROM panels WHERE id = ?').run(Number(id)); };

// ---------- enlaces personales (sin contraseña: el secreto ES el enlace) ----------
const newToken = () => crypto.randomBytes(32).toString('base64url'); // 256 bits: no se puede adivinar
/** El enlace de un chat: se crea la primera vez y se reutiliza (así el que ya lo guardó no lo pierde). */
export function ensureLink(owner) {
  const cur = pdb.prepare('SELECT * FROM panel_links WHERE owner = ?').get(owner);
  if (cur) return cur;
  pdb.prepare('INSERT INTO panel_links (owner, token) VALUES (?, ?)').run(owner, newToken());
  return pdb.prepare('SELECT * FROM panel_links WHERE owner = ?').get(owner);
}
export const rotateLink = (owner) => { pdb.prepare('DELETE FROM panel_links WHERE owner = ?').run(owner); return ensureLink(owner); }; // el enlace anterior deja de funcionar
export const revokeLink = (owner) => { pdb.prepare('DELETE FROM panel_links WHERE owner = ?').run(owner); };
export const listLinks = () => pdb.prepare('SELECT * FROM panel_links ORDER BY COALESCE(last_used, created_at) DESC').all();
/** Resuelve un token a la clave del chat dueño (o null). Registra el uso. */
export function ownerOfToken(token) {
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const r = pdb.prepare('SELECT owner FROM panel_links WHERE token = ?').get(token);
  if (!r) return null;
  pdb.prepare("UPDATE panel_links SET last_used = datetime('now'), uses = uses + 1 WHERE owner = ?").run(r.owner);
  return r.owner;
}

// ---------- plantillas ----------
export const TEMPLATES = [
  { id: 'agenda', label: 'Agenda de recordatorios', desc: 'Calendario con todos los recordatorios y tareas programadas.' },
  { id: 'precios', label: 'Lista de precios', desc: 'Tabla de productos con precio, categoría y disponibilidad.' },
  { id: 'clientes', label: 'Clientes', desc: 'Tabla y tablero de clientes por estado.' },
  { id: 'pedidos', label: 'Pedidos', desc: 'Tabla, tablero por estado, calendario de entregas y total.' },
  { id: 'notas', label: 'Notas', desc: 'Una hoja de texto libre.' },
  { id: 'documentos', label: 'Documentos', desc: 'Los archivos que el agente te prepara, para verlos sin descargar.' },
  { id: 'vacio', label: 'En blanco', desc: 'Un panel vacío para ir agregando secciones.' },
];
export function createFromTemplate(tpl, { title, owner = null } = {}) {
  const mk = (name, fields) => findCollection(name, { owner }) || createCollection({ name, fields, owner });
  const base = (TEMPLATES.find((t) => t.id === tpl) || TEMPLATES[5]).label;
  const t = title || base;
  if (tpl === 'agenda') return createPanel({ title: t, owner, widgets: [{ type: 'calendar', title: 'Recordatorios', collection: 'reminders' }] }, 'plantilla');
  if (tpl === 'documentos') return createPanel({ title: t, owner, widgets: [{ type: 'documents', title: 'Documentos' }] }, 'plantilla');
  if (tpl === 'notas') return createPanel({ title: t, owner, widgets: [{ type: 'note', title: 'Notas', config: { text: '' } }] }, 'plantilla');
  if (tpl === 'precios') { const c = mk('Lista de precios', [{ label: 'Producto' }, { label: 'Precio', type: 'money' }, { label: 'Categoría', type: 'select', options: [] }, { label: 'Disponible', type: 'checkbox' }]); return createPanel({ title: t, owner, widgets: [{ type: 'table', title: 'Productos', collection: c.id }] }, 'plantilla'); }
  if (tpl === 'clientes') { const c = mk('Clientes', [{ label: 'Nombre' }, { label: 'Teléfono' }, { label: 'Email' }, { label: 'Estado', type: 'select', options: ['Nuevo', 'En seguimiento', 'Cliente', 'Perdido'] }, { label: 'Notas' }]); return createPanel({ title: t, owner, widgets: [{ type: 'board', title: 'Por estado', collection: c.id, config: { groupField: 'estado', titleField: 'nombre' } }, { type: 'table', title: 'Todos', collection: c.id }] }, 'plantilla'); }
  if (tpl === 'pedidos') { const c = mk('Pedidos', [{ label: 'Cliente' }, { label: 'Producto' }, { label: 'Monto', type: 'money' }, { label: 'Estado', type: 'select', options: ['Pendiente', 'En curso', 'Entregado'] }, { label: 'Entrega', type: 'date' }]); return createPanel({ title: t, owner, widgets: [{ type: 'stat', title: 'Total en pedidos', collection: c.id, config: { fn: 'sum', field: 'monto' } }, { type: 'board', title: 'Por estado', collection: c.id, config: { groupField: 'estado', titleField: 'cliente' } }, { type: 'calendar', title: 'Entregas', collection: c.id, config: { dateField: 'entrega', titleField: 'cliente' } }, { type: 'table', title: 'Todos los pedidos', collection: c.id }] }, 'plantilla'); }
  return createPanel({ title: t, owner, widgets: [] }, 'plantilla');
}

// ---------- resumen para el agente ----------
export function overview({ owner } = {}) {
  return {
    panels: listPanels({ owner }).map((p) => ({ id: p.id, title: p.title, folder: p.folder, sections: p.widgets.map((w) => `${w.type}${w.title ? `: ${w.title}` : ''}`) })),
    collections: listCollections({ owner }).map((c) => ({ id: c.id, name: c.name, rows: c.rowCount, fields: c.fields.map((f) => `${f.key} (${f.type}${f.options?.length ? `: ${f.options.join('/')}` : ''})`) })),
  };
}
