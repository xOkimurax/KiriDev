// Servidores MCP de terceros que se le pueden dar al agente. Se guardan en SQLite y se inyectan en CADA ejecución de Claude
// (`--mcp-config` se arma por mensaje), así que un MCP recién agregado funciona desde el siguiente mensaje: no hay nada que reiniciar.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { db } from './db.js';
import { HOME_DIR } from './persona.js';

db.exec(`CREATE TABLE IF NOT EXISTS mcp_servers (
  name TEXT PRIMARY KEY, type TEXT NOT NULL DEFAULT 'stdio', command TEXT, args TEXT NOT NULL DEFAULT '[]', env TEXT NOT NULL DEFAULT '{}',
  url TEXT, headers TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1, description TEXT,
  tools TEXT, status TEXT, status_msg TEXT, tested_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

// inicio de sesión OAuth de MCPs remotos (tokens guardados por el hub; ver mcp-oauth.js)
try { db.exec('ALTER TABLE mcp_servers ADD COLUMN oauth TEXT'); } catch { /* ya existe */ }

const fail = (m) => Object.assign(new Error(m), { status: 400 });
const RESERVED = new Set(['kiri']);
const SECRET_KEY = /key|token|secret|pass|auth|cookie|bearer/i;
const j = (v, d) => { try { return JSON.parse(v); } catch { return d; } };

const row = (r) => r && ({ ...r, enabled: !!r.enabled, args: j(r.args, []), env: j(r.env, {}), headers: j(r.headers, {}), tools: r.tools ? j(r.tools, []) : null, oauth: r.oauth ? j(r.oauth, null) : null });
/** Cabeceras efectivas de un MCP remoto: las configuradas + el token OAuth si inició sesión. */
export const effectiveHeaders = (s) => ({ ...s.headers, ...(s.oauth?.access_token ? { Authorization: `Bearer ${s.oauth.access_token}` } : {}) });
/** Para la API: los valores de env/headers que parecen secretos se enmascaran (el panel nunca los vuelve a ver completos). */
const mask = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SECRET_KEY.test(k) && String(v).length > 0 ? '••••••••' : v]));
export const publicView = (r) => r && ({ ...r, env: mask(r.env), headers: mask(r.headers), oauth: r.oauth ? { connected: !!r.oauth.access_token, expires_at: r.oauth.expires_at, scope: r.oauth.scope || null } : null });

export const listServers = () => db.prepare('SELECT * FROM mcp_servers ORDER BY created_at, name').all().map(row);
export const getServer = (name) => row(db.prepare('SELECT * FROM mcp_servers WHERE name = ?').get(name));

/** Normaliza y valida una definición (de cualquier forma que venga) a { name, type, command, args, env, url, headers }. */
export function normalize(name, d) {
  const n = String(name || d?.name || '').trim().toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  if (!n) throw fail('Falta el nombre del servidor MCP');
  if (RESERVED.has(n)) throw fail(`"${n}" es un nombre reservado`);
  const type = ['http', 'sse', 'stdio'].includes(d.type) ? d.type : d.url ? 'http' : 'stdio';
  const obj = (o) => Object.fromEntries(Object.entries(o && typeof o === 'object' ? o : {}).map(([k, v]) => [String(k), String(v)]));
  if (type === 'stdio') {
    if (!d.command || typeof d.command !== 'string') throw fail('Falta el comando (por ejemplo: npx)');
    return { name: n, type, command: d.command.trim(), args: (Array.isArray(d.args) ? d.args : []).map(String), env: obj(d.env), url: null, headers: {}, description: d.description ? String(d.description).slice(0, 200) : null };
  }
  let u; try { u = new URL(d.url); } catch { throw fail('La URL no es válida'); }
  if (!/^https?:$/.test(u.protocol)) throw fail('La URL debe ser http o https');
  return { name: n, type, command: null, args: [], env: {}, url: u.toString(), headers: obj(d.headers), description: d.description ? String(d.description).slice(0, 200) : null };
}

const tokenize = (s) => { const out = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m; while ((m = re.exec(s))) out.push(m[1] ?? m[2] ?? m[3]); return out; };
const guessName = (parts, url) => {
  if (url) return new URL(url).hostname.replace(/^(mcp|www|api)\./, '').split('.')[0];
  const pkg = parts.find((p) => !p.startsWith('-') && !['npx', 'uvx', 'node', 'python', 'python3', 'docker', 'run', 'bunx', 'pnpm', 'dlx'].includes(p)) || 'mcp';
  return pkg.replace(/^@[^/]+\//, '').replace(/^(server-|mcp-server-|mcp-)/, '').replace(/@.*$/, '').replace(/[-_]?mcp([-_]?server)?$/i, '') || pkg;
};

/**
 * Acepta casi cualquier cosa que alguien pegue: el JSON de `mcpServers` (formato Claude/Cursor/VS Code), un solo objeto,
 * una URL, un comando (`npx -y paquete`) o una línea `claude mcp add ...`. Devuelve una lista de definiciones normalizadas.
 */
export function parseInput(text) {
  const t = String(text || '').trim();
  if (!t) throw fail('Pegá la configuración del MCP');
  const jsonStart = t.indexOf('{');
  if (jsonStart >= 0 && !/^claude\s+mcp\s+add/i.test(t) || t.startsWith('{')) {
    let data; try { data = JSON.parse(t.slice(jsonStart)); } catch { throw fail('El JSON no es válido'); }
    const map = data.mcpServers || data.servers || data.mcp?.servers || (data.command || data.url ? { [data.name || '']: data } : data);
    const entries = Object.entries(map).filter(([, v]) => v && typeof v === 'object');
    if (!entries.length) throw fail('No encontré ningún servidor en ese JSON');
    return entries.map(([k, v]) => normalize(k || guessName([v.command, ...(v.args || [])].filter(Boolean), v.url), v));
  }
  if (/^https?:\/\/\S+$/i.test(t)) return [normalize(guessName([], t), { type: 'http', url: t })];
  let parts = tokenize(t);
  if (/^claude$/i.test(parts[0]) && parts[1] === 'mcp' && parts[2] === 'add') {
    parts = parts.slice(3);
    const dash = parts.indexOf('--');
    const head = dash >= 0 ? parts.slice(0, dash) : parts, tail = dash >= 0 ? parts.slice(dash + 1) : [];
    let transport, env = {}, headers = {}; const pos = [];
    for (let i = 0; i < head.length; i++) {
      const p = head[i];
      if (p === '--transport' || p === '-t') transport = head[++i];
      else if (p === '--env' || p === '-e') { const [k, ...v] = (head[++i] || '').split('='); env[k] = v.join('='); }
      else if (p === '--header' || p === '-H') { const [k, ...v] = (head[++i] || '').split(':'); headers[k.trim()] = v.join(':').trim(); }
      else if (p === '--scope' || p === '-s') i++;
      else pos.push(p);
    }
    const name = pos[0];
    if (transport === 'http' || transport === 'sse') return [normalize(name, { type: transport, url: pos[1], headers })];
    const cmd = tail.length ? tail : pos.slice(1);
    return [normalize(name, { command: cmd[0], args: cmd.slice(1), env })];
  }
  return [normalize(guessName(parts), { command: parts[0], args: parts.slice(1) })];
}

export function saveServer(def, { keepSecrets = true } = {}) {
  const old = getServer(def.name);
  // al editar desde el panel, un valor enmascarado ("••••") significa "no lo cambié": se conserva el real
  const merge = (nu, prev) => Object.fromEntries(Object.entries(nu).map(([k, v]) => [k, v === '••••••••' && keepSecrets ? (prev?.[k] ?? '') : v]));
  const env = merge(def.env, old?.env), headers = merge(def.headers, old?.headers);
  db.prepare(`INSERT INTO mcp_servers (name, type, command, args, env, url, headers, description, enabled, status, status_msg, tools, tested_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, NULL, NULL, NULL)
    ON CONFLICT(name) DO UPDATE SET type=excluded.type, command=excluded.command, args=excluded.args, env=excluded.env, url=excluded.url,
      headers=excluded.headers, description=excluded.description, status=NULL, status_msg=NULL, tools=NULL, tested_at=NULL`)
    .run(def.name, def.type, def.command, JSON.stringify(def.args), JSON.stringify(env), def.url, JSON.stringify(headers), def.description);
  return getServer(def.name);
}
export const setEnabled = (name, on) => { if (!getServer(name)) throw Object.assign(new Error('No existe'), { status: 404 }); db.prepare('UPDATE mcp_servers SET enabled = ? WHERE name = ?').run(on ? 1 : 0, name); return getServer(name); };
export const removeServer = (name) => db.prepare('DELETE FROM mcp_servers WHERE name = ?').run(name).changes > 0;

/**
 * Claude Code recuerda ("mcp-needs-auth-cache.json") que un MCP respondió "necesita autenticación" y se SALTA la conexión un buen rato,
 * aunque después se le dé un token válido (por eso el sub agente veía el MCP como "requiere autenticación" ya conectado en el panel).
 * Como el acceso lo administra el hub, se borra esa marca para los MCPs que le pasamos.
 */
export function clearNeedsAuth(names) {
  const f = path.join(HOME_DIR, '.claude', 'mcp-needs-auth-cache.json');
  try {
    const cache = JSON.parse(fs.readFileSync(f, 'utf8'));
    let changed = false;
    for (const n of names) if (n in cache) { delete cache[n]; changed = true; }
    if (changed) fs.writeFileSync(f, JSON.stringify(cache));
  } catch { /* sin caché: nada que limpiar */ }
}

/** Entradas para `--mcp-config` de los servidores activos, y los permisos (`mcp__<nombre>`) que habilitan todas sus herramientas. */
export function activeConfig(only = null) {
  const servers = {}, allow = [];
  for (const s of listServers().filter((x) => x.enabled && (!only || only.includes(x.name)))) {
    servers[s.name] = s.type === 'stdio' ? { command: s.command, args: s.args, env: s.env } : { type: s.type, url: s.url, headers: effectiveHeaders(s) };
    allow.push(`mcp__${s.name}`);
  }
  return { servers, allow };
}

// ---------- prueba de conexión: handshake MCP real + listado de herramientas ----------
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'kiri-hub', version: '1.0' } } };

function testStdio(s, ms) {
  return new Promise((resolve, reject) => {
    const child = spawn(s.command, s.args, { env: { PATH: process.env.PATH, HOME: HOME_DIR, ...s.env }, stdio: ['pipe', 'pipe', 'pipe'], cwd: HOME_DIR });
    let buf = '', err = '', done = false;
    const errText = () => err.split('\n').filter((l) => l.trim() && !/^npm notice/.test(l)).join(' ⏎ ').slice(0, 300);
    const end = (fn, v) => { if (done) return; done = true; clearTimeout(timer); child.kill('SIGKILL'); fn(v); };
    const timer = setTimeout(() => end(reject, new Error(`No respondió en ${ms / 1000} s${err ? `: ${errText()}` : ' (la primera vez puede tardar mientras descarga el paquete: probá de nuevo)'}`)), ms);
    const send = (o) => child.stdin.write(JSON.stringify(o) + '\n');
    child.on('error', (e) => end(reject, new Error(e.code === 'ENOENT' ? `No existe el comando "${s.command}" en el contenedor` : e.message)));
    child.on('close', (c) => end(reject, new Error(`El proceso terminó (código ${c})${err ? `: ${errText()}` : ''}`)));
    child.stderr.on('data', (d) => (err += d));
    child.stdout.on('data', (d) => {
      buf += d; let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        let m; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { if (m.error) return end(reject, new Error(m.error.message)); send({ jsonrpc: '2.0', method: 'notifications/initialized' }); send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }); }
        if (m.id === 2) return end(resolve, m.result?.tools || []);
      }
    });
    send(INIT);
  });
}

async function testHttp(s, ms) {
  const headers = { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...effectiveHeaders(s) };
  const post = async (body, extra = {}) => {
    const r = await fetch(s.url, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms) });
    if (r.status === 401 || r.status === 403) throw Object.assign(new Error(`El servidor rechazó la autenticación (${r.status}): revisá el token/cabeceras`), { auth: r.status === 401 });
    if (!r.ok && r.status !== 202) throw new Error(`El servidor respondió ${r.status}`);
    const text = await r.text();
    const data = /text\/event-stream/.test(r.headers.get('content-type') || '') ? (text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).pop() || '{}') : text || '{}';
    return { msg: JSON.parse(data), sid: r.headers.get('mcp-session-id') };
  };
  const a = await post(INIT);
  if (a.msg.error) throw new Error(a.msg.error.message);
  const extra = a.sid ? { 'mcp-session-id': a.sid } : {};
  await post({ jsonrpc: '2.0', method: 'notifications/initialized' }, extra).catch(() => {});
  const b = await post({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }, extra);
  if (b.msg.error) throw new Error(b.msg.error.message);
  return b.msg.result?.tools || [];
}

export async function testServer(name, ms = 60000) {
  const s = getServer(name); if (!s) throw Object.assign(new Error('No existe'), { status: 404 });
  try {
    const tools = (await (s.type === 'stdio' ? testStdio(s, ms) : testHttp(s, ms))).map((t) => ({ name: t.name, description: String(t.description || '').slice(0, 300) }));
    db.prepare("UPDATE mcp_servers SET tools = ?, status = 'ok', status_msg = NULL, tested_at = datetime('now') WHERE name = ?").run(JSON.stringify(tools), name);
  } catch (e) {
    // 401 sin token: el MCP pide iniciar sesión (OAuth) → se puede resolver con un enlace de login, no es un error de configuración
    const needsLogin = e.auth && !s.oauth?.access_token && !Object.keys(s.headers).some((k) => /^authorization$/i.test(k));
    db.prepare("UPDATE mcp_servers SET status = ?, status_msg = ?, tested_at = datetime('now') WHERE name = ?").run(needsLogin ? 'auth_required' : 'error', needsLogin ? 'Requiere iniciar sesión' : String(e.message).slice(0, 500), name);
  }
  return publicView(getServer(name));
}

/** Agregar (o actualizar) desde cualquier texto: valida, guarda y prueba. Devuelve cada servidor con su estado. */
export async function addFromText(text, { test = true } = {}) {
  const out = [];
  for (const def of parseInput(text)) {
    saveServer(def, { keepSecrets: false });
    out.push(test ? await testServer(def.name) : publicView(getServer(def.name)));
  }
  return out;
}

/**
 * Si el agente corrió `claude mcp add` por su cuenta (Bash), el MCP queda en el ~/.claude.json de Claude Code y el panel no lo ve
 * (además `--strict-mcp-config` no lo carga). Se adopta: pasa al registro del panel, se prueba y se saca del archivo nativo.
 */
export function adoptNativeSync() {
  const file = path.join(HOME_DIR, '.claude.json');
  let cfg; try { cfg = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return []; }
  const found = { ...(cfg.mcpServers || {}) };
  for (const p of Object.values(cfg.projects || {})) Object.assign(found, p?.mcpServers || {});
  const names = Object.keys(found).filter((n) => found[n] && typeof found[n] === 'object');
  const adopted = [];
  for (const name of names) {
    try {
      const def = normalize(name, found[name]);
      if (!getServer(def.name)) { saveServer(def, { keepSecrets: false }); adopted.push(def.name); }
    } catch (e) { console.error(`[mcp] no se pudo adoptar "${name}": ${e.message}`); }
  }
  if (names.length) { // se quitan del archivo nativo: una sola fuente de verdad (el panel)
    delete cfg.mcpServers; for (const p of Object.values(cfg.projects || {})) if (p) delete p.mcpServers;
    try { fs.writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 }); } catch { /* sin permiso: se reintenta luego */ }
  }
  return adopted;
}
export async function adoptNative(wait = false) {
  const adopted = adoptNativeSync();
  const tests = adopted.map((n) => testServer(n).catch(() => {}));
  if (wait) await Promise.all(tests);
  return adopted;
}
