// Envío de mensajes que NO nacen de un webhook (p. ej. el aviso cuando termina una tarea delegada).
import * as evo from './evolution.js';
import { splitKey } from './accounts.js';

/** Parte el texto como lo hace el workflow de n8n: párrafos agrupados en ≤4 mensajes de ~600 caracteres. */
export function splitText(text) {
  const paras = String(text || '').trim().split(/\n{2,}/).map((x) => x.trim()).filter(Boolean);
  const chunks = [];
  let cur = '';
  for (const p of paras) {
    if (cur && cur.length + p.length > 600) { chunks.push(cur); cur = p; } else cur = cur ? `${cur}\n\n${p}` : p;
  }
  if (cur) chunks.push(cur);
  while (chunks.length > 4) { const last = chunks.pop(); chunks[chunks.length - 1] += `\n\n${last}`; }
  return chunks;
}

/** Entrega texto y adjuntos por WhatsApp. En sesiones de prueba (playground) no envía nada: queda en el historial. */
export function deliver(key, text, attachments = []) {
  if (key.startsWith('playground:') || !process.env.EVOLUTION_URL) return Promise.resolve({ delivered: false });
  const { instance, jid } = splitKey(key); // la clave del chat incluye el número de WhatsApp por el que se habla
  return evo.withInstance(instance, () => deliverTo(jid, text, attachments));
}
async function deliverTo(jid, text, attachments) {
  const chunks = splitText(text);
  for (let i = 0; i < chunks.length; i++) await evo.sendTextTo(jid, chunks[i], i === 0 ? 600 : Math.min(2500, 700 + chunks[i].length * 12));
  const failed = [];
  for (const a of attachments.slice(0, 5)) {
    try { await (a.mediatype === 'audio' ? evo.sendAudioTo(jid, a) : evo.sendMediaTo(jid, a)); }
    catch (e) { failed.push(a.fileName); console.error(`[deliver ${jid}] no se pudo enviar ${a.fileName}: ${e.message}`); }
  }
  if (failed.length) await evo.sendTextTo(jid, `Preparé ${failed.map((f) => `«${f}»`).join(', ')} pero WhatsApp no me dejó enviarlo. ¿Querés que pruebe de otra forma (otro formato o más liviano)?`).catch(() => {});
  return { delivered: true, failed };
}
