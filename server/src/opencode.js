// Motor OpenCode: el MISMO rol que Claude Code (coordinador o sub agente) ejecutado con `opencode run`.
// Recibe lo que agent.js ya preparó (instrucciones, herramientas permitidas, MCPs) y lo traduce al formato de OpenCode.
// Aislado como Claude: HOME y carpetas XDG propias dentro de /data/opencode, sin los secretos del hub.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DATA_DIR } from './db.js';
import { AGENT_DIR } from './persona.js';
import { WORK_DIR, INBOX } from './media.js';

export const OPENCODE_HOME = path.join(DATA_DIR, 'opencode');
export const DEFAULT_OC_MODEL = 'opencode/big-pickle';
const APP_DIR = path.join(OPENCODE_HOME, 'app'); // copia actualizada desde el panel (vive en el volumen: sobrevive a los despliegues)
const UPDATED_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'opencode');
const BIN = () => process.env.OPENCODE_BIN || (fs.existsSync(UPDATED_BIN) ? UPDATED_BIN : 'opencode');
const ENV_KEEP = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'NODE_ENV', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
/** Entorno del proceso de OpenCode: casa propia y nada de los secretos del hub. */
export const ocEnv = (extra = {}) => ({
  ...Object.fromEntries(ENV_KEEP.filter((k) => process.env[k] != null).map((k) => [k, process.env[k]])),
  HOME: OPENCODE_HOME, XDG_CONFIG_HOME: path.join(OPENCODE_HOME, 'config'), XDG_DATA_HOME: path.join(OPENCODE_HOME, 'data'),
  XDG_CACHE_HOME: path.join(OPENCODE_HOME, 'cache'), XDG_STATE_HOME: path.join(OPENCODE_HOME, 'state'), OPENCODE_DISABLE_AUTOUPDATE: '1', ...extra,
});
export function initOpencodeDir() { for (const d of ['config', 'data', 'cache', 'state']) fs.mkdirSync(path.join(OPENCODE_HOME, d), { recursive: true }); }

export const opencodeInstalled = () => { try { return spawnSync(BIN(), ['--version'], { env: ocEnv(), timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).status === 0; } catch { return false; } };
export const normModel = (m) => (/^[\w.-]+\/.+/.test(String(m || '')) ? String(m) : DEFAULT_OC_MODEL);

// ---------- traducciones Claude → OpenCode ----------
/** Herramientas de Claude que el administrador habilitó → permisos de OpenCode. */
const TOOL_PERM = { Bash: 'bash', WebSearch: 'websearch', WebFetch: 'webfetch', Glob: 'glob', Grep: 'grep', Write: 'edit', Edit: 'edit', NotebookEdit: 'edit', Task: 'task', Skill: 'skill' };
const BUILTIN = ['bash', 'edit', 'webfetch', 'websearch', 'task', 'skill', 'glob', 'grep', 'list', 'patch', 'lsp', 'todowrite', 'todoread', 'codesearch'];
export function buildPermission({ sub, allowedTools = [], fileToolsDenied = [], inboxDir }) {
  const allow = new Set(sub ? allowedTools.map((t) => TOOL_PERM[String(t).replace(/\(.*$/, '')]).filter(Boolean) : []);
  const perm = {};
  for (const k of BUILTIN) perm[k] = allow.has(k) ? 'allow' : 'deny';
  // leer: solo lo que la persona mandó (igual que Read(inbox) en Claude); salvo que el administrador haya habilitado Read completo
  const fullRead = sub && allowedTools.some((t) => t === 'Read');
  perm.read = fullRead ? 'allow' : { '*': 'deny', [`${inboxDir}/**`]: 'allow' };
  perm.external_directory = { '*': 'deny', [`${INBOX}/**`]: 'allow', ...(sub ? { [`${WORK_DIR}/**`]: 'allow' } : {}) };
  for (const t of fileToolsDenied) perm[t] = 'deny'; // herramientas de Kiri que el coordinador no tiene (archivos): nombre `kiri_<herramienta>`
  return perm;
}
/** Formato `mcpServers` de Claude → `mcp` de OpenCode. */
export function toOpencodeMcp(servers) {
  const out = {};
  for (const [name, s] of Object.entries(servers || {})) {
    out[name] = s.command
      ? { type: 'local', command: [s.command, ...(s.args || [])], ...(s.env && Object.keys(s.env).length ? { environment: s.env } : {}), enabled: true, timeout: 60000 }
      : { type: 'remote', url: s.url, ...(s.headers && Object.keys(s.headers).length ? { headers: s.headers } : {}), enabled: true };
  }
  return out;
}

/** Lee los eventos JSON de `opencode run`: texto final (el del último paso), sesión, costo y errores. */
export function parseEvents(raw) {
  let sid = null, cur = '', final = '', cost = 0, error = null, steps = 0, maxed = false, tokens = 0;
  for (const line of String(raw).split('\n')) {
    let e; try { e = JSON.parse(line); } catch { continue; }
    sid = sid || e.sessionID || null;
    const p = e.part || {};
    if (e.type === 'step_start') cur = '';
    else if (e.type === 'text') cur += (cur && !/\s$/.test(cur) ? '\n' : '') + (p.text || '');
    else if (e.type === 'step_finish') { steps++; cost += Number(p.cost) || 0; tokens += p.tokens?.total || 0; if (p.reason !== 'tool-calls') final = cur; cur = ''; if (p.reason === 'length') maxed = true; }
    else if (e.type === 'error') error = e.error?.data?.message || e.error?.message || e.error?.name || 'error desconocido';
  }
  if (!final && cur) final = cur; // por si el proceso se cortó antes del último step_finish
  return { text: final.trim(), session: sid, cost, error, steps, tokens, maxed };
}

/**
 * Ejecuta un turno. `p`: { c, message, settings, systemPrompt, sub, tools: { allowed, fileDenied }, mcp, runDir, cleanRun, opts, inboxDir }
 * Devuelve { text, cost, ms, session, truncated? } o lanza con el motivo real.
 */
export function runOpencode(p) {
  const { c, message, settings, systemPrompt, sub, mcp, opts = {}, inboxDir } = p;
  if (!opencodeInstalled()) { p.cleanRun?.(); return Promise.reject(new Error('OpenCode no está instalado en este servidor.')); }
  initOpencodeDir();
  const tmp = path.join(DATA_DIR, 'runs', `oc-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(tmp, { recursive: true });
  const instr = path.join(tmp, 'instrucciones.md');
  fs.writeFileSync(instr, systemPrompt); // se SUMA a las instrucciones base de OpenCode (reemplazarlas hace que la capa gratuita rechace el pedido)
  const model = normModel(settings.model);
  const config = {
    $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', model,
    instructions: [instr],
    permission: buildPermission({ sub, allowedTools: p.tools.allowed, fileToolsDenied: p.tools.fileDenied, inboxDir }),
    mcp: toOpencodeMcp(mcp),
    agent: { build: { steps: Math.max(1, Number(settings.maxTurns) || 15) } },
  };
  const sessionId = !sub && c.oc_session ? c.oc_session : null;
  const variant = /^[\w-]{1,20}$/.test(String(settings.variant || '')) ? settings.variant : null; // nivel de razonamiento del modelo (low/high/max…)
  const args = ['run', '--format', 'json', '--auto', '--model', model, ...(variant ? ['--variant', variant] : []), ...(sessionId ? ['--session', sessionId] : []), message];
  const cleanAll = () => { p.cleanRun?.(); fs.rmSync(tmp, { recursive: true, force: true }); };
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(BIN(), args, { cwd: p.runDir || AGENT_DIR, env: ocEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify(config), ...(p.dockerEnv || {}) }), stdio: ['ignore', 'pipe', 'pipe'] }); // sin entrada: si no, OpenCode espera que se cierre
    opts.onChild?.(child);
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); cleanAll(); reject(new Error('Timeout esperando a OpenCode')); }, settings.timeoutSec * 1000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); cleanAll(); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer); cleanAll();
      const r = parseEvents(out);
      if (r.error) return reject(Object.assign(new Error(r.error), { engine: 'opencode', session: r.session }));
      if (code !== 0 && !r.text) return reject(new Error((err || `OpenCode terminó con código ${code}`).slice(0, 500)));
      if (!r.text && r.steps >= (Number(settings.maxTurns) || 15)) return resolve({ text: '', truncated: true, cost: r.cost, ms: Date.now() - started, session: r.session });
      if (sub) deleteOcSession(r.session); // la tarea ya guardó su resultado: su sesión no se reutiliza
      resolve({ text: r.text, cost: r.cost || null, tokens: r.tokens || null, ms: Date.now() - started, session: sub ? null : r.session, engine: 'opencode' });
    });
  });
}

/** Llamada corta SIN herramientas (clasificar, resumir, reescribir) con un modelo de OpenCode; por defecto uno gratuito. */
export function askOpencode(prompt, { timeoutMs = 90000, ocModel = DEFAULT_OC_MODEL } = {}) {
  if (!opencodeInstalled()) return Promise.reject(new Error('OpenCode no está instalado en este servidor.'));
  initOpencodeDir();
  // la capa gratuita rechaza (403) los pedidos SIN ninguna herramienta disponible: se deja solo `read`, acotado a una carpeta vacía propia
  const empty = path.join(OPENCODE_HOME, 'vacio'); fs.mkdirSync(empty, { recursive: true });
  const perm = {}; for (const k of BUILTIN) perm[k] = 'deny';
  perm.read = { '*': 'deny', [`${empty}/**`]: 'allow' }; perm.external_directory = 'deny';
  const cfg = { $schema: 'https://opencode.ai/config.json', autoupdate: false, share: 'disabled', model: ocModel, permission: perm };
  return new Promise((resolve, reject) => {
    const child = spawn(BIN(), ['run', '--format', 'json', '--model', ocModel, prompt], { cwd: empty, env: ocEnv({ OPENCODE_CONFIG_CONTENT: JSON.stringify(cfg) }), stdio: ['ignore', 'pipe', 'ignore'] });
    let out = ''; const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
    child.stdout.on('data', (d) => (out += d));
    child.on('close', () => { clearTimeout(t); const r = parseEvents(out); r.error ? reject(new Error(r.error)) : r.text ? resolve(r.text.trim()) : reject(new Error('OpenCode no devolvió texto')); });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

/** Borra una sesión de OpenCode (al reiniciar la memoria, borrar el chat o terminar una tarea). Mejor esfuerzo: nunca lanza. */
export function deleteOcSession(id) {
  if (!id || !/^ses_\w+$/.test(String(id))) return;
  try { spawn(BIN(), ['session', 'delete', String(id)], { env: ocEnv(), stdio: 'ignore', cwd: OPENCODE_HOME }).on('error', () => {}); } catch { /* sin OpenCode: nada que borrar */ }
}

// ---------- lista de modelos (lo que muestra `opencode models`) ----------
let cache = null;
export async function listOpencodeModels({ refresh = false } = {}) {
  if (!refresh && cache && Date.now() - cache.at < 600e3) return cache.data;
  if (!opencodeInstalled()) return { installed: false, models: [] };
  initOpencodeDir();
  const out = await new Promise((resolve) => {
    const child = spawn(BIN(), ['models', '--verbose', ...(refresh ? ['--refresh'] : [])], { env: ocEnv(), stdio: ['ignore', 'pipe', 'ignore'], cwd: OPENCODE_HOME });
    let o = ''; const t = setTimeout(() => { child.kill('SIGKILL'); resolve(o); }, 60000);
    child.stdout.on('data', (d) => { if (o.length < 8e6) o += d; });
    child.on('close', () => { clearTimeout(t); resolve(o); });
    child.on('error', () => { clearTimeout(t); resolve(o); });
  });
  const models = [];
  const blocks = out.split(/^([\w.-]+\/\S+)\s*$/m); // [ruido, id, json, id, json…]
  for (let i = 1; i < blocks.length; i += 2) {
    let j; try { j = JSON.parse(blocks[i + 1]); } catch { continue; }
    const free = j.providerID === 'opencode' && !!j.cost && j.cost.input === 0 && j.cost.output === 0; // «Gratis» = los modelos gratuitos de OpenCode Zen (en otros proveedores costo 0 no significa gratis)
    const ctx = j.limit?.context ? `${j.limit.context >= 1e6 ? `${Math.round(j.limit.context / 1e5) / 10}M` : `${Math.round(j.limit.context / 1000)}k`} de contexto` : '';
    models.push({ value: blocks[i], label: `${j.name || j.id}${free ? ' · Gratis' : ''}`, description: [j.providerID, ctx, j.capabilities?.toolcall === false ? 'sin herramientas' : '', j.capabilities?.reasoning ? 'razona' : ''].filter(Boolean).join(' · '), group: free ? 'Gratis (OpenCode Zen)' : j.providerID, free, variants: Object.keys(j.variants || {}), tools: j.capabilities?.toolcall !== false, provider: j.providerID });
  }
  models.sort((a, b) => (b.free - a.free) || a.group.localeCompare(b.group) || a.label.localeCompare(b.label));
  const data = { installed: true, source: 'opencode', models };
  if (models.length) cache = { at: Date.now(), data };
  return data;
}
export const clearModelCache = () => { cache = null; };

// ---------- versión y actualización ----------
export function opencodeVersion() { try { const r = spawnSync(BIN(), ['--version'], { env: ocEnv(), timeout: 15000, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); return r.status === 0 ? r.stdout.trim() : null; } catch { return null; } }
export async function latestOpencodeVersion() { try { return (await (await fetch('https://registry.npmjs.org/opencode-ai/latest', { signal: AbortSignal.timeout(15000) })).json()).version || null; } catch { return null; } }
export const usingUpdatedCopy = () => fs.existsSync(UPDATED_BIN);
let updating = false;
/** Instala otra versión de OpenCode en el volumen (sin tocar la del sistema), la prueba y, si falla, vuelve atrás sola. */
export async function updateOpencode(version = 'latest') {
  if (updating) throw Object.assign(new Error('Ya hay una actualización en curso.'), { status: 409 });
  if (!/^(latest|\d+\.\d+\.\d+)$/.test(String(version))) throw Object.assign(new Error('Versión inválida.'), { status: 400 });
  updating = true;
  const before = opencodeVersion();
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    const r = await new Promise((resolve) => {
      const c = spawn('npm', ['install', '--prefix', APP_DIR, '--no-audit', '--no-fund', '--loglevel=error', `opencode-ai@${version}`], { env: ocEnv({ npm_config_cache: path.join(OPENCODE_HOME, 'cache', 'npm') }), stdio: ['ignore', 'pipe', 'pipe'] });
      let o = ''; const t = setTimeout(() => { c.kill('SIGKILL'); resolve({ code: -1, out: o }); }, 5 * 60e3);
      c.stdout.on('data', (d) => (o += d)); c.stderr.on('data', (d) => (o += d));
      c.on('close', (code) => { clearTimeout(t); resolve({ code, out: o }); }); c.on('error', (e) => { clearTimeout(t); resolve({ code: -1, out: e.message }); });
    });
    if (r.code !== 0) throw new Error(`No se pudo instalar: ${r.out.slice(-250)}`);
    clearModelCache();
    const after = opencodeVersion();
    if (!after) throw new Error('La versión nueva no arranca.');
    try { await askOpencode('Respondé solo con la palabra: ok', { timeoutMs: 90000 }); } // prueba real con la versión nueva
    catch (e) { if (!/rate|limit|429|quota/i.test(e.message)) throw new Error(`La versión ${after} falló en la prueba (${e.message.slice(0, 120)}).`); }
    return { ok: true, before, after };
  } catch (e) {
    fs.rmSync(APP_DIR, { recursive: true, force: true }); clearModelCache(); // vuelve a la versión del sistema
    throw Object.assign(new Error(`${e.message} Se mantiene la versión ${before}.`), { status: 502 });
  } finally { updating = false; }
}
export function revertOpencode() { fs.rmSync(APP_DIR, { recursive: true, force: true }); clearModelCache(); return opencodeVersion(); }
