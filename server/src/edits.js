// Ediciones de mensajes de WhatsApp. Las ediciones llegan CIFRADAS (secretEncryptedMessage): se descifran con el `messageSecret`
// del mensaje original (que guardamos al recibirlo). Esquema (verificado con una edición real):
//   clave = HKDF-SHA256(messageSecret, sin salt, info = idOriginal + remitenteOriginal + remitenteEdición + "Message Edit", 32 bytes)
//   AES-256-GCM, iv = encIv, sin AAD, tag = últimos 16 bytes de encPayload; el resultado es un Message de WhatsApp (protobuf).
import crypto from 'node:crypto';
import { fetchAllGroups, currentInstance } from './evolution.js';

/** Lector mínimo de protobuf: devuelve [{ f: número de campo, w: tipo de cable, v: Buffer | número }]. */
function fields(buf) {
  const out = []; let i = 0;
  const varint = () => { let r = 0n, s = 0n; for (;;) { const b = buf[i++]; if (b === undefined) throw new Error('fin inesperado'); r |= BigInt(b & 0x7f) << s; if (!(b & 0x80)) break; s += 7n; } return r; };
  while (i < buf.length) {
    const tag = Number(varint()); const f = tag >> 3, w = tag & 7;
    if (w === 0) out.push({ f, w, v: Number(varint()) });
    else if (w === 2) { const n = Number(varint()); out.push({ f, w, v: buf.subarray(i, i + n) }); i += n; }
    else if (w === 1) { out.push({ f, w, v: buf.subarray(i, i + 8) }); i += 8; }
    else if (w === 5) { out.push({ f, w, v: buf.subarray(i, i + 4) }); i += 4; }
    else throw new Error('tipo de campo no soportado');
  }
  return out;
}
const sub = (buf, f) => fields(buf).find((x) => x.f === f && x.w === 2)?.v;
const str = (buf, f) => { const v = sub(buf, f); return v ? v.toString('utf8') : null; };

/** Texto nuevo dentro del Message editado: conversation, extendedTextMessage.text o el caption de imagen/video/documento. */
export function editedText(message) {
  return str(message, 1)
    ?? (sub(message, 6) && str(sub(message, 6), 1))
    ?? (sub(message, 3) && str(sub(message, 3), 3))   // imagen
    ?? (sub(message, 9) && str(sub(message, 9), 7))   // video
    ?? (sub(message, 7) && str(sub(message, 7), 20))  // documento
    ?? null;
}

/** Descifra el payload y devuelve { targetId, text } o lanza si ninguna identidad candidata abre el mensaje. */
export function decryptEdit({ secret, encPayload, encIv, targetId, candidates }) {
  const key32 = Buffer.from(secret, 'base64'), payload = Buffer.from(encPayload, 'base64'), iv = Buffer.from(encIv, 'base64');
  if (key32.length !== 32 || payload.length < 17 || iv.length !== 12) throw new Error('datos de edición inválidos');
  const tag = payload.subarray(-16), ct = payload.subarray(0, -16);
  for (const jid of candidates) {
    try {
      const info = Buffer.concat([Buffer.from(targetId), Buffer.from(jid), Buffer.from(jid), Buffer.from('Message Edit')]);
      const k = Buffer.from(crypto.hkdfSync('sha256', key32, Buffer.alloc(0), info, 32));
      const d = crypto.createDecipheriv('aes-256-gcm', k, iv); d.setAuthTag(tag);
      const plain = Buffer.concat([d.update(ct), d.final()]);
      const proto = sub(plain, 12);              // Message.protocolMessage
      const edited = proto && sub(proto, 14);    // ProtocolMessage.editedMessage
      const text = edited ? editedText(edited) : null;
      if (text != null) return { targetId, text, sender: jid };
    } catch { /* esta identidad no es: se prueba la siguiente */ }
  }
  throw new Error('no se pudo descifrar la edición (el mensaje original no tiene clave guardada o no conozco a quien lo escribió)');
}

const lidCache = new Map(); // instancia -> { at, list }
/** Identificadores @lid de todos los participantes de los grupos del agente (para probar quién editó). Cache 5 min. */
export async function knownLids(fresh = false) {
  const k = currentInstance(), c = lidCache.get(k);
  if (!fresh && c && Date.now() - c.at < 300e3) return c.list;
  const groups = await fetchAllGroups().catch(() => []);
  const list = [...new Set(groups.flatMap((g) => (g.participants || []).map((p) => p.id)).filter((j) => /@lid$/.test(j)))];
  lidCache.set(k, { at: Date.now(), list });
  return list;
}
