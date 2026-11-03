// Inicio de sesión (OAuth 2.1 + PKCE) de MCPs remotos que lo exigen (Supabase, Notion, Linear, GitHub…), SIN navegador en el servidor:
// el hub arma el enlace de login, la persona lo abre en SU navegador/celular, inicia sesión y el proveedor la devuelve al hub
// (`/api/mcp/oauth/callback`), que guarda los tokens y los renueva. Sigue el estándar de autorización de MCP:
// descubrimiento (RFC 9728 / 8414), registro dinámico del cliente (RFC 7591), PKCE y `resource` (RFC 8707).
import crypto from 'node:crypto';
import { db } from './db.js';
import { getServer, testServer, listServers, clearNeedsAuth } from './mcp.js';
import { deliver } from './deliver.js';

db.exec(`CREATE TABLE IF NOT EXISTS mcp_oauth_pending (
  state TEXT PRIMARY KEY, name TEXT NOT NULL, jid TEXT, verifier TEXT NOT NULL, meta TEXT NOT NULL, client TEXT NOT NULL, redirect TEXT NOT NULL, created INTEGER NOT NULL
)`);
db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL)');

const TTL = 20 * 60e3;
const fail = (status, message) => Object.assign(new Error(message), { status });
const b64u = (b) => Buffer.from(b).toString('base64url');
const redirectUri = () => `${(process.env.HUB_BASE_URL || process.env.HUB_PUBLIC_URL || `http://localhost:${process.env.PORT || 4961}`).replace(/\/$/, '')}/api/mcp/oauth/callback`;
const jfetch = async (url, opts = {}) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(20000), ...opts });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { ok: r.ok, status: r.status, headers: r.headers, data };
};

/** Descubre cómo iniciar sesión en ese MCP: devuelve null si no pide autenticación. */
export async function discover(mcpUrl) {
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'kiri-hub', version: '1.0' } } };
  const probe = await jfetch(mcpUrl, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(init) });
  if (probe.status !== 401) return null;
  const u = new URL(mcpUrl);
  const rm = /resource_metadata="([^"]+)"/.exec(probe.headers.get('www-authenticate') || '')?.[1];
  let prm = null;
  for (const cand of [rm, `${u.origin}/.well-known/oauth-protected-resource${u.pathname === '/' ? '' : u.pathname}`, `${u.origin}/.well-known/oauth-protected-resource`].filter(Boolean)) {
    const r = await jfetch(cand).catch(() => null);
    if (r?.ok && r.data?.authorization_servers?.length) { prm = r.data; break; }
  }
  const issuer = (prm?.authorization_servers?.[0] || u.origin).replace(/\/$/, '');
  const iu = new URL(issuer);
  let as = null;
  for (const cand of [`${iu.origin}/.well-known/oauth-authorization-server${iu.pathname === '/' ? '' : iu.pathname}`, `${iu.origin}/.well-known/openid-configuration${iu.pathname === '/' ? '' : iu.pathname}`, `${issuer}/.well-known/openid-configuration`]) {
    const r = await jfetch(cand).catch(() => null);
    if (r?.ok && r.data?.authorization_endpoint && r.data?.token_endpoint) { as = r.data; break; }
  }
  if (!as) throw fail(400, 'Ese servidor pide iniciar sesión pero no publica cómo hacerlo (OAuth). Probá con un token de acceso en las cabeceras.');
  return { resource: prm?.resource || mcpUrl, scopes: prm?.scopes_supported || as.scopes_supported || [], as };
}

/** Cliente OAuth (registro dinámico, una vez por proveedor y URL de retorno). */
async function ensureClient(as, redirect, scopes) {
  const key = `mcp_oauth_client:${as.issuer || as.authorization_endpoint}:${redirect}`;
  const saved = db.prepare('SELECT value FROM kv WHERE key = ?').get(key);
  if (saved) return JSON.parse(saved.value);
  if (!as.registration_endpoint) throw fail(400, 'Ese proveedor no permite registro automático de la aplicación: hay que configurarlo a mano con un token.');
  const methods = as.token_endpoint_auth_methods_supported || ['client_secret_basic'];
  const method = methods.includes('none') ? 'none' : methods.includes('client_secret_post') ? 'client_secret_post' : 'client_secret_basic';
  const r = await jfetch(as.registration_endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
    client_name: 'Kiri Hub', redirect_uris: [redirect], grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], token_endpoint_auth_method: method, ...(scopes.length ? { scope: scopes.join(' ') } : {}) }) });
  if (!r.ok || !r.data.client_id) throw fail(502, `No pude registrar la aplicación en el proveedor (${r.status}).`);
  const client = { client_id: r.data.client_id, client_secret: r.data.client_secret || null, method: r.data.token_endpoint_auth_method || method };
  db.prepare('INSERT OR REPLACE INTO kv (key, value) VALUES (?, ?)').run(key, JSON.stringify(client));
  return client;
}

/** Arma el enlace de login para un MCP ya registrado en el panel. `jid` = chat al que avisar cuando termine (opcional). */
export async function startLogin(name, { jid = null } = {}) {
  const s = getServer(name);
  if (!s) throw fail(404, 'No existe ese MCP.');
  if (s.type === 'stdio') throw fail(400, 'Ese MCP es de tipo comando: no usa inicio de sesión web.');
  const meta = await discover(s.url);
  if (!meta) throw fail(409, 'Ese MCP no pide iniciar sesión (o ya lo tiene resuelto).');
  const redirect = redirectUri();
  const client = await ensureClient(meta.as, redirect, meta.scopes);
  const state = b64u(crypto.randomBytes(24)), verifier = b64u(crypto.randomBytes(48));
  db.prepare('DELETE FROM mcp_oauth_pending WHERE created < ?').run(Date.now() - TTL);
  db.prepare('INSERT INTO mcp_oauth_pending (state, name, jid, verifier, meta, client, redirect, created) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(state, name, jid, verifier, JSON.stringify(meta), JSON.stringify(client), redirect, Date.now());
  const p = new URLSearchParams({ response_type: 'code', client_id: client.client_id, redirect_uri: redirect, state, code_challenge: b64u(crypto.createHash('sha256').update(verifier).digest()), code_challenge_method: 'S256', resource: meta.resource });
  // si el enlace del MCP pide solo lectura (ej. ?read_only=true), no se piden permisos de escritura
  const scopes = /read_?only=true|readonly/i.test(s.url) ? meta.scopes.filter((x) => !/write/i.test(x)) : meta.scopes;
  if (scopes.length) p.set('scope', scopes.join(' '));
  return { url: `${meta.as.authorization_endpoint}${meta.as.authorization_endpoint.includes('?') ? '&' : '?'}${p}`, expires_in_min: TTL / 60e3 };
}

async function tokenRequest(meta, client, params) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' };
  const body = new URLSearchParams(params);
  if (client.method === 'client_secret_basic' && client.client_secret) headers.authorization = `Basic ${Buffer.from(`${encodeURIComponent(client.client_id)}:${encodeURIComponent(client.client_secret)}`).toString('base64')}`;
  else { body.set('client_id', client.client_id); if (client.client_secret) body.set('client_secret', client.client_secret); }
  const r = await jfetch(meta.as.token_endpoint, { method: 'POST', headers, body });
  if (!r.ok || !r.data.access_token) throw fail(502, `El proveedor rechazó el inicio de sesión (${r.data.error_description || r.data.error || r.status}).`);
  return r.data;
}
const saveTokens = (name, meta, client, t, prev = {}) => db.prepare('UPDATE mcp_servers SET oauth = ?, status = NULL, status_msg = NULL WHERE name = ?').run(JSON.stringify({
  token_endpoint: meta.as.token_endpoint, issuer: meta.as.issuer || null, resource: meta.resource, client, access_token: t.access_token,
  refresh_token: t.refresh_token || prev.refresh_token || null, expires_at: Date.now() + (Number(t.expires_in) || 3600) * 1000, scope: t.scope || prev.scope || null }), name);

/** El proveedor devuelve a la persona al hub con `code` y `state`: se canjea por tokens y se prueba el MCP. */
export async function finishLogin(state, code) {
  const p = db.prepare('SELECT * FROM mcp_oauth_pending WHERE state = ?').get(String(state || ''));
  if (!p || Date.now() - p.created > TTL) throw fail(400, 'El enlace de inicio de sesión venció o no es válido. Pedí uno nuevo.');
  db.prepare('DELETE FROM mcp_oauth_pending WHERE state = ?').run(p.state); // de un solo uso
  const meta = JSON.parse(p.meta), client = JSON.parse(p.client);
  const t = await tokenRequest(meta, client, { grant_type: 'authorization_code', code: String(code || ''), redirect_uri: p.redirect, code_verifier: p.verifier, resource: meta.resource });
  saveTokens(p.name, meta, client, t);
  clearNeedsAuth([p.name]);
  const tested = await testServer(p.name);
  if (p.jid) {
    const msg = tested.status === 'ok' ? `✅ Listo: «${p.name}» quedó conectado (${(tested.tools || []).length} herramientas). Ya podés pedirme que lo use.` : `⚠️ Iniciaste sesión en «${p.name}», pero al probarlo no respondió (${tested.status_msg || 'sin detalle'}).`;
    db.prepare("INSERT INTO messages (jid, role, content) VALUES (?, 'assistant', ?)").run(p.jid, msg);
    deliver(p.jid, msg).catch(() => {});
  }
  return { name: p.name, status: tested.status, tools: (tested.tools || []).length };
}

/** Renueva los tokens que vencen pronto (se llama antes de cada tarea y cada pocos minutos). */
export async function refreshExpiring(withinMs = 5 * 60e3) {
  for (const s of listServers().filter((x) => x.oauth?.refresh_token && x.oauth.expires_at - Date.now() < withinMs)) {
    try {
      const o = s.oauth;
      const t = await tokenRequest({ as: { token_endpoint: o.token_endpoint } }, o.client, { grant_type: 'refresh_token', refresh_token: o.refresh_token, resource: o.resource });
      saveTokens(s.name, { as: { token_endpoint: o.token_endpoint, issuer: o.issuer }, resource: o.resource }, o.client, t, o);
    } catch (e) { console.error(`[mcp-oauth] no se pudo renovar el acceso de "${s.name}": ${e.message}`); db.prepare("UPDATE mcp_servers SET status = 'auth_required', status_msg = 'La sesión venció: hay que iniciar sesión de nuevo' WHERE name = ?").run(s.name); }
  }
}
let timer = null;
export function startRefresher() { if (!timer) { timer = setInterval(() => refreshExpiring(10 * 60e3).catch(() => {}), 5 * 60e3); timer.unref(); } }
