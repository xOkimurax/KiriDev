const base = () => (process.env.EVOLUTION_URL || '').replace(/\/$/, '');
import { AsyncLocalStorage } from 'node:async_hooks';

export const PRIMARY_INSTANCE = () => process.env.EVOLUTION_INSTANCE || 'claude-bot';
const als = new AsyncLocalStorage();
/** Ejecuta `fn` con todas las llamadas a Evolution dirigidas a esa instancia (número de WhatsApp). Sin esto se usa la principal. */
export const withInstance = (instance, fn) => als.run({ instance }, fn);
export const currentInstance = () => als.getStore()?.instance || PRIMARY_INSTANCE();
const inst = currentInstance;

async function evo(method, path, body) {
  const res = await fetch(base() + path, {
    method,
    headers: { apikey: process.env.EVOLUTION_API_KEY || '', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20000),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) throw Object.assign(new Error(data?.response?.message?.[0] || data?.message || `Evolution ${res.status}`), { status: res.status, data });
  return data;
}

export async function findInstance() {
  const list = await evo('GET', `/instance/fetchInstances?instanceName=${encodeURIComponent(inst())}`).catch((e) => (e.status === 404 ? [] : Promise.reject(e)));
  return Array.isArray(list) ? list[0] : null;
}

export async function ensureInstance() {
  if (await findInstance()) return;
  await evo('POST', '/instance/create', { instanceName: inst(), qrcode: true, integration: 'WHATSAPP-BAILEYS' });
}

export async function setWebhook() {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) throw new Error('N8N_WEBHOOK_URL no está configurado');
  return evo('POST', `/webhook/set/${inst()}`, {
    webhook: { enabled: true, url, byEvents: false, base64: true, events: ['MESSAGES_UPSERT'] },
  });
}

export async function status() {
  const i = await findInstance();
  if (!i) return { exists: false, state: 'not_created', instance: inst() };
  const st = await evo('GET', `/instance/connectionState/${inst()}`).catch(() => null);
  return {
    exists: true, instance: inst(),
    state: st?.instance?.state || i.connectionStatus || 'unknown',
    number: i.ownerJid?.split('@')[0] || i.number || null,
    profileName: i.profileName || null,
    profilePicUrl: i.profilePicUrl || null,
    messages: i._count?.Message ?? null,
    contacts: i._count?.Contact ?? null,
  };
}

export async function connect() {
  await ensureInstance();
  await setWebhook().catch(() => {});
  return evo('GET', `/instance/connect/${inst()}`);
}

export const deleteInstance = () => evo('DELETE', `/instance/delete/${inst()}`);
export const logout = () => evo('DELETE', `/instance/logout/${inst()}`);
export const restart = () => evo('POST', `/instance/restart/${inst()}`);
export const getWebhook = () => evo('GET', `/webhook/find/${inst()}`).catch(() => null);
export const sendText = (number, text) => evo('POST', `/message/sendText/${inst()}`, { number, text });

// "escribiendo…" durante `ms` milisegundos (la llamada espera ese tiempo)
export const sendPresence = (number, ms = 8000, presence = 'composing') =>
  evo('POST', `/chat/sendPresence/${inst()}`, { number, delay: ms, presence });
export const markRead = (key) =>
  evo('POST', `/chat/markMessageAsRead/${inst()}`, { readMessages: [{ remoteJid: key.remoteJid, fromMe: false, id: key.id }] });
export const getMedia = (id) =>
  evo('POST', `/chat/getBase64FromMediaMessage/${inst()}`, { message: { key: { id } }, convertToMp4: false });

/** ¿Estos números tienen WhatsApp? → [{ exists, jid, number }] */
export const whatsappNumbers = (numbers) => evo('POST', `/chat/whatsappNumbers/${inst()}`, { numbers });
export const sendTextTo = (number, text, delay = 600) => evo('POST', `/message/sendText/${inst()}`, { number, text, delay });
export const sendMediaTo = (number, a) => evo('POST', `/message/sendMedia/${inst()}`, { number, mediatype: a.mediatype, mimetype: a.mimetype, caption: a.caption || '', media: a.url, fileName: a.fileName, delay: 1000 });
export const sendAudioTo = (number, a) => evo('POST', `/message/sendWhatsAppAudio/${inst()}`, { number, audio: a.url, delay: 1200 });

const ownerCache = new Map(); // instancia -> { at, jid, name }
/** Identidad de la cuenta de WhatsApp del agente (para saber si lo mencionaron). Se cachea 10 min. */
export async function botIdentity() {
  const k = inst(), c = ownerCache.get(k);
  if (c && Date.now() - c.at < 600e3 && c.jid) return c;
  try { const i = await findInstance(); if (i?.ownerJid) ownerCache.set(k, { at: Date.now(), jid: i.ownerJid, name: i.profileName || null }); } catch { /* sin Evolution: se usa lo que mande el evento */ }
  return ownerCache.get(k) || { at: 0, jid: null, name: null };
}
const partCache = new Map(); // `${instancia}|${grupo}` -> { at, list }
/** Participantes de un grupo ({ id: '123@lid', phoneNumber: '595…@s.whatsapp.net' }): sirve para traducir las menciones en formato LID. Cache de 2 min. */
export async function groupParticipants(jid, fresh = false) {
  const ck = `${inst()}|${jid}`, c = partCache.get(ck);
  if (!fresh && c && Date.now() - c.at < 120e3) return c.list;
  const list = await evo('GET', `/group/participants/${inst()}?groupJid=${encodeURIComponent(jid)}`).then((r) => r?.participants || []).catch(() => c?.list || []);
  partCache.set(ck, { at: Date.now(), list });
  return list;
}
/** Nombre (asunto) de un grupo. */
export const groupSubject = (jid) => evo('GET', `/group/findGroupInfos/${inst()}?groupJid=${encodeURIComponent(jid)}`).then((g) => g?.subject || null).catch(() => null);

/** Todos los grupos con sus participantes ({ id: lid, phoneNumber }). */
export const fetchAllGroups = () => evo('GET', `/group/fetchAllGroups/${inst()}?getParticipants=true`);

/** Historial de un chat guardado por Evolution (del más viejo al más nuevo): [{ fromMe, text, at, kind }]. Pagina hasta `max` mensajes. */
export async function chatHistory(jid, max = 300) {
  const out = [];
  for (let page = 1; out.length < max && page <= 40; page++) {
    const r = await evo('POST', `/chat/findMessages/${inst()}`, { where: { key: { remoteJid: jid } }, page, offset: 50 });
    const recs = r?.messages?.records || (Array.isArray(r) ? r : []);
    if (!recs.length) break;
    for (const m of recs) {
      const x = m.message || {};
      const text = x.conversation ?? x.extendedTextMessage?.text ?? x.imageMessage?.caption ?? x.videoMessage?.caption ?? x.documentMessage?.caption ?? null;
      const kind = text != null ? 'text' : x.audioMessage ? 'audio' : x.imageMessage ? 'image' : x.videoMessage ? 'video' : x.stickerMessage ? 'sticker' : x.documentMessage ? 'document' : null;
      if (!kind) continue;
      out.push({ fromMe: !!m.key?.fromMe, text: text ?? { audio: '[nota de voz]', image: '[imagen]', video: '[video]', sticker: '[sticker]', document: '[documento]' }[kind], at: Number(m.messageTimestamp) || 0, kind });
    }
    if (page >= (r?.messages?.pages || 1)) break;
  }
  return out.sort((a, b) => a.at - b.at).slice(-max);
}

/** Contactos que Evolution conoce de esta línea: [{ number, name }]. Vacío si Evolution no guarda contactos (DATABASE_SAVE_DATA_CONTACTS=false). */
export async function findContacts() {
  const r = await evo('POST', `/chat/findContacts/${inst()}`, { where: {} });
  return (Array.isArray(r) ? r : []).filter((c) => /@s\.whatsapp\.net$/.test(c.remoteJid || '')).map((c) => ({ number: c.remoteJid.split('@')[0], name: c.pushName || c.name || null }));
}
