// Reglas de a quién responde el agente. Se guardan en SQLite (tabla kv).
import { db } from './db.js';
import { botIdentity, groupParticipants } from './evolution.js';
import { rulesOverride, setRulesOverride } from './accounts.js';

db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

export const DEFAULT_RULES = {
  privateChats: true,   // chats individuales
  groups: false,        // grupos
  groupMode: 'all',     // 'all' = responde a todo | 'mention' = solo cuando lo mencionan | 'context' = mención O continuación de una charla en curso con él (siempre lee el grupo)
  groupContextMinutes: 10, // modo contexto: cuánto tiempo después de su última intervención sigue atento a la charla
  groupReplyToBot: true,   // contesta también si le responden (citan) un mensaje suyo
  groupUseName: true,      // contesta si dicen su nombre (el del perfil de WhatsApp) en el mensaje
  groupKeywords: [],       // otras palabras que lo invocan (ej. "kiri", "asistente")
  groupHistory: 30,        // cuántos mensajes del grupo ve al ser mencionado (desde su última intervención)
  groupFilter: { any: true, text: true, audio: true, image: true, video: true, document: true, sticker: true, emojiReply: true }, // a qué TIPO de mensaje responde cuando lo mencionan (any = cualquier mención, de cualquier tipo)
  groupFilterOverrides: {}, // { 'jid@g.us': { ...parcial de groupFilter } } personalización por grupo
  groupOverrides: {},      // { 'jid@g.us': 'default' | 'all' | 'mention' | 'off' }
  groupMemberMode: 'everyone', // quién puede activarlo en grupos: 'everyone' = cualquier miembro | 'allowlist' = solo los miembros de la lista (los demás se leen pero no se les contesta)
  groupMembers: [],        // números de los miembros permitidos (lista general)
  groupMemberOverrides: {}, // { 'jid@g.us': { mode: 'everyone' | 'own', list: [números], withGeneral: bool } } personalización por grupo (sin entrada = como el general)
  privateFilterOn: false,  // filtrar por TIPO de mensaje en chats individuales (si no, responde a todos los tipos)
  privateFilter: { text: true, audio: true, image: true, video: true, document: true, sticker: true, emojiReply: true },
  newFilterOn: false,      // filtro propio para contactos nuevos (reemplaza al de chats individuales mientras no los conozca)
  newFilter: { text: true, audio: true, image: true, video: true, document: true, sticker: true, emojiReply: true },
  replyDelay: { enabled: false, min: 5, max: 5, unit: 's' }, // demora antes de responder: entre min y max (al azar si difieren), en segundos ('s') o minutos ('min')
  newContacts: true,    // personas que escriben por primera vez
  mode: 'everyone',     // 'everyone' | 'allowlist' (solo números de la lista)
  allowlist: [],
  blocklist: [],
};

const digits = (v) => String(v).replace(/\D/g, '');
const list = (a) => [...new Set((Array.isArray(a) ? a : String(a || '').split(/[\s,;]+/)).map(digits).filter((n) => n.length >= 6))];

const FILTER_KEYS = ['any', 'text', 'audio', 'image', 'video', 'document', 'sticker', 'emojiReply'];
/** Limpia el filtro de tipos; con partial=true conserva solo las claves presentes (sirve para las personalizaciones por grupo). */
function cleanFilter(t, partial = false) {
  const src = t && typeof t === 'object' ? t : {};
  return Object.fromEntries(FILTER_KEYS.filter((k) => !partial || k in src).map((k) => [k, k in src ? !!src[k] : DEFAULT_RULES.groupFilter[k]]));
}
const TYPE_KEYS = FILTER_KEYS.filter((k) => k !== 'any');
const cleanTypes = (t) => { const src = t && typeof t === 'object' ? t : {}; return Object.fromEntries(TYPE_KEYS.map((k) => [k, k in src ? !!src[k] : true])); };
/** Reglas generales (las que valen para todos los números). */
export function readGeneralRules() {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'rules'").get();
  try { return { ...DEFAULT_RULES, ...(row ? JSON.parse(row.value) : {}) }; } catch { return { ...DEFAULT_RULES }; }
}
/** Reglas efectivas: las generales con lo propio de ese número (si se indica) encima. */
export function readRules(instance) {
  const g = readGeneralRules();
  return instance ? { ...g, ...rulesOverride(instance) } : g;
}
export const accountOverrideKeys = (instance) => Object.keys(rulesOverride(instance));

/** Guarda reglas. Con `instance`, solo se guardan las diferencias contra las generales (lo demás se hereda). */
export function writeRules(r, instance) {
  const clean = cleanRules(r);
  if (instance) {
    const g = readGeneralRules();
    const diff = Object.fromEntries(Object.entries(clean).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(g[k])));
    setRulesOverride(instance, diff);
    return readRules(instance);
  }
  db.prepare("INSERT INTO kv (key, value) VALUES ('rules', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(clean));
  return clean;
}
function cleanDelay(d) {
  const unit = d?.unit === 'min' ? 'min' : 's', cap = unit === 'min' ? 60 : 3600;
  const min = Math.min(cap, Math.max(0, Number(d?.min) || 0)), max = Math.min(cap, Math.max(min, Number(d?.max) || min));
  return { enabled: !!d?.enabled, min, max, unit };
}
/** Segundos a esperar antes de responder (al azar entre min y max); 0 si la demora no está activada. */
export function replyDelaySec(r) {
  const d = r?.replyDelay;
  if (!d?.enabled) return 0;
  const k = d.unit === 'min' ? 60 : 1;
  return Math.round((d.min + Math.random() * (d.max - d.min)) * k);
}
function cleanRules(r) {
  return {
    privateChats: !!r.privateChats, groups: !!r.groups, newContacts: !!r.newContacts,
    groupMode: ['mention', 'context'].includes(r.groupMode) ? r.groupMode : 'all',
    groupContextMinutes: Math.min(120, Math.max(1, Number(r.groupContextMinutes) || 10)),
    groupReplyToBot: r.groupReplyToBot !== false, groupUseName: r.groupUseName !== false,
    groupKeywords: [...new Set((Array.isArray(r.groupKeywords) ? r.groupKeywords : String(r.groupKeywords || '').split(/[,;\n]+/)).map((w) => String(w).trim().toLowerCase()).filter((w) => w.length >= 2 && w.length <= 40))].slice(0, 20),
    groupHistory: Math.min(100, Math.max(5, Number(r.groupHistory) || 30)),
    groupFilter: cleanFilter(r.groupFilter),
    groupFilterOverrides: Object.fromEntries(Object.entries(r.groupFilterOverrides && typeof r.groupFilterOverrides === 'object' ? r.groupFilterOverrides : {}).filter(([j]) => /@g\.us$/.test(j)).map(([j, t]) => [j, cleanFilter(t, true)]).filter(([, t]) => Object.keys(t).length)),
    groupOverrides: Object.fromEntries(Object.entries(r.groupOverrides && typeof r.groupOverrides === 'object' ? r.groupOverrides : {}).filter(([j, v]) => /@g\.us$/.test(j) && ['all', 'mention', 'context', 'off'].includes(v))),
    groupMemberMode: r.groupMemberMode === 'allowlist' ? 'allowlist' : 'everyone',
    groupMembers: list(r.groupMembers),
    groupMemberOverrides: Object.fromEntries(Object.entries(r.groupMemberOverrides && typeof r.groupMemberOverrides === 'object' ? r.groupMemberOverrides : {})
      .filter(([j, o]) => /@g\.us$/.test(j) && o && ['everyone', 'own'].includes(o.mode))
      .map(([j, o]) => [j, o.mode === 'everyone' ? { mode: 'everyone' } : { mode: 'own', list: list(o.list), withGeneral: !!o.withGeneral }])),
    privateFilterOn: !!r.privateFilterOn, privateFilter: cleanTypes(r.privateFilter),
    newFilterOn: !!r.newFilterOn, newFilter: cleanTypes(r.newFilter),
    replyDelay: cleanDelay(r.replyDelay),
    mode: r.mode === 'allowlist' ? 'allowlist' : 'everyone',
    allowlist: list(r.allowlist), blocklist: list(r.blocklist),
  };
}

// Devuelve null si corresponde responder, o el motivo por el que se ignora.
export function shouldIgnore(jid, isKnownContact, instance) {
  if (jid.startsWith('playground:')) return null;
  const r = readRules(instance);
  const isGroup = jid.endsWith('@g.us');
  const num = digits(jid.split('@')[0]);
  if (!isGroup && r.blocklist.includes(num)) return 'bloqueado';
  if (isGroup && !r.groups) return 'grupos desactivados';
  if (isGroup && r.groupOverrides[jid] === 'off') return 'este grupo está silenciado';
  if (!isGroup && r.allowlist.includes(num)) return null;
  if (!isGroup && !r.privateChats) return 'chats individuales desactivados';
  if (!isGroup && r.mode === 'allowlist') return 'fuera de la lista permitida';
  if (!isGroup && !isKnownContact && !r.newContacts) return 'contactos nuevos desactivados';
  return null;
}

const plain = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const numOf = (j) => digits(String(j || '').split('@')[0].split(':')[0]);
export const groupModeFor = (jid, r = readRules()) => ['all', 'mention', 'context'].includes(r.groupOverrides[jid]) ? r.groupOverrides[jid] : r.groupMode;

/** ¿Le hablan al agente en este mensaje de grupo? Mención real (@), respuesta a un mensaje suyo, su nombre o una palabra clave. */
const botLids = new Set(); // identificadores @lid del agente aprendidos de los grupos
export async function isAddressed(evt, r = readRules()) {
  const bot = await botIdentity();
  const myNums = new Set([numOf(evt.botJid), numOf(bot.jid)].filter(Boolean));
  // WhatsApp moderno menciona con un identificador interno (@lid) en vez del número: se traduce con la lista de participantes del grupo
  const isMe = async (j) => {
    if (!j) return false;
    const n = numOf(j);
    if (myNums.has(n) || botLids.has(n)) return true;
    if (!/@lid$/.test(String(j)) || !evt.jid?.endsWith('@g.us')) return false;
    for (const fresh of [false, true]) {
      const hit = (await groupParticipants(evt.jid, fresh)).find((p) => numOf(p.id) === n);
      if (hit) { if (myNums.has(numOf(hit.phoneNumber))) { botLids.add(n); return true; } return false; }
    }
    return false;
  };
  for (const j of evt.mentionedJid || []) if (await isMe(j)) return 'mención';
  if (r.groupReplyToBot && (await isMe(evt.quotedParticipant))) return 'respuesta a un mensaje suyo';
  const text = plain(evt.text || '');
  for (const n of [...myNums, ...botLids]) if (n && text.includes('@' + n)) return 'mención';
  const words = [...r.groupKeywords, ...(r.groupUseName && bot.name ? [bot.name] : [])].map(plain).filter(Boolean);
  for (const w of words) if (new RegExp(`(^|[^\\p{L}\\p{N}])${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\p{L}\\p{N}]|$)`, 'u').test(text)) return `dijeron "${w}"`;
  return null;
}

/** Filtro de tipos efectivo de un grupo: el general con las personalizaciones de ese grupo encima. */
export const filterFor = (jid, r = readRules()) => ({ ...DEFAULT_RULES.groupFilter, ...r.groupFilter, ...(r.groupFilterOverrides?.[jid] || {}) });

const ONLY_EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|[\u200d\ufe0f\u{1F3FB}-\u{1F3FF}]|\s)+$/u;
/** Tipo del mensaje para el filtro: text | audio | image | video | document | sticker | emojiReply (cita con solo emojis). */
export function messageType(evt) {
  if (evt.kind === 'text' && evt.quoted && ONLY_EMOJI.test(String(evt.text || '').trim())) return 'emojiReply';
  return ['audio', 'image', 'video', 'document', 'sticker'].includes(evt.kind) ? evt.kind : 'text';
}
/** ¿El filtro deja pasar este mensaje (cuando lo mencionaron)? */
export const passesFilter = (evt, f) => f.any || !!f[messageType(evt)];

/** ¿Este grupo restringe quién puede activarlo? (si no, no hace falta ni averiguar quién escribió) */
export function memberRestricted(groupJid, r = readRules()) {
  const o = r.groupMemberOverrides?.[groupJid];
  return o ? o.mode === 'own' : r.groupMemberMode === 'allowlist';
}
/** ¿Este miembro puede activarlo en este grupo? Mira la lista propia del grupo (si la tiene) o la general. `sender` = número del que escribió (solo dígitos) o null si no se pudo saber. */
export function memberAllowed(groupJid, sender, r = readRules()) {
  const o = r.groupMemberOverrides?.[groupJid];
  if (o?.mode === 'everyone') return true;
  const inList = (l) => !!sender && l.includes(sender);
  if (o?.mode === 'own') return inList(o.list || []) || (!!o.withGeneral && inList(r.groupMembers || []));
  return r.groupMemberMode !== 'allowlist' || inList(r.groupMembers || []);
}
/** Número de teléfono de quien escribió en un grupo (WhatsApp moderno manda un identificador @lid: se traduce con los participantes del grupo). */
export async function senderNumber(evt) {
  const p = String(evt.participant || '');
  if (!p) return null;
  if (!/@lid$/.test(p)) return numOf(p) || null;
  const n = numOf(p);
  for (const fresh of [false, true]) {
    const hit = (await groupParticipants(evt.jid, fresh)).find((x) => numOf(x.id) === n);
    if (hit) return numOf(hit.phoneNumber) || null;
  }
  return null;
}
/** Chats individuales: ¿este TIPO de mensaje merece respuesta? Los contactos nuevos pueden tener su propio filtro. Los números de la lista permitida responden siempre. */
export function privateTypeAllowed(evt, known, wa, r = readRules()) {
  if (r.allowlist.includes(digits(wa.split('@')[0]))) return true;
  const f = !known && r.newFilterOn ? r.newFilter : r.privateFilterOn ? r.privateFilter : null;
  return !f || !!f[messageType(evt)];
}
