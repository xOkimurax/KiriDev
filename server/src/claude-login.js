// Iniciar sesión en Claude Code desde el panel (sin entrar al servidor). `claude auth login` imprime un enlace y espera el código que muestra
// la página de Anthropic al autorizar: el panel muestra el enlace, recibe el código y se lo pasa. La sesión queda guardada en el volumen (/data/home).
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { db } from './db.js';
import { HOME_DIR } from './persona.js';

const BIN = () => process.env.CLAUDE_BIN || 'claude';
const kvGet = (k) => db.prepare('SELECT value FROM kv WHERE key = ?').get(k)?.value;
const kvSet = (k, v) => db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(k, v);
/** ¿Se eligió usar la sesión iniciada desde el panel en lugar de la clave de acceso de la configuración del servidor? */
export const usePanelLogin = () => kvGet('claude_use_login') === '1';
export const setUsePanelLogin = (on) => kvSet('claude_use_login', on ? '1' : '0');

// sin la clave del servidor: así se ve la sesión propia del panel, no la de la variable de entorno
const cleanEnv = () => ({ PATH: process.env.PATH || '', HOME: HOME_DIR, LANG: 'C.UTF-8', BROWSER: 'true', DISABLE_TELEMETRY: '1', CLAUDE_CODE_DISABLE_AUTOUPDATE: '1' });
const run = (args, ms = 25000) => new Promise((resolve) => {
  const c = spawn(BIN(), args, { env: cleanEnv(), cwd: HOME_DIR, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = ''; const t = setTimeout(() => { c.kill('SIGKILL'); resolve({ out, code: -1 }); }, ms);
  c.stdout.on('data', (d) => { if (out.length < 20000) out += d; });
  c.stderr.on('data', (d) => { if (out.length < 20000) out += d; });
  c.on('close', (code) => { clearTimeout(t); resolve({ out, code }); });
  c.on('error', () => { clearTimeout(t); resolve({ out, code: -1 }); });
});
const strip = (t) => String(t).replace(/\x1b\]8;[^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r/g, '');

/** Estado de la sesión del panel (no incluye datos secretos). */
export async function claudeAuthStatus() {
  const { out } = await run(['auth', 'status', '--json']);
  let s = {}; try { s = JSON.parse(strip(out)); } catch { /* sin sesión o error */ }
  return { loggedIn: !!s.loggedIn, method: s.authMethod || null, email: s.email || null, plan: s.subscriptionType || null, org: s.orgName || null, tokenInEnv: !!process.env.CLAUDE_CODE_OAUTH_TOKEN || !!process.env.ANTHROPIC_API_KEY, usePanelLogin: usePanelLogin() };
}

let pending = null; // un solo inicio de sesión a la vez
const killPending = () => { if (pending?.child) { try { pending.child.kill('SIGKILL'); } catch { /* ya terminó */ } } pending = null; };
/** Arranca el inicio de sesión y devuelve el enlace que la persona tiene que abrir. mode: 'claudeai' (suscripción) | 'console' (facturación por API). */
export async function startLogin({ mode = 'claudeai' } = {}) {
  killPending();
  const child = spawn(BIN(), ['auth', 'login', mode === 'console' ? '--console' : '--claudeai'], { env: cleanEnv(), cwd: HOME_DIR, stdio: ['pipe', 'pipe', 'pipe'] });
  const p = pending = { id: crypto.randomUUID(), child, out: '', url: null, closed: false, code: null };
  const take = (d) => { p.out += d; if (!p.url) p.url = /https:\/\/[^\s\x1b]+?(?:authorize|oauth)[^\s\x1b]*/.exec(strip(p.out))?.[0] || null; };
  child.stdout.on('data', take); child.stderr.on('data', take);
  child.on('close', (code) => { p.closed = true; p.code = code; });
  child.on('error', (e) => { p.closed = true; p.out += e.message; });
  setTimeout(() => { if (pending === p) killPending(); }, 10 * 60e3).unref(); // el enlace vale unos minutos
  for (let i = 0; i < 60 && !p.url && !p.closed; i++) await new Promise((r) => setTimeout(r, 250));
  if (!p.url) { const msg = strip(p.out).trim().slice(0, 300) || 'Claude Code no devolvió un enlace de inicio de sesión'; killPending(); throw Object.assign(new Error(msg), { status: 502 }); }
  return { id: p.id, url: p.url, expires_in_min: 10 };
}
/** Entrega el código que mostró la página de Anthropic y espera el resultado. */
export async function submitCode(id, code) {
  const p = pending;
  if (!p || p.id !== id || p.closed) throw Object.assign(new Error('El inicio de sesión venció o no está en curso. Empezá de nuevo.'), { status: 409 });
  const c = String(code || '').trim();
  if (!/^[\w\-#.~%+=/]{10,400}$/.test(c)) throw Object.assign(new Error('Ese código no parece válido: copialo completo desde la página de Anthropic.'), { status: 400 });
  p.child.stdin.write(`${c}\n`);
  for (let i = 0; i < 160 && !p.closed; i++) await new Promise((r) => setTimeout(r, 250));
  const text = strip(p.out).split('\n').map((l) => l.trim()).filter((l) => l && !/https:\/\/|Opening browser|Paste code|visit:/i.test(l)).slice(-3).join(' ').trim(); // lo que dijo Claude Code después del código (sin repetir el enlace)
  if (!p.closed) { killPending(); throw Object.assign(new Error('Claude Code no respondió al código a tiempo. Probá de nuevo.'), { status: 504 }); }
  pending = null;
  const status = await claudeAuthStatus();
  if (p.code === 0 && status.loggedIn) { setUsePanelLogin(true); return { ok: true, status: { ...status, usePanelLogin: true } }; }
  throw Object.assign(new Error(`No se pudo iniciar sesión: ${text.slice(0, 220) || 'código rechazado'}`), { status: 400 });
}
export async function claudeLogout() { killPending(); await run(['auth', 'logout']); setUsePanelLogin(false); return claudeAuthStatus(); }
