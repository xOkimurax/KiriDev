// Apps del agente: contenedores que el agente levanta en SU Docker aislado (dind rootless, ver docs/OPERACION.md) y que se publican
// con una URL propia. Capas de control: función apagada por defecto · alcance por personalidad · aprobación por WhatsApp de cada
// publicación · topes de apps · acceso público u opcionalmente con el login del panel.
// El hub hace de proxy inverso por nombre de host: <slug><APPS_HOST_SUFFIX> → puerto publicado del contenedor dentro del dind.
// Hacia afuera no se abre ningún puerto nuevo: todo entra por el puerto del hub, igual que los paneles personales.
import { execFile } from 'node:child_process';
import http from 'node:http';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { db } from './db.js';
import { splitKey } from './accounts.js';
import { personaForKey, appliesTo, cleanPersonaIds } from './personas.js';
import * as outreach from './outreach.js';

db.exec(`CREATE TABLE IF NOT EXISTS apps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  owner TEXT NOT NULL,
  container TEXT NOT NULL,
  port INTEGER NOT NULL,
  host_port INTEGER,
  access TEXT NOT NULL DEFAULT 'public',
  description TEXT,
  status TEXT NOT NULL,
  approvers TEXT NOT NULL DEFAULT '[]',
  decided_by TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at TEXT,
  expires_at TEXT,
  last_hit TEXT,
  hits INTEGER NOT NULL DEFAULT 0
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_apps_status ON apps(status, id)');

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const sqlNow = (min = 0) => new Date(Date.now() + min * 60000).toISOString().slice(0, 19).replace('T', ' ');
const fromSql = (s) => Date.parse(`${String(s).replace(' ', 'T')}Z`);
const numOfKey = (key) => digits(splitKey(key).jid.split('@')[0]);
const isPrivateKey = (key) => splitKey(key).jid.endsWith('@s.whatsapp.net');
const preview = (t, n = 200) => { const x = String(t || '').replace(/\s+/g, ' ').trim(); return x.length > n ? `${x.slice(0, n)}…` : x; };
const nums = (a) => [...new Set((Array.isArray(a) ? a : String(a || '').split(/[\s,;]+/)).map(digits).filter((n) => n.length >= 6))].slice(0, 20);
const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : d));

// ---------- ajustes ----------
export const DEFAULTS = {
  enabled: false,
  personas: null,          // null = todas las personalidades; o un arreglo de ids
  approval: 'ask',         // 'ask' = cada publicación se aprueba por WhatsApp · 'direct' = se publica sin preguntar
  approvers: [],           // quién aprueba; vacío = quien lo pidió (si escribe por WhatsApp)
  notifyInstance: '',      // por qué línea se manda la solicitud ('' = la de quien lo pidió)
  approvalTtlMin: 120,
  maxApps: 8,              // apps publicadas a la vez (todas las personas)
  maxPerOwner: 3,          // apps publicadas a la vez por chat
  defaultAccess: 'public', // 'public' | 'login' (pide usuario y contraseña del panel)
};
export function readSettings() {
  const row = db.prepare("SELECT value FROM kv WHERE key = 'apps'").get();
  let v = {}; try { v = row ? JSON.parse(row.value) : {}; } catch { /* valores por defecto */ }
  return { ...DEFAULTS, ...v };
}
export function writeSettings(s) {
  const clean = {
    enabled: !!s.enabled, personas: cleanPersonaIds(s.personas), approval: s.approval === 'direct' ? 'direct' : 'ask',
    approvers: nums(s.approvers), notifyInstance: /^[a-z0-9_-]{0,40}$/i.test(String(s.notifyInstance || '')) ? String(s.notifyInstance || '') : '',
    approvalTtlMin: clamp(s.approvalTtlMin, 5, 2880, DEFAULTS.approvalTtlMin), maxApps: clamp(s.maxApps, 1, 50, DEFAULTS.maxApps),
    maxPerOwner: clamp(s.maxPerOwner, 1, 20, DEFAULTS.maxPerOwner), defaultAccess: s.defaultAccess === 'login' ? 'login' : 'public',
  };
  db.prepare("INSERT INTO kv (key, value) VALUES ('apps', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(clean));
  return readSettings();
}

// ---------- infraestructura ----------
// Sufijo del dominio de las apps, ej. ".apps.tudominio.com": la URL es <slug><sufijo>. Cloudflare solo admite comodines de etiqueta completa
// (*.dominio), así que el túnel manda al hub todo lo que no tenga una regla propia; el hub solo atiende los hosts con forma de slug (ver SLUG_RE).
const SUFFIX = () => String(process.env.APPS_HOST_SUFFIX || '').toLowerCase();
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,28}[a-z0-9])?-[a-f0-9]{6}$/;    // <nombre>-<6 hex>: lo que genera publish(); cualquier otro host sigue su camino normal
/** Hay un Docker al que conectarse y un dominio para las URLs (lo define el despliegue; sin eso la función no existe). */
export const available = () => !!process.env.DOCKER_HOST && !!SUFFIX();
const dockerHost = () => { try { return new URL(process.env.DOCKER_HOST).hostname; } catch { return ''; } };
const urlOf = (slug) => `https://${slug}${SUFFIX()}`;
const docker = (args, timeout = 20000) => new Promise((resolve, reject) => {
  execFile('docker', args, { timeout, maxBuffer: 4e6, env: process.env }, (e, out, err) => (e ? reject(new Error(String(err || e.message).trim().slice(0, 300))) : resolve(String(out))));
});
/** ¿La función está encendida para esta personalidad? (la usa el runner para darle o no Docker al sub agente) */
export function enabledFor(persona) { try { const s = readSettings(); return s.enabled && available() && appliesTo(s, persona); } catch { return false; } }
/** Variables que necesita el cliente de Docker del agente (el resto del entorno del hub NO se hereda). */
export const dockerEnv = () => Object.fromEntries(['DOCKER_HOST', 'DOCKER_TLS_VERIFY', 'DOCKER_CERT_PATH'].filter((k) => process.env[k]).map((k) => [k, process.env[k]]));

async function inspectContainer(container) {
  let out;
  try { out = await docker(['inspect', '--format', '{{.State.Running}}', container]); }
  catch { throw fail(`No existe el contenedor «${container}» en tu Docker. Mirá los nombres con «docker ps» y volvé a intentar.`); }
  if (out.trim() !== 'true') throw fail(`El contenedor «${container}» no está corriendo. Arrancalo y volvé a publicar.`);
}
async function hostPortOf(container, port) {
  let out;
  try { out = await docker(['port', container, `${port}/tcp`]); }
  catch { throw fail(`El puerto ${port} del contenedor «${container}» no está publicado. Creá o recreá el contenedor con «-p ${port}» (en compose: «ports: - "${port}"»), y publicá de nuevo.`); }
  const m = /:(\d+)\s*$/m.exec(out);
  if (!m) throw fail(`No pude saber en qué puerto quedó publicado el ${port} de «${container}».`);
  return Number(m[1]);
}

// ---------- quién aprueba ----------
const approversFor = (s, ownerKey) => [...new Set(s.approvers.length ? s.approvers : isPrivateKey(ownerKey) ? [numOfKey(ownerKey)] : [])];
const ownerLabel = (key) => (db.prepare('SELECT name FROM contacts WHERE jid = ?').get(key)?.name || (isPrivateKey(key) ? `+${numOfKey(key)}` : key.startsWith('playground:') ? 'Probar agente' : 'un grupo'));
const ACCESS_TXT = { public: 'pública (cualquiera con el enlace)', login: 'con usuario y contraseña del panel' };
const row = (id) => db.prepare('SELECT * FROM apps WHERE id = ?').get(id);
const shape = (r) => r && { id: r.id, slug: r.slug, name: r.name, owner: r.owner, owner_name: ownerLabel(r.owner), container: r.container, port: r.port, access: r.access, description: r.description, status: r.status,
  url: r.status === 'active' || r.status === 'pending' ? urlOf(r.slug) : null, created_at: r.created_at, decided_at: r.decided_at, decided_by: r.decided_by, expires_at: r.expires_at, last_hit: r.last_hit, hits: r.hits, approvers: JSON.parse(r.approvers || '[]') };

async function requestApproval(r, s) {
  const body = `🌐 *Aprobación de app #${r.id}* — publicar «${r.name}»\nLa pidió ${ownerLabel(r.owner)}${r.description ? `\nQué es: ${preview(r.description, 200)}` : ''}\nQuedaría en: ${urlOf(r.slug)}\nAcceso: ${ACCESS_TXT[r.access]}\n\nRespondé *sí* para publicarla o *no* para descartarla. Vence en ${Math.round((fromSql(r.expires_at) - Date.now()) / 60000)} min.`;
  let any = false;
  for (const n of JSON.parse(r.approvers || '[]')) any = (await outreach.tell(n, body, { notifyInstance: s.notifyInstance }, r.owner)) || any;
  return any;
}
async function notifyOwner(r, text, except) {
  if (!isPrivateKey(r.owner)) return;
  const n = numOfKey(r.owner); if (n === except) return;
  await outreach.tell(n, text, { notifyInstance: readSettings().notifyInstance }, r.owner);
}

// ---------- publicar y administrar ----------
const NAME_RE = /^[a-z0-9]([a-z0-9-]{0,28}[a-z0-9])?$/;
/** Herramienta publish_app. Devuelve el texto para el agente o lanza un error con el motivo. */
export async function publish(ownerKey, { name, container, port, access, description } = {}) {
  const s = readSettings();
  if (!available()) throw fail('Esta función no está disponible en este despliegue (falta el Docker aislado).', 503);
  if (!s.enabled || !appliesTo(s, personaForKey(ownerKey))) throw fail('Publicar apps no está activado para este chat.', 403);
  const nm = String(name || '').toLowerCase().trim().replace(/\s+/g, '-');
  if (!NAME_RE.test(nm)) throw fail('El nombre debe tener 1 a 30 caracteres: letras minúsculas, números y guiones (sin espacios).');
  const ct = String(container || '').trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,63}$/.test(ct)) throw fail('Nombre de contenedor inválido (usá el que muestra «docker ps»).');
  const pt = Number(port);
  if (!Number.isInteger(pt) || pt < 1 || pt > 65535) throw fail('El puerto es un número entre 1 y 65535 (el puerto de la app DENTRO del contenedor).');
  const same = db.prepare("SELECT * FROM apps WHERE owner = ? AND container = ? AND port = ? AND status IN ('pending','active')").get(ownerKey, ct, pt);
  if (same) return `Esa app ya está ${same.status === 'active' ? 'publicada' : 'pendiente de aprobación'}: ${urlOf(same.slug)}`;
  const live = (where, ...a) => db.prepare(`SELECT COUNT(*) AS c FROM apps WHERE status IN ('pending','active') ${where}`).get(...a).c;
  if (live('') >= s.maxApps) throw fail(`Ya hay ${s.maxApps} apps publicadas o pendientes (el tope). Despublicá alguna con unpublish_app o pedile al administrador que suba el tope.`);
  if (live('AND owner = ?', ownerKey) >= s.maxPerOwner) throw fail(`Ya tenés ${s.maxPerOwner} apps publicadas o pendientes (el tope por persona). Despublicá alguna con unpublish_app.`);
  await inspectContainer(ct);
  const hostPort = await hostPortOf(ct, pt);
  const acc = ['public', 'login'].includes(access) ? access : s.defaultAccess;
  const slug = `${nm}-${crypto.randomBytes(3).toString('hex')}`;
  const approvers = s.approval === 'ask' ? approversFor(s, ownerKey) : [];
  const id = db.prepare(`INSERT INTO apps (slug, name, owner, container, port, host_port, access, description, status, approvers, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(slug, nm, ownerKey, ct, pt, hostPort, acc, description ? String(description).slice(0, 300) : null, s.approval === 'direct' ? 'active' : 'pending', JSON.stringify(approvers), s.approval === 'direct' ? null : sqlNow(s.approvalTtlMin)).lastInsertRowid;
  if (s.approval === 'direct') return `Publicada: ${urlOf(slug)} (acceso: ${ACCESS_TXT[acc]}). Pasale este enlace COMPLETO a la persona.`;
  if (!approvers.length) return `Quedó pendiente de aprobación (#${id}), pero no hay nadie que pueda aprobarla por WhatsApp desde este chat: el administrador la aprueba desde el panel (sección Apps). Avisale a la persona en una frase; la URL será ${urlOf(slug)} cuando se apruebe.`;
  if (!(await requestApproval(row(id), s))) {
    db.prepare("UPDATE apps SET status = 'cancelled' WHERE id = ?").run(id);
    throw fail('No pude enviar la solicitud de aprobación por WhatsApp. Probá de nuevo en un rato.');
  }
  return `Quedó pendiente de aprobación (#${id}): ya se la pedí por WhatsApp a quien aprueba. NO digas que está publicada. Avisale a la persona, en una frase, que cuando se apruebe le llega el enlace por WhatsApp (será ${urlOf(slug)}). Acceso: ${ACCESS_TXT[acc]}.`;
}

/** Aprueba y publica. `by` = número de quien aprueba, o 'panel'. */
export async function approve(id, by) {
  const r = row(id);
  if (!r) throw fail('No existe esa solicitud.', 404);
  if (r.status !== 'pending') throw fail(`Esa solicitud ya está ${({ active: 'publicada', rejected: 'descartada', expired: 'vencida', cancelled: 'cancelada', removed: 'despublicada' })[r.status] || r.status}.`, 409);
  if (fromSql(r.expires_at) < Date.now()) { db.prepare("UPDATE apps SET status = 'expired' WHERE id = ?").run(id); throw fail('Esa solicitud venció.', 409); }
  try { await inspectContainer(r.container); db.prepare('UPDATE apps SET host_port = ? WHERE id = ?').run(await hostPortOf(r.container, r.port), id); }
  catch (e) { throw fail(`No se pudo publicar: ${e.message}`, 409); }
  const claimed = db.prepare("UPDATE apps SET status = 'active', decided_by = ?, decided_at = datetime('now'), expires_at = NULL WHERE id = ? AND status = 'pending'").run(String(by), id).changes;
  if (!claimed) throw fail('Esa solicitud ya se está procesando.', 409);
  const url = urlOf(r.slug);
  await notifyOwner(r, `✅ Tu app «${r.name}» ya está publicada: ${url}\nAcceso: ${ACCESS_TXT[r.access]}.`, by);
  return { id, name: r.name, url };
}
export async function reject(id, by) {
  const r = row(id);
  if (!r) throw fail('No existe esa solicitud.', 404);
  if (r.status !== 'pending') throw fail('Esa solicitud ya no está pendiente.', 409);
  db.prepare("UPDATE apps SET status = 'rejected', decided_by = ?, decided_at = datetime('now') WHERE id = ?").run(String(by), id);
  await notifyOwner(r, `🚫 No se publicó tu app «${r.name}»: la descartó ${by === 'panel' ? 'el panel' : `+${by}`}.`, by);
  return { id, name: r.name };
}
/** Despublica (el contenedor sigue en el Docker del agente; solo se cierra la URL). `ownerKey` = null cuando lo hace el panel. */
export function unpublish(ownerKey, ref) {
  const q = String(ref ?? '').trim().toLowerCase();
  const r = db.prepare("SELECT * FROM apps WHERE status IN ('pending','active') AND (id = ? OR slug = ? OR name = ?) AND (? IS NULL OR owner = ?) ORDER BY id DESC").get(Number(q) || -1, q, q, ownerKey, ownerKey);
  if (!r) throw fail(`No encontré una app tuya publicada o pendiente que se llame «${q}». Mirá list_apps.`, 404);
  db.prepare("UPDATE apps SET status = 'removed', decided_at = datetime('now') WHERE id = ?").run(r.id);
  return { id: r.id, name: r.name };
}
export function listFor(ownerKey) {
  const rows = db.prepare("SELECT * FROM apps WHERE owner = ? AND status IN ('pending','active') ORDER BY id").all(ownerKey).map(shape);
  return rows.length ? rows.map((a) => `#${a.id} «${a.name}» [${a.status === 'active' ? 'publicada' : 'pendiente de aprobación'}] contenedor ${a.container}:${a.port} — ${a.url} (${ACCESS_TXT[a.access]})`).join('\n') : 'No tenés apps publicadas.';
}

// "sí" / "no" desde WhatsApp: se resuelve sin pasar por el modelo
const YES = /^(s[ií]|dale|ok|okey|okay|aprobad[oa]|aprobar|publicar(la)?|public[aá]la|listo|✅|👍)$/i;
const NO = /^(no|cancelar(la)?|cancel[aá]la|rechaz[aá]r?(la)?|descart[aá]r?(la)?|❌|👎)$/i;
const pendingFor = (number) => db.prepare("SELECT * FROM apps WHERE status = 'pending' AND expires_at > ? ORDER BY id").all(sqlNow()).filter((r) => JSON.parse(r.approvers || '[]').includes(number));
/** Si este mensaje es la respuesta de un aprobador a una solicitud de app pendiente, la resuelve y devuelve el texto de respuesta; si no, null. */
export async function handleDecision(key, evt) {
  try {
    if (evt.kind && evt.kind !== 'text') return null;
    const m = /^\s*(\S+?)[\s.!,]*(?:#?(\d{1,9}))?[\s.!]*$/.exec(String(evt.text ?? evt.message ?? ''));
    if (!m || !isPrivateKey(key)) return null;
    const w = m[1].normalize('NFC'), yes = YES.test(w), no = NO.test(w);
    if (!yes && !no) return null;
    const me = numOfKey(key), mine = pendingFor(me);
    if (!mine.length) return null;
    let r;
    if (m[2]) r = mine.find((x) => x.id === Number(m[2]));
    else {
      const recent = db.prepare('SELECT content FROM messages WHERE jid = ? ORDER BY id DESC LIMIT 4').all(key).map((x) => x.content).join('\n');
      r = mine.filter((x) => recent.includes(`Aprobación de app #${x.id}`)).sort((a, b) => b.id - a.id)[0];
    }
    if (!r) return null; // «sí» suelto sin una solicitud de app reciente: puede ser charla común, o una aprobación de mensajes (la maneja outreach)
    db.prepare("INSERT INTO messages (jid, role, content) VALUES (?, 'user', ?)").run(key, String(evt.text ?? evt.message ?? '').slice(0, 200));
    let reply;
    try {
      if (yes) { const o = await approve(r.id, me); reply = `✅ Publicada «${o.name}»: ${o.url}`; }
      else { const o = await reject(r.id, me); reply = `🚫 Descartada «${o.name}» (no se publicó).`; }
    } catch (e) { reply = `No se pudo: ${e.message}`; }
    db.prepare("INSERT INTO messages (jid, role, content) VALUES (?, 'assistant', ?)").run(key, reply);
    return reply;
  } catch (e) { console.error(`[apps] decisión: ${e.message}`); return null; }
}

// ---------- panel ----------
let psCache = { at: 0, v: null };
async function runningSet() {
  try { return new Set((await docker(['ps', '--format', '{{.Names}}'], 8000)).split('\n').map((x) => x.trim()).filter(Boolean)); } catch { return null; }
}
/** Todas las apps (para el panel) con si su contenedor sigue corriendo. */
export async function listAll({ status } = {}) {
  const run = available() ? await runningSet() : null;
  return db.prepare(`SELECT * FROM apps ${status ? 'WHERE status = ?' : ''} ORDER BY id DESC LIMIT 200`).all(...(status ? [status] : [])).map((r) => ({ ...shape(r), running: run ? run.has(r.container) : null }));
}
/** Estado del Docker del agente: si responde, cuántos contenedores corren y cuánto ocupa. */
export async function dockerStatus() {
  if (!available()) return { configured: false, reachable: false };
  if (Date.now() - psCache.at < 10000 && psCache.v) return psCache.v;
  let v;
  try {
    const run = await runningSet();
    const df = (await docker(['system', 'df', '--format', '{{json .}}'], 15000)).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    v = { configured: true, reachable: !!run, running: run ? run.size : 0, df: df.map((d) => ({ type: d.Type, total: Number(d.TotalCount), active: Number(d.Active), size: d.Size, reclaimable: d.Reclaimable })) };
  } catch (e) { v = { configured: true, reachable: false, error: e.message }; }
  psCache = { at: Date.now(), v };
  return v;
}
/** Libera espacio en el Docker del agente: contenedores parados, imágenes sin uso y caché de build con más de `hours` horas. */
export async function prune(hours = 72) {
  if (!available()) throw fail('Esta función no está disponible en este despliegue.', 503);
  const f = ['--filter', `until=${Math.max(1, Math.floor(hours))}h`];
  const out = [];
  for (const args of [['container', 'prune', '-f', ...f], ['image', 'prune', '-af', ...f], ['builder', 'prune', '-f', ...f]]) out.push(await docker(args, 120000).catch((e) => `error: ${e.message}`));
  psCache = { at: 0, v: null };
  return { ok: true, detail: out.map((o) => o.trim().split('\n').pop()).join(' · ') };
}

// ---------- proxy por nombre de host ----------
const hostOf = (req) => String(req.headers.host || '').toLowerCase().split(':')[0];
const hubHosts = () => new Set([process.env.HUB_BASE_URL, process.env.HUB_PUBLIC_URL].map((u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ''; } }).filter(Boolean));
const slugOf = (host) => { const sfx = SUFFIX(); if (!sfx || !host.endsWith(sfx)) return null; const slug = host.slice(0, -sfx.length); return SLUG_RE.test(slug) ? slug : null; };
const pageHtml = (title, msg, extra = '') => `<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${title}</title>
<style>:root{color-scheme:light dark}body{font:16px/1.5 system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;padding:16px;background:Canvas;color:CanvasText}main{max-width:380px;width:100%}h1{font-size:20px;margin:0 0 8px}p{margin:0 0 16px;opacity:.75}input,button{font:inherit;width:100%;box-sizing:border-box;padding:10px 12px;margin:0 0 10px;border-radius:8px;border:1px solid #8885;background:transparent;color:inherit}button{background:#2563eb;color:#fff;border:0;cursor:pointer}.err{color:#dc2626;opacity:1}</style>
<main><h1>${title}</h1><p>${msg}</p>${extra}</main></html>`;
const send = (res, code, html) => res.status(code).set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex' }).end(html);

const GATE_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const sign = (slug, exp) => crypto.createHmac('sha256', GATE_SECRET).update(`gate|${slug}|${exp}`).digest('hex');
const gateCookie = (slug) => { const exp = Date.now() + 12 * 3600e3; return `${exp}.${sign(slug, exp)}`; };
function gateOk(req, slug) {
  const m = /(?:^|;\s*)kiri_gate=([\d]+)\.([a-f0-9]{64})/.exec(req.headers.cookie || '');
  if (!m || Number(m[1]) < Date.now()) return false;
  const a = Buffer.from(m[2]), b = Buffer.from(sign(slug, m[1]));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
const stripGate = (cookie) => (cookie ? cookie.split(/;\s*/).filter((c) => !c.startsWith('kiri_gate=')).join('; ') : cookie) || undefined;
const attempts = new Map();

function readForm(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (d) => { b += d; if (b.length > 4096) req.destroy(); });
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(b))));
    req.on('error', () => resolve({}));
  });
}
const hit = (r) => { // cuenta el uso sin escribir en cada pedido
  const now = Date.now(); if (now - (hit.last.get(r.id) || 0) < 30000) return; hit.last.set(r.id, now);
  db.prepare("UPDATE apps SET hits = hits + 1, last_hit = datetime('now') WHERE id = ?").run(r.id);
};
hit.last = new Map();

const activeBySlug = (slug) => db.prepare("SELECT * FROM apps WHERE slug = ? AND status = 'active'").get(slug);
async function refreshPort(r) { try { db.prepare('UPDATE apps SET host_port = ? WHERE id = ?').run(await hostPortOf(r.container, r.port), r.id); } catch { /* el contenedor ya no está: se verá en el panel */ } }
function fwdHeaders(req) {
  const h = { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress, 'x-forwarded-proto': 'https', 'x-forwarded-host': req.headers.host };
  const cookie = stripGate(req.headers.cookie); // la cookie del acceso con login es del hub: la app no la ve
  if (cookie) h.cookie = cookie; else delete h.cookie;
  return h;
}

/** Middleware de Express: si el pedido es para <slug><sufijo>, lo atiende (proxy o página de error); si no, sigue con el hub. */
export function middleware(req, res, next) {
  const host = hostOf(req), slug = slugOf(host);
  if (!slug) {
    // el comodín del túnel manda acá cualquier subdominio sin regla propia: lo que no es una app ni el propio hub no existe (y no debe mostrar el panel)
    if (SUFFIX() && host.endsWith(SUFFIX()) && !hubHosts().has(host)) return send(res, 404, pageHtml('No existe', 'Esta dirección no existe.'));
    return next();
  }
  serve(req, res, slug).catch((e) => { console.error(`[apps] ${e.message}`); if (!res.headersSent) send(res, 500, pageHtml('Error', 'Algo falló al abrir la app.')); });
}
async function serve(req, res, slug) {
  const s = readSettings(), r = activeBySlug(slug);
  if (!s.enabled || !available() || !r) return send(res, 404, pageHtml('App no disponible', 'Esta dirección no existe o la app ya no está publicada.'));
  if (r.access === 'login' && !gateOk(req, slug)) {
    if (req.method === 'POST' && req.url.split('?')[0] === '/__kiri_login') {
      const ip = req.ip, a = attempts.get(ip) || { n: 0, t: Date.now() };
      if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
      if (a.n >= 8) return send(res, 429, pageHtml('Demasiados intentos', 'Probá de nuevo en unos minutos.'));
      const f = await readForm(req), u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(f.username || ''));
      if (!u || !bcrypt.compareSync(String(f.password || ''), u.password_hash)) { attempts.set(ip, { ...a, n: a.n + 1 }); return send(res, 401, loginPage('<p class="err">Usuario o contraseña incorrectos.</p>')); }
      attempts.delete(ip);
      res.cookie?.('kiri_gate', gateCookie(slug), { httpOnly: true, sameSite: 'lax', secure: true, maxAge: 12 * 3600e3 });
      return res.status(303).set({ Location: '/', 'Cache-Control': 'no-store' }).end();
    }
    return send(res, 401, loginPage(''));
  }
  hit(r);
  const up = http.request({ host: dockerHost(), port: r.host_port, method: req.method, path: req.url, headers: fwdHeaders(req), timeout: 60000 }, (pr) => {
    res.writeHead(pr.statusCode, { ...pr.headers, 'x-robots-tag': 'noindex' });
    pr.pipe(res);
  });
  up.on('timeout', () => up.destroy(new Error('timeout')));
  up.on('error', () => { refreshPort(r); if (!res.headersSent) send(res, 502, pageHtml('La app no responde', 'El contenedor no contestó. Puede estar arrancando o apagado; probá de nuevo en un momento.')); else res.destroy(); });
  req.pipe(up);
}
const loginPage = (err) => pageHtml('App privada', 'Ingresá con tu usuario y contraseña del panel de Kiri Hub.', `${err}<form method="post" action="/__kiri_login"><input name="username" placeholder="Usuario" autocomplete="username" required><input name="password" type="password" placeholder="Contraseña" autocomplete="current-password" required><button>Entrar</button></form>`);

/** WebSocket (y cualquier Upgrade) hacia las apps. Se engancha al servidor HTTP. */
export function upgrade(req, socket, head) {
  const slug = slugOf(hostOf(req)), r = slug && readSettings().enabled && available() ? activeBySlug(slug) : null;
  if (!r || (r.access === 'login' && !gateOk(req, slug))) return socket.destroy();
  hit(r);
  const up = http.request({ host: dockerHost(), port: r.host_port, method: req.method, path: req.url, headers: fwdHeaders(req) });
  up.on('upgrade', (pr, ps, ph) => {
    let h = `HTTP/1.1 101 Switching Protocols\r\n`;
    for (let i = 0; i < pr.rawHeaders.length; i += 2) h += `${pr.rawHeaders[i]}: ${pr.rawHeaders[i + 1]}\r\n`;
    socket.write(`${h}\r\n`); if (ph?.length) socket.write(ph);
    ps.pipe(socket).pipe(ps);
    ps.on('error', () => socket.destroy()); socket.on('error', () => ps.destroy());
  });
  up.on('response', () => socket.destroy());
  up.on('error', () => socket.destroy());
  if (head?.length) up.write(head);
  up.end();
}

// ---------- mantenimiento ----------
export async function sweep() {
  for (const r of db.prepare("SELECT * FROM apps WHERE status = 'pending' AND expires_at <= ?").all(sqlNow())) {
    db.prepare("UPDATE apps SET status = 'expired', decided_at = datetime('now') WHERE id = ? AND status = 'pending'").run(r.id);
    await notifyOwner(r, `⌛ Venció sin respuesta la aprobación de la app «${r.name}»: no se publicó.`, null).catch(() => {});
  }
  hit.last.clear();
}
setInterval(() => { sweep().catch((e) => console.error(`[apps] limpieza: ${e.message}`)); }, 60000).unref();
// limpieza automática del Docker del agente (lo viejo y sin uso), para que no llene su volumen
setInterval(() => { if (available() && readSettings().enabled) prune(72).catch(() => {}); }, 6 * 3600e3).unref();
