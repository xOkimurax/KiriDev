// Secretos que el agente usa pero que NO viven en su carpeta de trabajo (cookies para descargar de sitios que piden login).
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './db.js';

const DIR = path.join(DATA_DIR, 'secrets');
export const COOKIES_FILE = path.join(DIR, 'cookies.txt');

export function cookiesStatus() {
  if (!fs.existsSync(COOKIES_FILE)) return { configured: false };
  const st = fs.statSync(COOKIES_FILE);
  const lines = fs.readFileSync(COOKIES_FILE, 'utf8').split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  const domains = [...new Set(lines.map((l) => l.split('\t')[0].replace(/^\./, '')).filter(Boolean))].slice(0, 8);
  return { configured: true, updated: st.mtime.toISOString(), cookies: lines.length, domains };
}

/** Acepta el formato Netscape que exportan las extensiones tipo "Get cookies.txt LOCALLY". */
export function saveCookies(content) {
  const text = content.replace(/\r\n/g, '\n').trim();
  const rows = text.split('\n').filter((l) => l.trim() && !l.startsWith('#'));
  if (!rows.length || !rows.every((l) => l.split('\t').length >= 7))
    throw Object.assign(new Error('El texto no parece un cookies.txt en formato Netscape (cada línea debe tener 7 columnas separadas por tabulación). Exportalo con una extensión como "Get cookies.txt LOCALLY".'), { status: 400 });
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(COOKIES_FILE, (text.startsWith('# Netscape') ? text : `# Netscape HTTP Cookie File\n${text}`) + '\n', { mode: 0o600 });
  return cookiesStatus();
}

export const deleteCookies = () => fs.rmSync(COOKIES_FILE, { force: true });

// ---------- Groq (transcripción de audios): la clave se carga desde el panel; la variable GROQ_API_KEY del servidor queda como respaldo ----------
const GROQ_FILE = path.join(DIR, 'groq.key');
const GROQ_URL = () => process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1';
const panelGroqKey = () => { try { return fs.readFileSync(GROQ_FILE, 'utf8').trim(); } catch { return ''; } };
/** Clave en uso: primero la del panel, si no la del servidor (variable de entorno). */
export const groqKey = () => panelGroqKey() || String(process.env.GROQ_API_KEY || '').trim();
export function groqStatus() {
  const panel = panelGroqKey(), env = String(process.env.GROQ_API_KEY || '').trim(), k = panel || env;
  return { configured: !!k, source: panel ? 'panel' : env ? 'servidor' : null, hint: k ? `…${k.slice(-4)}` : null, serverKeyAlso: !!panel && !!env };
}
export function saveGroqKey(key) {
  const k = String(key || '').trim();
  if (!/^\S{20,300}$/.test(k)) throw Object.assign(new Error('La clave no parece válida (sin espacios; las de Groq empiezan con gsk_).'), { status: 400 });
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(GROQ_FILE, k + '\n', { mode: 0o600 });
  return groqStatus();
}
export function deleteGroqKey() { fs.rmSync(GROQ_FILE, { force: true }); return groqStatus(); }
/** Prueba real contra Groq con la clave en uso (o con una recién escrita, sin guardarla). Nunca devuelve la clave. */
export async function testGroq(candidate) {
  const k = String(candidate || '').trim() || groqKey();
  if (!k) return { ok: false, error: 'No hay ninguna clave de Groq cargada.' };
  const t0 = Date.now();
  try {
    const r = await fetch(`${GROQ_URL()}/models`, { headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(15000) });
    if (r.status === 401 || r.status === 403) return { ok: false, error: 'Groq rechazó la clave (inválida o revocada).' };
    if (!r.ok) return { ok: false, error: `Groq respondió ${r.status}.` };
    const ids = ((await r.json()).data || []).map((m) => m.id);
    return { ok: true, ms: Date.now() - t0, whisper: ids.some((i) => /whisper/i.test(i)) };
  } catch (e) { return { ok: false, error: `No se pudo conectar con Groq: ${e.message}` }; }
}
