// Estado de los motores (Claude Code / OpenCode) y cambio automático cuando uno llega a su límite de uso.
// Una pausa es GLOBAL por motor (el límite es de la cuenta, no de la conversación) y vence sola: al pasar la hora el motor principal vuelve.
import { db } from './db.js';

db.exec(`CREATE TABLE IF NOT EXISTS usage_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (datetime('now')), jid TEXT, kind TEXT NOT NULL, engine TEXT NOT NULL, model TEXT,
  tokens INTEGER, cost REAL, ms INTEGER, fallback INTEGER NOT NULL DEFAULT 0
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_usage_at ON usage_log(at)');
db.exec(`CREATE TABLE IF NOT EXISTS engine_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT NOT NULL DEFAULT (datetime('now')), kind TEXT NOT NULL, engine TEXT NOT NULL, detail TEXT
)`);
db.exec("DELETE FROM usage_log WHERE at < datetime('now', '-120 days')");
db.exec("DELETE FROM engine_events WHERE at < datetime('now', '-120 days')");

/** Un turno terminado (charla, tarea, recordatorio…): qué motor y modelo lo hicieron y cuánto consumieron. Nunca lanza. */
export function logUsage({ jid, kind, engine, model, tokens, cost, ms, fallback }) {
  try { db.prepare('INSERT INTO usage_log (jid, kind, engine, model, tokens, cost, ms, fallback) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(jid || null, kind, engine, model || null, tokens ?? null, cost ?? null, ms ?? null, fallback ? 1 : 0); } catch { /* el registro nunca frena al agente */ }
}
export function logEvent(kind, engine, detail) { try { db.prepare('INSERT INTO engine_events (kind, engine, detail) VALUES (?, ?, ?)').run(kind, engine, String(detail || '').slice(0, 300)); } catch { /* idem */ } }
/** Consumo por motor y modelo en los últimos `days` días + eventos recientes (pausas, cambios, reanudaciones). */
export function usageSummary(days = 30) {
  const d = `-${Math.min(120, Math.max(1, Number(days) || 30))} days`;
  const rows = db.prepare(`SELECT engine, model, SUM(kind = 'charla') chats, SUM(kind = 'tarea') tareas, COUNT(*) turnos, SUM(fallback) respaldo, COALESCE(SUM(tokens), 0) tokens, COALESCE(SUM(cost), 0) cost, CAST(AVG(ms) AS INTEGER) ms FROM usage_log WHERE at > datetime('now', ?) GROUP BY engine, model ORDER BY turnos DESC`).all(d);
  const perDay = db.prepare(`SELECT date(at) day, engine, COUNT(*) n FROM usage_log WHERE at > datetime('now', ?) GROUP BY day, engine ORDER BY day`).all(d);
  return { rows, perDay, events: db.prepare('SELECT at, kind, engine, detail FROM engine_events ORDER BY id DESC LIMIT 15').all() };
}

export const ENGINE_LABEL = { claude: 'Claude Code', opencode: 'OpenCode' };
export const otherEngine = (e) => (e === 'opencode' ? 'claude' : 'opencode');
export const DEFAULT_MODEL = { claude: 'sonnet', opencode: 'opencode/big-pickle' };
const KEY = 'engine_state', SETTINGS_KEY = 'engine_settings';
const readJson = (k, d) => { try { const v = db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value; return v ? JSON.parse(v) : d; } catch { return d; } };
const writeJson = (k, v) => db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, JSON.stringify(v));

// ---------- ajustes globales ----------
export const readEngineSettings = () => ({ notifySwitch: false, ...readJson(SETTINGS_KEY, {}) }); // notifySwitch: avisar al dueño por WhatsApp cuando se cambia de motor
export const writeEngineSettings = (s) => { const c = { notifySwitch: !!s.notifySwitch }; writeJson(SETTINGS_KEY, c); return c; };

// ---------- detectar un límite de uso ----------
const MIN = 120e3, MAX = 12 * 3600e3;
const OFFSET_RE = /GMT([+-]\d{1,2})(?::(\d{2}))?/;
/** Instante (ms) en que una hora local `h:mi` de la zona `tz` ocurre la próxima vez después de `from`. */
function nextLocal(h, mi, tz, from) {
  const fmt = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', timeZoneName: 'longOffset' });
  const at = (t) => { const p = Object.fromEntries(fmt.formatToParts(new Date(t)).map((x) => [x.type, x.value])); const m = OFFSET_RE.exec(p.timeZoneName || ''); const off = m ? (Number(m[1]) < 0 ? -1 : 1) * (Math.abs(Number(m[1])) * 60 + Number(m[2] || 0)) : 0; return { y: +p.year, mo: +p.month, d: +p.day, off }; };
  for (let add = 0; add < 3; add++) {
    const base = at(from + add * 864e5), t = Date.UTC(base.y, base.mo - 1, base.d, h, mi) - base.off * 60000;
    if (t > from) return t;
  }
  return from + 3600e3;
}
/** "resets 11pm (UTC)", "resets at 3:30 am (America/Asuncion)", "try again in 2 hours" → instante de reinicio (ms) o null. */
export function parseReset(text, now = Date.now()) {
  const t = String(text || '');
  let m = /resets?\s+(?:at\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:\(([^)]+)\))?/i.exec(t);
  if (m) {
    let h = Number(m[1]); const mi = Number(m[2] || 0), ap = (m[3] || '').toLowerCase();
    if (ap === 'pm' && h < 12) h += 12; if (ap === 'am' && h === 12) h = 0;
    if (h <= 23 && mi <= 59) { let tz = (m[4] || 'UTC').trim(); try { new Intl.DateTimeFormat('en', { timeZone: tz }); } catch { tz = 'UTC'; } return nextLocal(h, mi, tz, now); }
  }
  m = /(?:in|after|en)\s+(\d+(?:\.\d+)?)\s*(hours?|hrs?|h|minutes?|mins?|m|horas?|minutos?)\b/i.exec(t);
  if (m) return now + Number(m[1]) * (/^h/i.test(m[2]) ? 3600e3 : 60e3);
  m = /retry[- ]after[:= ]+(\d+)/i.exec(t);
  return m ? now + Number(m[1]) * 1000 : null;
}
/** ¿Este error es un límite de uso / cuota / sobrecarga (o un problema de acceso)? Devuelve { kind, until, reason } o null. */
export function classifyLimit(engine, message, now = Date.now()) {
  const m = String(message || '');
  const auth = /not logged in|please run \/login|invalid (api key|bearer|token|x-api-key)|authentication[_ ]error|unauthori[sz]ed|401\b|oauth token has expired|credit balance is too low/i;
  const limit = /session limit|usage limit|hit your (?:session |weekly |usage )?limit|limit reached|rate.?limit|too many requests|429\b|quota|exceeded your|insufficient[_ ]?(?:quota|credits|balance)|free ?usage|FreeUsageLimit|overloaded|529\b|capacity|try again (?:later|in)|resets?\s+\d/i;
  if (limit.test(m) && !/credit balance is too low/i.test(m)) {
    const until = parseReset(m, now) ?? now + (/overloaded|529|capacity/i.test(m) ? 5 : 20) * 60e3;
    return { kind: 'limit', until: Math.min(now + MAX, Math.max(now + MIN, until)), reason: m.replace(/\s+/g, ' ').slice(0, 200) };
  }
  if (auth.test(m)) return { kind: 'auth', until: now + 10 * 60e3, reason: m.replace(/\s+/g, ' ').slice(0, 200) };
  return null;
}

// ---------- pausas ----------
const state = () => readJson(KEY, {});
export function engineStates() {
  const s = state(), now = Date.now(), out = {};
  for (const e of Object.keys(ENGINE_LABEL)) out[e] = s[e] && s[e].until > now ? s[e] : null;
  return out;
}
export const isPaused = (engine) => !!engineStates()[engine];
export function markPaused(engine, info) { const s = state(); const was = s[engine]?.until > Date.now(); s[engine] = { ...info, since: Date.now() }; writeJson(KEY, s); if (!was) logEvent(info.kind === 'auth' ? 'acceso' : 'pausa', engine, info.reason); }
export function clearPause(engine) { const s = state(); if (s[engine]) { const was = s[engine].until > Date.now(); delete s[engine]; writeJson(KEY, s); if (was) logEvent('reanuda', engine, 'Disponible de nuevo'); } }

/** Plan de ejecución de una personalidad: motor principal y, si lo activó, el de respaldo (el otro motor). */
export function planFor(settings) {
  const primary = { engine: settings.engine === 'opencode' ? 'opencode' : 'claude', model: settings.model };
  const fb = otherEngine(primary.engine);
  return { primary, fallback: settings.fallbackEnabled ? { engine: fb, model: settings.fallbackModel || DEFAULT_MODEL[fb] } : null };
}
/** Con quién corre este turno: el principal, salvo que esté en pausa y el respaldo esté disponible. */
export function pickRun(plan) { return plan.fallback && isPaused(plan.primary.engine) && !isPaused(plan.fallback.engine) ? plan.fallback : plan.primary; }
export const untilText = (ms, tz = 'America/Asuncion') => new Intl.DateTimeFormat('es', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(ms));
