// Perfil de comunicación por chat: el agente estudia el historial (el que guarda Evolution API para ESE número de WhatsApp,
// o el del panel si Evolution no tiene) y escribe cómo es esa persona al hablar (carismática, seca, formal…) y cómo conviene tratarla.
// Se inyecta en las instrucciones del agente como dato. Todo es opcional y configurable.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, db } from './db.js';
import { safe } from './media.js';
import { askModel } from './agent.js';
import { splitKey } from './accounts.js';
import * as evo from './evolution.js';
import { personaForKey, appliesTo, cleanPersonaIds } from './personas.js';

const DIR = path.join(DATA_DIR, 'memory', 'profiles');
fs.mkdirSync(DIR, { recursive: true });
const file = (key) => path.join(DIR, `${safe(key)}.json`);
const SECRET = /(sk-ant-|sk-[a-z0-9]{20,}|xkeysib-|AIza[0-9A-Za-z_-]{20}|ghp_[0-9A-Za-z]{20}|cfut_|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY)/i;

export const DEFAULTS = {
  enabled: false,      // usar perfiles de comunicación
  auto: true,          // generarlos solos (la primera vez que el contacto escribe y cuando se vencen)
  minMessages: 6,      // mensajes mínimos de historial para generar solo
  maxMessages: 300,    // cuántos mensajes recientes lee (30–1000)
  refreshDays: 14,     // renovar automáticamente cada tantos días (0 = nunca)
  includeOwner: true,  // incluye lo que escribió el dueño desde ese número (para copiar cómo suele tratarlo)
  groups: false,       // también para grupos
  personas: null,      // null = todas las personalidades; o un arreglo de ids: solo los chats que usan esas personalidades
  model: 'sonnet',
};
export function readProfileSettings() {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'profiling'").get();
  try { return { ...DEFAULTS, ...(row ? JSON.parse(row.value) : {}) }; } catch { return { ...DEFAULTS }; }
}
export function writeProfileSettings(s) {
  const clean = {
    enabled: !!s.enabled, auto: s.auto !== false, includeOwner: s.includeOwner !== false, groups: !!s.groups,
    minMessages: Math.min(200, Math.max(1, Number(s.minMessages) || DEFAULTS.minMessages)),
    maxMessages: Math.min(1000, Math.max(30, Number(s.maxMessages) || DEFAULTS.maxMessages)),
    refreshDays: Math.min(365, Math.max(0, Number(s.refreshDays ?? DEFAULTS.refreshDays))),
    personas: cleanPersonaIds(s.personas),
    model: typeof s.model === 'string' && /^[\w.\[\]-]{1,60}$/.test(s.model) ? s.model : DEFAULTS.model,
  };
  db.prepare("INSERT INTO kv (key, value) VALUES ('profiling', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(clean));
  return clean;
}

export function readProfile(key) {
  try { return JSON.parse(fs.readFileSync(file(key), 'utf8')); } catch { return null; }
}
const save = (key, p) => { fs.writeFileSync(file(key), JSON.stringify(p, null, 2)); return p; };
export const deleteProfile = (key) => fs.rmSync(file(key), { force: true });
export function editProfile(key, text) {
  const t = String(text ?? '').slice(0, 6000);
  if (!t.trim()) { deleteProfile(key); return null; }
  const cur = readProfile(key) || {};
  return save(key, { ...cur, text: t, edited: true, updated_at: new Date().toISOString() });
}

/** Historial para estudiar: el de Evolution (de ese número) y, si no hay o es poco, el del panel. */
async function gatherHistory(key, s) {
  const { jid } = splitKey(key);
  let rows = [], source = 'evolution';
  try { rows = await evo.chatHistory(jid, s.maxMessages); } catch (e) { console.error(`[perfil ${key}] Evolution no entregó historial: ${e.message}`); }
  if (rows.length < s.minMessages) {
    const local = db.prepare("SELECT role, content, created_at FROM messages WHERE jid = ? AND role IN ('user','assistant') ORDER BY id DESC LIMIT ?").all(key, s.maxMessages).reverse();
    if (local.length > rows.length) { rows = local.map((m) => ({ fromMe: m.role === 'assistant', text: String(m.content), at: Date.parse(`${m.created_at.replace(' ', 'T')}Z`) / 1000, kind: 'text' })); source = 'panel'; }
  }
  if (!s.includeOwner) rows = rows.filter((r) => !r.fromMe);
  return { rows, source };
}

const running = new Set();
// resultado del último intento por chat (para mostrar en el panel por qué no hay perfil)
const status = () => { try { return JSON.parse(db.prepare("SELECT value FROM kv WHERE key = 'profile_status'").get()?.value || '{}'); } catch { return {}; } };
function note(key, error) {
  const st = status();
  if (error) st[key] = { at: new Date().toISOString(), error: String(error).slice(0, 240) }; else delete st[key];
  const keep = Object.fromEntries(Object.entries(st).sort((a, b) => String(b[1].at).localeCompare(String(a[1].at))).slice(0, 200));
  db.prepare("INSERT INTO kv (key, value) VALUES ('profile_status', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(keep));
}
export function profileOverview() {
  const st = status(), names = new Map(db.prepare('SELECT jid, name FROM contacts').all().map((c) => [c.jid, c.name]));
  const have = fs.readdirSync(DIR).filter((f) => f.endsWith('.json')).length;
  return { profiles: have, running: [...running], failed: Object.entries(st).map(([jid, v]) => ({ jid, name: names.get(jid) || null, ...v })).slice(0, 20) };
}
/** Estudia el historial del chat y guarda el perfil. Lanza si no hay historial suficiente. */
export async function generateProfile(key, { force = false } = {}) {
  const s = readProfileSettings();
  if (running.has(key)) throw Object.assign(new Error('Ya se está generando el perfil de este chat'), { status: 409 });
  running.add(key);
  try {
    const cur = readProfile(key);
    if (cur?.edited && !force) throw Object.assign(new Error('El perfil fue editado a mano: regeneralo manualmente si querés reemplazarlo'), { status: 409 });
    const { rows, source } = await gatherHistory(key, s);
    const theirs = rows.filter((r) => !r.fromMe).length;
    if (theirs < 4) throw Object.assign(new Error(`Hay muy poco historial de esta persona (${theirs} mensajes suyos) para estudiar cómo habla`), { status: 422 });
    if (!force && rows.length < s.minMessages) throw Object.assign(new Error(`Solo hay ${rows.length} mensajes de historial y el mínimo configurado para generarlo solo es ${s.minMessages}`), { status: 422 });
    const name = db.prepare('SELECT name FROM contacts WHERE jid = ?').get(key)?.name || 'la persona';
    const fmt = (r) => `${r.fromMe ? 'DUEÑO/AGENTE' : 'PERSONA'}: ${String(r.text).replace(/\s+/g, ' ').slice(0, 280)}`;
    let convo = rows.map(fmt).join('\n');
    if (convo.length > 60000) convo = convo.slice(-60000);
    const prompt = `Analizá esta conversación de WhatsApp entre ${name} ("PERSONA") y el dueño del número o su asistente ("DUEÑO/AGENTE"). Escribí un PERFIL DE COMUNICACIÓN de PERSONA para que un asistente se adapte a ella al responderle. Sé concreto, basate SOLO en lo que se ve en los mensajes (no inventes) y escribí en español, en markdown con estos apartados breves:
## Cómo se comunica (tono, largo de los mensajes, formalidad, uso de emojis y signos, jerga o regionalismos, ritmo de respuesta, si manda audios)
## Temperamento (¿carismática, cálida, seca, impaciente, bromista, directa…? con ejemplos cortos entre comillas)
## Intereses y contexto (de qué suele hablar, qué le importa, datos útiles y no sensibles)
## Cómo conviene tratarla (tono recomendado, qué evitar, cómo adaptar el largo y el estilo de las respuestas)
## Cómo le habló hasta ahora el dueño (solo si hay mensajes del dueño: su estilo con esta persona, para mantener la coherencia)
Reglas: máximo 2500 caracteres; nada de claves, contraseñas ni datos sensibles (salud, dinero personal, documentos); no repitas mensajes enteros; es una guía, no una sentencia: si hay poca evidencia de algo, decilo.

CONVERSACIÓN (del más viejo al más nuevo):
${convo}`;
    const out = await askModel(prompt, { model: s.model, timeoutMs: 180000 });
    const text = out.replace(/^```(?:markdown|md)?\s*|\s*```$/g, '').trim();
    if (text.length < 80) throw new Error('El modelo no devolvió un perfil utilizable');
    if (SECRET.test(text)) throw new Error('El perfil generado contenía algo parecido a una clave: se descartó');
    note(key, null);
    return save(key, { text: text.slice(0, 4000), generated_at: new Date().toISOString(), updated_at: new Date().toISOString(), source, messages: rows.length, edited: false });
  } finally { running.delete(key); }
}

const tried = new Map(); // key -> ms del último intento automático (evita reintentar en cada mensaje)
/** Si corresponde, genera o renueva el perfil en segundo plano. No bloquea ni lanza. */
export function maybeAutoProfile(key) {
  try {
    const s = readProfileSettings();
    if (!s.enabled || !s.auto || key.startsWith('playground:') || !appliesTo(s, personaForKey(key))) return;
    if (key.endsWith('@g.us') && !s.groups) return;
    if (Date.now() - (tried.get(key) || 0) < 3600e3) return;
    const p = readProfile(key);
    if (p?.edited) return;
    const stale = p && s.refreshDays > 0 && Date.now() - Date.parse(p.generated_at || 0) > s.refreshDays * 864e5;
    if (p && !stale) return;
    tried.set(key, Date.now());
    generateProfile(key).catch((e) => { note(key, e.message); if (e.status !== 422 && e.status !== 409) console.error(`[perfil ${key}] ${e.message}`); });
  } catch { /* nunca afecta al chat */ }
}

/** Bloque para las instrucciones del agente (vacío si está apagado o no hay perfil). */
export function profileBlock(key) {
  const s = readProfileSettings();
  if (!s.enabled || !appliesTo(s, personaForKey(key))) return '';
  const p = readProfile(key);
  if (!p?.text) return '';
  return `## Perfil de comunicación de esta persona (cómo habla y cómo conviene tratarla)\n${p.text.slice(0, 4000)}\nAdaptá tu tono, largo y estilo a esto con naturalidad, sin mencionarlo ni recitarlo; si lo que ves en la charla actual lo contradice, guiate por la charla.`;
}

let backfilling = false;
/** Al activar la función: genera ya (en segundo plano, de a uno) los perfiles de los chats recientes que todavía no tienen. */
export async function backfillProfiles({ limit = 15 } = {}) {
  const s = readProfileSettings();
  if (!s.enabled || backfilling) return { started: false };
  backfilling = true;
  const rows = db.prepare("SELECT * FROM contacts WHERE jid NOT LIKE 'playground:%' ORDER BY COALESCE(last_message_at, '') DESC LIMIT 80").all()
    .filter((c) => (s.groups || !c.jid.endsWith('@g.us')) && appliesTo(s, personaForKey(c.jid)) && !readProfile(c.jid)).slice(0, limit);
  (async () => {
    for (const c of rows) {
      try { await evo.withInstance(splitKey(c.jid).instance, () => generateProfile(c.jid, { force: false })); }
      catch (e) { note(c.jid, e.message); }
    }
  })().finally(() => { backfilling = false; });
  return { started: true, chats: rows.length };
}
