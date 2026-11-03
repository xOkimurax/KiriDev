// "Necesita atención": el agente pide ayuda humana (o falla algo importante); se pausa ese chat si está configurado y se avisa al dueño por WhatsApp.
import { db } from './db.js';
import { splitKey, chatKey } from './accounts.js';
import { deliver } from './deliver.js';
import { personaForKey, appliesTo, cleanPersonaIds } from './personas.js';

db.exec(`CREATE TABLE IF NOT EXISTS attention (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  jid TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'humano',
  reason TEXT NOT NULL,
  summary TEXT,
  urgency TEXT NOT NULL DEFAULT 'normal',
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  resolved_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_attention_status ON attention(status, id)');

export const DEFAULTS = {
  enabled: false,          // el agente puede pedir ayuda humana (herramienta request_human)
  pause: true,             // al pedir ayuda, el agente deja de responder en ese chat hasta que lo resuelvas
  owners: [],              // números (con código de país) a los que se avisa por WhatsApp
  notifyInstance: '',      // por qué número de WhatsApp se avisa ('' = el mismo por el que escribió la persona)
  notifyFailedTasks: false, // avisar también cuando una tarea delegada falla
  notifyCooldownMin: 30,   // no repetir el aviso del mismo chat antes de este tiempo
  personas: null,          // null = todas las personalidades; o un arreglo de ids: solo los chats que usan esas personalidades
};
export function readAttentionSettings() {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'attention'").get();
  try { return { ...DEFAULTS, ...(row ? JSON.parse(row.value) : {}) }; } catch { return { ...DEFAULTS }; }
}
export function writeAttentionSettings(s) {
  const clean = {
    enabled: !!s.enabled, pause: s.pause !== false, notifyFailedTasks: !!s.notifyFailedTasks,
    owners: [...new Set((Array.isArray(s.owners) ? s.owners : String(s.owners || '').split(/[\s,;]+/)).map((n) => String(n).replace(/\D/g, '')).filter((n) => n.length >= 6))].slice(0, 5),
    notifyInstance: /^[a-z0-9_-]{0,40}$/i.test(String(s.notifyInstance || '')) ? String(s.notifyInstance || '') : '',
    personas: cleanPersonaIds(s.personas),
    notifyCooldownMin: Math.min(1440, Math.max(1, Number(s.notifyCooldownMin) || 30)),
  };
  db.prepare("INSERT INTO kv (key, value) VALUES ('attention', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(clean));
  return clean;
}

const nameOf = (key) => db.prepare('SELECT name FROM contacts WHERE jid = ?').get(key)?.name || splitKey(key).jid.split('@')[0];

/** Avisa por WhatsApp a los dueños. Nunca lanza: un aviso fallido no debe romper nada. */
export async function alertOwners(key, text) {
  const s = readAttentionSettings();
  if (!s.owners.length) return 0;
  const inst = s.notifyInstance || splitKey(key).instance;
  let n = 0;
  for (const num of s.owners) {
    try { await deliver(chatKey(inst, `${num}@s.whatsapp.net`), text); n++; } catch (e) { console.error(`[atención] no pude avisar a ${num}: ${e.message}`); }
  }
  return n;
}

export const getItem = (id) => db.prepare('SELECT * FROM attention WHERE id = ?').get(id);
export const listItems = ({ status, limit = 100 } = {}) =>
  db.prepare(`SELECT a.*, c.name AS contact_name, c.paused FROM attention a LEFT JOIN contacts c ON c.jid = a.jid ${status ? 'WHERE a.status = ?' : ''} ORDER BY a.id DESC LIMIT ?`).all(...(status ? [status, limit] : [limit]));
export const openCount = () => db.prepare("SELECT COUNT(*) n FROM attention WHERE status = 'open'").get().n;

/** El agente (o el sistema) pide atención humana para este chat. */
export function requestHuman(key, { reason, summary, urgency, kind = 'humano' }) {
  const s = readAttentionSettings();
  if (kind === 'humano' && (!s.enabled || !appliesTo(s, personaForKey(key)))) throw Object.assign(new Error('El administrador no habilitó pedir ayuda humana.'), { status: 403 });
  const r = String(reason || '').trim().slice(0, 300) || 'Necesita atención';
  const sum = String(summary || '').trim().slice(0, 1500) || null;
  const urg = ['alta', 'normal', 'baja'].includes(urgency) ? urgency : 'normal';
  const open = db.prepare("SELECT * FROM attention WHERE jid = ? AND kind = ? AND status = 'open' ORDER BY id DESC LIMIT 1").get(key, kind);
  let id, fresh = true;
  if (open) {
    id = open.id;
    fresh = Date.now() - Date.parse(`${open.created_at.replace(' ', 'T')}Z`) > s.notifyCooldownMin * 60000;
    db.prepare('UPDATE attention SET reason = ?, summary = COALESCE(?, summary), urgency = ? WHERE id = ?').run(r, sum, urg, id);
  } else id = Number(db.prepare('INSERT INTO attention (jid, kind, reason, summary, urgency) VALUES (?, ?, ?, ?, ?)').run(key, kind, r, sum, urg).lastInsertRowid);
  if (kind === 'humano' && s.pause) db.prepare('UPDATE contacts SET paused = 1 WHERE jid = ?').run(key);
  db.prepare("INSERT INTO messages (jid, role, content) VALUES (?, 'system', ?)").run(key, `🙋 Necesita atención: ${r}`);
  if (fresh) {
    const icon = urg === 'alta' ? '🚨' : '🙋';
    alertOwners(key, `${icon} ${kind === 'tarea' ? 'Falló una tarea' : 'Necesita atención'}: ${nameOf(key)}\n${r}${sum ? `\n\n${sum}` : ''}\n\n${s.pause && kind === 'humano' ? 'El agente quedó en pausa en ese chat hasta que lo resuelvas en el panel (Tareas → Necesita atención).' : 'Mirá el panel: Tareas → Necesita atención.'}`).catch(() => {});
  }
  return { id, paused: kind === 'humano' && s.pause };
}

export function resolveItem(id, { resume = true } = {}) {
  const a = getItem(id);
  if (!a) throw Object.assign(new Error('Ese aviso no existe'), { status: 404 });
  db.prepare("UPDATE attention SET status = 'resolved', resolved_at = datetime('now') WHERE id = ?").run(id);
  if (resume && !db.prepare("SELECT 1 FROM attention WHERE jid = ? AND status = 'open' AND kind = 'humano'").get(a.jid)) db.prepare('UPDATE contacts SET paused = 0 WHERE jid = ?').run(a.jid);
  db.prepare("INSERT INTO messages (jid, role, content) VALUES (?, 'system', ?)").run(a.jid, `✅ Atención resuelta${resume ? ': el agente retoma la conversación' : ''}`);
  return getItem(id);
}
