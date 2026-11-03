// Horario de atención por número de WhatsApp. Fuera de horario: respuesta fija, otra personalidad o silencio (el mensaje igual se guarda).
import { officeOf, setOffice, getAccount } from './accounts.js';
import { readSettings } from './persona.js';

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
export const OFFICE_DEFAULT = {
  enabled: false,
  tz: '',              // vacío = la zona horaria general
  days: { 1: [['09:00', '18:00']], 2: [['09:00', '18:00']], 3: [['09:00', '18:00']], 4: [['09:00', '18:00']], 5: [['09:00', '18:00']], 6: [], 0: [] }, // 0 = domingo; lista de tramos [desde, hasta]
  mode: 'message',     // 'message' = responde un texto fijo | 'persona' = responde con otra personalidad | 'silent' = no responde
  message: 'Hola 👋 Ahora estamos fuera de horario. Te respondemos apenas abramos.',
  personaId: null,
  cooldownHours: 6,    // el texto fijo se manda como máximo una vez cada tantas horas por persona
  groups: false,       // aplicar también en grupos
};

export function cleanOffice(o) {
  const days = {};
  for (let d = 0; d < 7; d++) {
    const spans = Array.isArray(o?.days?.[d]) ? o.days[d] : OFFICE_DEFAULT.days[d];
    days[d] = spans.filter((x) => Array.isArray(x) && HHMM.test(x[0]) && HHMM.test(x[1])).map((x) => [x[0], x[1]]).slice(0, 4);
  }
  let tz = ''; if (o?.tz) { try { new Intl.DateTimeFormat('es', { timeZone: String(o.tz) }); tz = String(o.tz); } catch { tz = ''; } }
  return {
    enabled: !!o?.enabled, tz, days,
    mode: ['message', 'persona', 'silent'].includes(o?.mode) ? o.mode : 'message',
    message: String(o?.message ?? OFFICE_DEFAULT.message).slice(0, 1000),
    personaId: o?.personaId ? Number(o.personaId) || null : null,
    cooldownHours: Math.min(168, Math.max(0, Number(o?.cooldownHours ?? 6))),
    groups: !!o?.groups,
  };
}
export const getOffice = (instance) => ({ ...OFFICE_DEFAULT, ...(officeOf(instance) || {}) });
export function saveOffice(instance, o) {
  if (!getAccount(instance)) throw Object.assign(new Error('Ese número no existe'), { status: 404 });
  const clean = cleanOffice(o);
  setOffice(instance, clean);
  return clean;
}

/** ¿Está abierto en este momento? (true si el horario no está activado). */
export function isOpen(o, at = new Date()) {
  if (!o?.enabled) return true;
  const tz = o.tz || readSettings().timezone || 'America/Asuncion';
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(at).map((p) => [p.type, p.value]));
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  const now = `${parts.hour}:${parts.minute}`;
  return (o.days?.[day] || []).some(([a, b]) => (a <= b ? now >= a && now < b : now >= a || now < b)); // tramo que cruza medianoche: "22:00"-"02:00"
}
