// Cuentas de WhatsApp (varios números a la vez). Cada una es una instancia de Evolution API.
// Un chat se identifica con una "clave": el jid tal cual para la cuenta principal (compatible con todo lo anterior) y
// `instancia::jid` para las demás. Así conversaciones, memoria, tareas y sesiones quedan separadas por número sin duplicar tablas.
import { db } from './db.js';
import { PRIMARY_INSTANCE } from './evolution.js';

db.exec(`CREATE TABLE IF NOT EXISTS wa_accounts (
  instance TEXT PRIMARY KEY,
  label TEXT,
  persona_id INTEGER,
  rules TEXT,
  memory TEXT,
  office TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);

db.exec(`CREATE TABLE IF NOT EXISTS seen_contacts (
  key TEXT PRIMARY KEY, instance TEXT NOT NULL, number TEXT NOT NULL, name TEXT, last_seen TEXT NOT NULL DEFAULT (datetime('now'))
)`);
/** Anota a quien escribió a un número (aunque el agente lo ignore por las reglas): así se lo puede elegir después en las listas. */
export function noteSeen(instance, jid, name) {
  if (!/@s\.whatsapp\.net$/.test(jid)) return;
  db.prepare("INSERT INTO seen_contacts (key, instance, number, name, last_seen) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET last_seen = datetime('now'), name = COALESCE(excluded.name, seen_contacts.name)")
    .run(`${instance}::${jid}`, instance, jid.split('@')[0], name || null);
}
export const INSTANCE_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/i;
const SEP = '::';

export function ensurePrimary() {
  db.prepare('INSERT OR IGNORE INTO wa_accounts (instance, label) VALUES (?, ?)').run(PRIMARY_INSTANCE(), 'Principal');
}
ensurePrimary();

export const listAccounts = () => { ensurePrimary(); return db.prepare('SELECT * FROM wa_accounts ORDER BY created_at, instance').all().map((a) => ({ ...a, primary: a.instance === PRIMARY_INSTANCE() })); };
export const getAccount = (instance) => db.prepare('SELECT * FROM wa_accounts WHERE instance = ?').get(String(instance || ''));
/** Instancia de un evento: la que mandó Evolution, o la principal si no vino ninguna. Devuelve null si no está registrada (se ignora). */
export const accountOf = (instance) => getAccount(instance || PRIMARY_INSTANCE());

export const chatKey = (instance, jid) => (!instance || instance === PRIMARY_INSTANCE() || String(jid).startsWith('playground:') ? String(jid) : `${instance}${SEP}${jid}`);
export function splitKey(key) {
  const k = String(key), i = k.indexOf(SEP);
  if (i > 0 && INSTANCE_RE.test(k.slice(0, i))) return { instance: k.slice(0, i), jid: k.slice(i + SEP.length) };
  return { instance: PRIMARY_INSTANCE(), jid: k };
}

export function addAccount(instance, label) {
  if (!INSTANCE_RE.test(String(instance))) throw Object.assign(new Error('Nombre de instancia inválido (letras, números, - y _; hasta 40)'), { status: 400 });
  if (getAccount(instance)) throw Object.assign(new Error('Ya existe una cuenta con ese nombre'), { status: 409 });
  db.prepare('INSERT INTO wa_accounts (instance, label) VALUES (?, ?)').run(instance, String(label || instance).trim().slice(0, 40));
  return getAccount(instance);
}
export function removeAccount(instance) {
  if (instance === PRIMARY_INSTANCE()) throw Object.assign(new Error('La cuenta principal no se puede quitar'), { status: 400 });
  db.prepare('DELETE FROM wa_accounts WHERE instance = ?').run(instance);
}
export function updateAccount(instance, { label, personaId }) {
  const a = getAccount(instance);
  if (!a) throw Object.assign(new Error('Esa cuenta no existe'), { status: 404 });
  if (label !== undefined) db.prepare('UPDATE wa_accounts SET label = ? WHERE instance = ?').run(String(label).trim().slice(0, 40) || a.instance, instance);
  if (personaId !== undefined) db.prepare('UPDATE wa_accounts SET persona_id = ? WHERE instance = ?').run(personaId, instance);
  return getAccount(instance);
}
const json = (t) => { try { return t ? JSON.parse(t) : null; } catch { return null; } };
export const rulesOverride = (instance) => json(getAccount(instance)?.rules) || {};
export const setRulesOverride = (instance, o) => db.prepare('UPDATE wa_accounts SET rules = ? WHERE instance = ?').run(o && Object.keys(o).length ? JSON.stringify(o) : null, instance);
export const officeOf = (instance) => json(getAccount(instance)?.office);
export const setOffice = (instance, o) => db.prepare('UPDATE wa_accounts SET office = ? WHERE instance = ?').run(o ? JSON.stringify(o) : null, instance);
/** Etiqueta del número de un chat, o null si hay una sola cuenta (no hace falta mostrarla). */
export function labelFor(key) {
  const all = db.prepare('SELECT instance, label FROM wa_accounts').all();
  if (all.length < 2) return null;
  const i = splitKey(key).instance;
  return all.find((a) => a.instance === i)?.label || i;
}
