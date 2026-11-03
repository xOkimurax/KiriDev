// Notas de voz del agente (opcional): el agente escribe lo que quiere decir y el hub lo convierte en audio con ElevenLabs.
// La clave NO vive en la carpeta del agente: se carga desde el panel (data/secrets/elevenlabs.key, modo 0600) o en ELEVENLABS_API_KEY.
// El agente nunca ve la clave: llama a la herramienta send_voice → /internal/voice → el hub sintetiza y devuelve el mp3.
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { ElevenLabsClient } from '@elevenlabs/elevenlabs-js';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { db, DATA_DIR } from './db.js';
import { appliesTo, cleanPersonaIds } from './personas.js';

db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
const DIR = path.join(DATA_DIR, 'secrets');
const KEY_FILE = path.join(DIR, 'elevenlabs.key');
const fail = (status, message) => Object.assign(new Error(message), { status });
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export const DEFAULT_GUIDE = `Cuando mandes un audio, hablá como una persona: en primera persona y directo a la otra persona, como en una nota de voz entre conocidos.
- Texto limpio, pensado para decirse en voz alta: sin emojis, sin markdown (asteriscos, numerales, guiones de lista), sin enlaces ni direcciones largas, sin paréntesis ni acotaciones tipo «(risas)» ni etiquetas entre corchetes.
- Frases cortas y naturales. Usá comas y puntos para marcar las pausas. Nada de listas: contalo corrido («primero…, después…, y por último…»).
- Escribí los números, montos, fechas y siglas como se dicen («cincuenta mil guaraníes», «el martes a las nueve»), no como símbolos.
- No digas «te mando un audio» ni describas lo que hacés: empezá directo con lo que querés decir. Entre 5 y 40 segundos de duración, salvo que pidan más.
- Los datos para copiar (enlaces, códigos, direcciones, números de cuenta) mandalos por texto además del audio, y en el audio decí solo que están escritos.`;

export const DEFAULTS = {
  enabled: false,
  personas: null,           // null = todas las personalidades; si no, solo esas
  mode: 'asked',            // 'asked' = solo cuando la persona lo pide · 'mirror' = también cuando ella escribe con una nota de voz · 'always' = siempre que convenga
  alsoText: false,          // false = el audio va solo; true = el audio va acompañado de su texto
  guide: DEFAULT_GUIDE,     // cómo tiene que hablar en un audio (se le da al agente)
  voiceId: 'htFfPSZGJwjBv1CL0aMD',
  modelId: 'eleven_v3_conversational',
  languageCode: 'es',
  speed: 1,
  style: 1,
  stability: null,          // null = el valor propio de la voz
  distance: null,           // efecto «distancia» (0 cerca … 1 lejos); null = sin efecto
  provider: 'elevenlabs',   // voz principal: 'elevenlabs' (necesita cuenta y clave) o 'edge' (gratis, sin cuenta)
  fallback: true,           // respaldo gratis (voces de Microsoft Edge) cuando ElevenLabs falla, se queda sin créditos o llega al tope diario; sin clave de ElevenLabs es la voz principal
  edgeVoice: 'es-PY-TaniaNeural',
  maxChars: 900,            // tope de texto por audio (cuida el gasto)
  maxPerDay: 40,            // tope de audios por día (todo el hub)
};

export function readSettings() {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'voice'").get();
  let v = {}; try { v = row ? JSON.parse(row.value) : {}; } catch { /* valores por defecto */ }
  return { ...DEFAULTS, ...v };
}
export function writeSettings(s) {
  const opt = (v, lo, hi) => (v === null || v === '' || v === undefined ? null : clamp(v, lo, hi, null));
  const clean = {
    enabled: !!s.enabled, personas: cleanPersonaIds(s.personas),
    mode: ['asked', 'mirror', 'always'].includes(s.mode) ? s.mode : DEFAULTS.mode,
    alsoText: !!s.alsoText, provider: s.provider === 'edge' ? 'edge' : 'elevenlabs', fallback: s.fallback !== false,
    edgeVoice: /^[a-z]{2,3}-[A-Za-z0-9-]{2,12}-[A-Za-z0-9]{2,40}Neural$/.test(String(s.edgeVoice || '').trim()) ? String(s.edgeVoice).trim() : DEFAULTS.edgeVoice,
    guide: String(s.guide ?? '').trim().slice(0, 3000) || DEFAULT_GUIDE,
    voiceId: /^[A-Za-z0-9_-]{8,40}$/.test(String(s.voiceId || '').trim()) ? String(s.voiceId).trim() : DEFAULTS.voiceId,
    modelId: /^[a-z0-9_.-]{3,60}$/i.test(String(s.modelId || '').trim()) ? String(s.modelId).trim() : DEFAULTS.modelId,
    languageCode: /^[a-z]{2,3}$/i.test(String(s.languageCode || '').trim()) ? String(s.languageCode).trim().toLowerCase() : DEFAULTS.languageCode,
    speed: clamp(s.speed, 0.7, 1.2, DEFAULTS.speed), style: clamp(s.style, 0, 1, DEFAULTS.style),
    stability: opt(s.stability, 0, 1), distance: opt(s.distance, 0, 1),
    maxChars: clamp(s.maxChars, 100, 4000, DEFAULTS.maxChars), maxPerDay: clamp(s.maxPerDay, 1, 1000, DEFAULTS.maxPerDay),
  };
  db.prepare("INSERT INTO kv (key, value) VALUES ('voice', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(clean));
  return readSettings();
}

// ---------- clave ----------
const panelKey = () => { try { return fs.readFileSync(KEY_FILE, 'utf8').trim(); } catch { return ''; } };
export const apiKey = () => panelKey() || String(process.env.ELEVENLABS_API_KEY || '').trim();
export function keyStatus() {
  const panel = panelKey(), env = String(process.env.ELEVENLABS_API_KEY || '').trim(), k = panel || env;
  return { configured: !!k, source: panel ? 'panel' : env ? 'servidor' : null, hint: k ? `…${k.slice(-4)}` : null };
}
export function saveKey(key) {
  const k = String(key || '').trim();
  if (!/^\S{16,200}$/.test(k)) throw fail(400, 'La clave no parece válida (sin espacios; la de ElevenLabs suele empezar con sk_).');
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(KEY_FILE, k + '\n', { mode: 0o600 });
  return keyStatus();
}
export function deleteKey() { fs.rmSync(KEY_FILE, { force: true }); return keyStatus(); }

/** ¿Está encendida para esta personalidad y hay clave? (lo usa el runner para darle o no la herramienta send_voice) */
export function enabledFor(persona) { try { const s = readSettings(); return s.enabled && (s.provider === 'edge' || !!apiKey() || s.fallback) && appliesTo(s, persona); } catch { return false; } }

// ---------- texto → audio ----------
db.exec(`CREATE TABLE IF NOT EXISTS voice_log (id INTEGER PRIMARY KEY AUTOINCREMENT, jid TEXT, chars INTEGER, at TEXT NOT NULL DEFAULT (datetime('now')))`);
try { db.exec("ALTER TABLE voice_log ADD COLUMN engine TEXT"); } catch { /* ya existe */ }
db.exec("DELETE FROM voice_log WHERE at < datetime('now', '-120 days')");
export const usageToday = () => db.prepare("SELECT COUNT(*) n, COALESCE(SUM(chars), 0) chars, COALESCE(SUM(engine = 'edge'), 0) edge FROM voice_log WHERE at >= datetime('now', 'start of day')").get();
// el tope diario cuida el gasto de ElevenLabs: los audios de respaldo (gratis) no cuentan
const elevenToday = () => db.prepare("SELECT COUNT(*) n FROM voice_log WHERE at >= datetime('now', 'start of day') AND COALESCE(engine, 'elevenlabs') != 'edge'").get().n;

/** Deja el texto listo para decirse en voz alta: sin emojis, markdown, enlaces, acotaciones ni etiquetas. Es una red de seguridad: lo principal es la guía que recibe el agente. */
export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]\n]{1,60})\]\([^)\s]*\)/g, '$1')                            // [texto](enlace) → texto
    .replace(/https?:\/\/\S+|www\.\S+/gi, ' ')
    .replace(/\[[^\]\n]{0,40}\]/g, ' ')                                          // [etiquetas]
    .replace(/\((?:risas?|suspira|suspiro|pausa|silencio|[^()\n]{0,20}\*[^()\n]{0,20})\)/gi, ' ')
    .replace(/[\p{Extended_Pictographic}\p{Emoji_Modifier}‍️⃣]/gu, '')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '').replace(/^\s*>\s?/gm, '').replace(/^\s*(?:[-*•]|\d+[.)])\s+/gm, '')
    .replace(/(\*\*|__|~~|`|\*|_{1,2})/g, '')
    .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '. ').replace(/\.\s*\.+/g, '.').replace(/([,:;])\s*\./g, '$1').replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

let client = null, clientKey = '';
const eleven = () => { const k = apiKey(); if (!k) throw fail(400, 'Falta la clave de ElevenLabs.'); if (!client || clientKey !== k) { client = new ElevenLabsClient({ apiKey: k, ...(process.env.ELEVENLABS_API_URL ? { baseUrl: process.env.ELEVENLABS_API_URL } : {}) }); clientKey = k; } return client; };
async function toBuffer(res) {
  if (res && typeof res.getReader === 'function') return Buffer.from(await new Response(res).arrayBuffer());
  return Buffer.from(res);
}
const explain = (e) => {
  const code = e?.statusCode || e?.status, body = typeof e?.body === 'object' ? JSON.stringify(e.body) : String(e?.body || '');
  const perm = /missing the permission\s+([a-z_]+)/i.exec(body)?.[1] || (/missing_permissions/i.test(body) ? 'necesario' : '');
  if (code === 401 && perm) return `Tu clave de ElevenLabs es válida pero no tiene el permiso «${perm}». Activalo en elevenlabs.io → Developers → API Keys → editar la clave (según lo que uses: «Voices», «Models», «User» en lectura, y «Text to Speech» para generar el audio).`;
  if (code === 401) return 'ElevenLabs rechazó la clave (inválida o revocada).';
  if (/paid_plan|payment_required|library voice|free.?(tier|plan|user)|upgrade/i.test(body) || (code === 402 && !/quota|credit/i.test(body)))
    return 'Tu plan gratis de ElevenLabs solo permite usar voces predeterminadas por API. Elegí una voz predeterminada (en «Cargar mis voces» aparecen marcadas) o mejorá el plan para usar voces de la biblioteca.';
  if (code === 402 || /quota|credit/i.test(body)) return 'Se acabaron los créditos de ElevenLabs.';
  if (code === 404 || /voice.*not.*found/i.test(body)) return 'ElevenLabs no encontró esa voz: revisá el ID de voz.';
  if (code === 422) return `ElevenLabs no aceptó los ajustes (${body.slice(0, 160)}). Probá con otro modelo o sin efectos.`;
  if (code === 429) return 'ElevenLabs está limitando las solicitudes: probá en un momento.';
  return `ElevenLabs respondió con un error: ${String(e?.message || e).slice(0, 200)}`;
};

/** Voces disponibles en la cuenta (propias, clonadas y las predeterminadas). Las predeterminadas funcionan también con el plan gratis. */
export async function listVoices({ premadeOnly = false } = {}) {
  try {
    const all = []; let token;
    for (let page = 0; page < 6; page++) { // todas las páginas (tope de seguridad)
      const r = await eleven().voices.search({ pageSize: 100, ...(premadeOnly ? { category: 'premade' } : {}), ...(token ? { nextPageToken: token } : {}) });
      all.push(...(r.voices || []));
      token = r.hasMore ? r.nextPageToken : null;
      if (!token) break;
    }
    return all.filter((v) => !premadeOnly || v.category === 'premade').map((v) => ({
      id: v.voiceId, name: v.name || v.voiceId, category: v.category || 'otra', premade: v.category === 'premade',
      description: String(v.description || '').slice(0, 120), preview: v.previewUrl || null,
      labels: [v.labels?.gender, v.labels?.accent, v.labels?.age].filter(Boolean).join(' · '),
    })).sort((a, b) => Number(b.premade) - Number(a.premade) || a.name.localeCompare(b.name));
  } catch (e) { throw e.status ? e : fail(502, explain(e)); }
}

/** Créditos de la cuenta de ElevenLabs: usados, límite, % y cuándo se reinician (según ElevenLabs). Pide el permiso de lectura del usuario/suscripción en la clave. */
export async function usage() {
  const k = apiKey(); if (!k) throw fail(400, 'Falta la clave de ElevenLabs.');
  try {
    const res = await fetch(`${process.env.ELEVENLABS_API_URL || 'https://api.elevenlabs.io'}/v1/user/subscription`, { headers: { 'xi-api-key': k }, signal: AbortSignal.timeout(15000) });
    const text = await res.text();
    if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { statusCode: res.status, body: text.slice(0, 400) });
    const r = JSON.parse(text); // se leen solo los campos necesarios (no se valida el resto)
    const used = Number(r.character_count) || 0, limit = Number(r.character_limit) || 0;
    return { tier: r.tier || '—', status: r.status || null, used, limit, percent: limit ? Math.min(100, Math.round((used / limit) * 1000) / 10) : null, resetAt: r.next_character_count_reset_unix ? new Date(r.next_character_count_reset_unix * 1000).toISOString() : null };
  } catch (e) { throw e.status ? e : fail(502, e.statusCode ? explain(e) : `No se pudo consultar los créditos: ${e.message}`); }
}

/** Modelos de texto a voz que ofrece ElevenLabs (con lo que soporta cada uno). Se cachea una hora. */
let modelCache = null;
export async function listModels({ fresh = false } = {}) {
  if (!fresh && modelCache && modelCache.key === apiKey() && Date.now() - modelCache.at < 3600e3) return modelCache.list;
  try {
    const r = await eleven().models.list();
    const list = (r || []).filter((m) => m.canDoTextToSpeech).map((m) => ({
      id: m.modelId, name: m.name || m.modelId, description: String(m.description || '').slice(0, 200),
      style: !!m.canUseStyle, boost: !!m.canUseSpeakerBoost, maxChars: m.maximumTextLengthPerRequest || null, alpha: !!m.requiresAlphaAccess,
      languages: (m.languages || []).map((l) => ({ id: l.languageId, name: l.name })),
    }));
    modelCache = { key: apiKey(), at: Date.now(), list };
    return list;
  } catch (e) { throw e.status ? e : fail(502, explain(e)); }
}
const modelInfo = async (id) => (await listModels().catch(() => [])).find((m) => m.id === id) || null;

/** Velocidad: se aplica sobre el audio ya generado (ffmpeg atempo, mantiene el tono): así funciona igual con cualquier modelo, también los que ignoran el ajuste de velocidad. */
export function applySpeed(buf, speed) {
  const sp = Number(speed);
  if (!Number.isFinite(sp) || Math.abs(sp - 1) < 0.01) return Promise.resolve(buf);
  return new Promise((resolve) => {
    const ff = spawn('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-filter:a', `atempo=${Math.min(2, Math.max(0.5, sp)).toFixed(3)}`, '-f', 'mp3', '-b:a', '128k', 'pipe:1'], { stdio: ['pipe', 'pipe', 'ignore'] });
    const out = []; const t = setTimeout(() => { ff.kill('SIGKILL'); resolve(buf); }, 30000);
    ff.stdout.on('data', (d) => out.push(d));
    ff.on('error', () => { clearTimeout(t); resolve(buf); });
    ff.on('close', () => { clearTimeout(t); const r = Buffer.concat(out); resolve(r.length > 500 ? r : buf); }); // si falla, se entrega sin cambiar la velocidad
    ff.stdin.on('error', () => {}); ff.stdin.end(buf);
  });
}

/** Genera el mp3. `text` ya limpio. Lanza errores con mensaje entendible. */
export async function synthesize(text, s = readSettings()) {
  const info = await modelInfo(s.modelId);
  // el estilo solo se envía si el modelo lo soporta (según ElevenLabs); la velocidad se aplica después, sobre el audio
  const voiceSettings = { ...(info ? (info.style ? { style: s.style } : {}) : { style: s.style }), ...(s.stability != null ? { stability: s.stability } : {}) };
  try {
    const res = await eleven().textToSpeech.convert(s.voiceId, {
      text, modelId: s.modelId, languageCode: s.languageCode, voiceSettings,
      ...(s.distance != null ? { audioEffects: { distance: s.distance } } : {}),
    }, { timeoutInSeconds: 60, maxRetries: 1 });
    const buf = await toBuffer(res);
    if (buf.length < 500) throw new Error('ElevenLabs devolvió un audio vacío');
    return await applySpeed(buf, s.speed);
  } catch (e) { throw e.status ? e : fail(502, explain(e)); }
}

// ---------- respaldo gratis: voces de Microsoft Edge (sin clave; no es una API oficial, puede cambiar) ----------
let edgeVoices = null;
/** Voces que ofrece Edge, por idioma (por defecto español). Se cachea 6 horas. */
export async function listEdgeVoices({ lang = 'es' } = {}) {
  if (!edgeVoices || Date.now() - edgeVoices.at > 6 * 3600e3) {
    const t = new MsEdgeTTS();
    try { edgeVoices = { at: Date.now(), list: await t.getVoices() }; } catch (e) { throw fail(502, `No se pudo consultar las voces de respaldo: ${e.message}`); } finally { try { t.close(); } catch { /* */ } }
  }
  return edgeVoices.list.filter((v) => v.Locale?.toLowerCase().startsWith(`${lang}-`) && v.Status !== 'Deprecated')
    .map((v) => ({ id: v.ShortName, name: v.ShortName.replace(/Neural$/, '').replace(/^[a-z]{2,3}-[A-Za-z0-9-]+?-/, ''), gender: v.Gender === 'Female' ? 'mujer' : 'hombre', locale: v.Locale, place: v.LocaleName || v.Locale }))
    .sort((a, b) => (a.locale === 'es-PY' ? 0 : 1) - (b.locale === 'es-PY' ? 0 : 1) || a.locale.localeCompare(b.locale) || a.name.localeCompare(b.name));
}
export async function edgeSynthesize(text, s = readSettings()) {
  const t = new MsEdgeTTS({ connectionTimeoutMs: 15000, synthesisTimeoutMs: 40000 });
  try {
    await t.setMetadata(s.edgeVoice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const { audioStream } = t.toStream(text);
    const chunks = [];
    await Promise.race([
      (async () => { for await (const c of audioStream) chunks.push(c); })(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('tiempo de espera agotado')), 45000)),
    ]);
    const buf = Buffer.concat(chunks);
    if (buf.length < 500) throw new Error('audio vacío');
    return await applySpeed(buf, s.speed);
  } catch (e) { throw fail(502, `La voz de respaldo no pudo generar el audio: ${e.message}`); }
  finally { try { t.close(); } catch { /* */ } }
}

/** Elige el motor: ElevenLabs si hay clave; si falla (créditos, plan, permisos, red…) y el respaldo está activo, Edge. `force` = 'elevenlabs' | 'edge' (para las pruebas del panel). */
async function generate(text, s, force) {
  const useEleven = force ? force === 'elevenlabs' : s.provider !== 'edge' && !!apiKey();
  if (useEleven) {
    try { return { audio: await synthesize(text, s), engine: 'elevenlabs' }; }
    catch (e) {
      if (force || !s.fallback) throw e;
      console.error(`[voz] ElevenLabs falló (${e.message}); se usa la voz de respaldo`);
      try { return { audio: await edgeSynthesize(text, s), engine: 'edge', reason: e.message }; } catch { throw e; }
    }
  }
  if (!force && s.provider !== 'edge' && !s.fallback) throw fail(400, 'Falta la clave de ElevenLabs.');
  return { audio: await edgeSynthesize(text, s), engine: 'edge' };
}

/** Lo que usa el agente (por el hub): valida topes, limpia el texto y devuelve el audio. */
export async function speak(jid, rawText) {
  const s = readSettings();
  if (!s.enabled) throw fail(403, 'Los audios están desactivados.');
  const text = cleanForSpeech(rawText);
  if (text.length < 2) throw fail(400, 'No quedó texto para decir en el audio (se quitan emojis, enlaces y formato). Escribilo de nuevo en frases normales.');
  if (text.length > s.maxChars) throw fail(400, `El audio es demasiado largo (${text.length} caracteres; máximo ${s.maxChars}). Acortalo o dividilo en dos audios.`);
  const capped = s.provider !== 'edge' && !!apiKey() && elevenToday() >= s.maxPerDay;
  if (capped && !s.fallback) throw fail(429, `Se llegó al tope de ${s.maxPerDay} audios por hoy. Respondé por texto.`);
  const r = await generate(text, s, capped ? 'edge' : undefined);
  db.prepare('INSERT INTO voice_log (jid, chars, engine) VALUES (?, ?, ?)').run(jid || null, text.length, r.engine);
  return { audio: r.audio, chars: text.length, text, engine: r.engine };
}

/** Prueba desde el panel: genera una muestra corta (gasta unos pocos caracteres) para validar la clave y escuchar la voz. */
export async function test(text, overrides = {}, engine) {
  const t = cleanForSpeech(text || 'Hola, soy tu asistente. Así voy a sonar cuando te mande un audio.').slice(0, 200);
  const s = { ...readSettings(), ...Object.fromEntries(Object.entries(overrides).filter(([k, v]) => ['voiceId', 'modelId', 'languageCode', 'speed', 'style', 'stability', 'distance', 'edgeVoice'].includes(k) && v !== undefined)) };
  const t0 = Date.now();
  const r = await generate(t, s, engine === 'edge' ? 'edge' : 'elevenlabs');
  return { audio: r.audio, ms: Date.now() - t0, chars: t.length, engine: r.engine };
}

/** ¿Esta respuesta lleva una nota de voz y la configuración pide que el audio vaya solo (sin repetirlo por escrito)? */
export function audioOnly(persona, attachments = []) {
  try { return enabledFor(persona) && !readSettings().alsoText && attachments.length > 0 && attachments.every((a) => /^nota-de-voz-/.test(String(a.fileName || ''))); } catch { return false; }
}

// ---------- lo que se le dice al agente ----------
const ASKS_AUDIO = /\b(audios?|notas? de voz|nota de audio|habl(a|á)me|hablando|grab(a|á)me|dec(i|í)melo|dec(i|í)lo (en|con) (un )?audio|por voz)\b/i;
/** Empujón determinista por mensaje (el modelo suele seguir el hilo de texto de la charla y no la regla): según el modo elegido, le recuerda que ESTE mensaje pide audio. */
export function nudge(persona, { kind, text } = {}) {
  try {
    if (!enabledFor(persona)) return '';
    const s = readSettings(), isNote = kind === 'audio';
    const asked = ASKS_AUDIO.test(String(text || '').replace(/^🎤\s*/, '')) && !isNote;
    if (asked || (isNote && s.mode !== 'asked') || (s.mode === 'always' && !isNote)) {
      const why = asked ? 'La persona te pidió un audio' : isNote ? 'La persona te escribió con una nota de voz' : 'Según tu configuración respondés con audio';
      return `[AVISO INTERNO DEL SISTEMA — no lo menciones: ${why}. Mandá el audio DIRECTAMENTE: llamá vos mismo a send_voice ahora, con lo que ya sabés o recordás de la charla (no lo delegues, no avises antes que lo vas a grabar, no digas «te lo mando en audio»). Hablá siguiendo la guía de NOTAS DE VOZ y ${s.alsoText ? 'dejá solo una línea breve de texto' : 'dejá tu texto completamente vacío'}. Solo si para armar el audio necesitás buscar, investigar o hacer trabajo real, delegalo pidiéndole al sub agente que lo termine con send_voice: es el MISMO mecanismo que usás cuando te escriben por texto (respondés algo breve ya mismo y delegás la investigación), pero en audio. Mientras esperás, llamá vos mismo a send_voice con un audio corto y natural confirmando que te pusiste a averiguarlo (por ejemplo «dale, dejame revisar eso y en un toque te cuento» o «ya me pongo con eso»): habla como si charlaras, nunca como un anuncio del propio audio (nada de «te mando un audio» ni «te lo paso en nota de voz»). Cuando el sub agente te devuelva el resultado, respondé la respuesta final TAMBIÉN con send_voice. Los datos para copiar (enlaces, códigos, números) mandalos además por texto.]\n`;
    }
  } catch { /* nunca frena la charla */ }
  return '';
}

export const VOICE_TOOLS = ['mcp__kiri__send_voice'];
export function voiceNote() {
  const s = readSettings();
  const when = {
    asked: 'Mandá un audio SOLO cuando la persona lo pida («mandame un audio», «explicámelo hablando»…). Si no lo pide, respondé por texto.',
    mirror: 'Mandá un audio cuando la persona lo pida o cuando ella te escribe con una nota de voz (en su mensaje figura «mandó una nota de voz»): en ese caso respondele también con audio. Si te escribe por texto y no lo pidió, respondé por texto.',
    always: 'Preferí responder con audio en las charlas, salvo que la respuesta tenga datos para copiar, tablas o textos largos: eso va por texto.',
  }[s.mode];
  return `NOTAS DE VOZ: tenés la herramienta send_voice({text}), que convierte lo que escribas en un audio y lo envía junto con tu respuesta (máximo ${s.maxChars} caracteres por audio). ${when} ${s.alsoText ? 'Cuando mandes un audio, acompañalo con un mensaje de texto breve.' : 'Cuando mandes un audio, tu respuesta de texto debe quedar vacía o con una sola línea corta: no repitas por escrito lo que dice el audio.'}\nCÓMO HABLAR EN UN AUDIO:\n${s.guide}`;
}
