// Cuentas y proveedores de OpenCode administrados desde el panel. Todo se guarda en el formato propio de OpenCode (auth.json + opencode.json
// dentro de /data/opencode), así que sirve igual desde la línea de comandos. Las claves NUNCA se devuelven al navegador.
import fs from 'node:fs';
import path from 'node:path';
import { OPENCODE_HOME, listOpencodeModels, clearModelCache, askOpencode } from './opencode.js';

const AUTH = () => path.join(OPENCODE_HOME, 'data', 'opencode', 'auth.json');
const CONFIG = () => path.join(OPENCODE_HOME, 'config', 'opencode', 'opencode.json');
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return {}; } };
const writeJson = (f, o, mode = 0o600) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.tmp`; fs.writeFileSync(t, JSON.stringify(o, null, 2), { mode }); fs.renameSync(t, f); };
const fail = (status, message) => Object.assign(new Error(message), { status });
const ID_RE = /^[a-z0-9][a-z0-9._-]{0,59}$/i;

// ---------- catálogo de proveedores (models.dev, el mismo que usa OpenCode) ----------
const POPULAR = ['openai', 'anthropic', 'google', 'openrouter', 'groq', 'deepseek', 'mistral', 'xai', 'cerebras', 'togetherai', 'fireworks-ai', 'perplexity', 'nvidia', 'huggingface', 'github-models'];
let catalog = null;
export async function providerCatalog() {
  if (catalog && Date.now() - catalog.at < 6 * 3600e3) return catalog.list;
  let d = {};
  try { d = await (await fetch('https://models.dev/api.json', { signal: AbortSignal.timeout(20000) })).json(); } catch { /* sin red: lista corta */ }
  const list = Object.entries(d).filter(([, p]) => Array.isArray(p.env) && p.env.length && p.npm).map(([id, p]) => ({ id, name: p.name || id, env: p.env, models: Object.keys(p.models || {}).length, doc: p.doc || null }));
  if (!list.length) return POPULAR.slice(0, 8).map((id) => ({ id, name: id, env: [], models: 0, doc: null }));
  list.sort((a, b) => (POPULAR.indexOf(a.id) < 0 ? 99 : POPULAR.indexOf(a.id)) - (POPULAR.indexOf(b.id) < 0 ? 99 : POPULAR.indexOf(b.id)) || a.name.localeCompare(b.name));
  catalog = { at: Date.now(), list };
  return list;
}

/** Proveedores conectados (sin claves): los de auth.json y los propios de opencode.json. */
export async function connected() {
  const auth = readJson(AUTH()), cfg = readJson(CONFIG()), cat = new Map((await providerCatalog()).map((p) => [p.id, p]));
  const all = await listOpencodeModels();
  const count = (id) => all.models.filter((m) => m.provider === id).length;
  const ids = [...new Set([...Object.keys(auth), ...Object.keys(cfg.provider || {})])];
  return ids.map((id) => ({
    id, name: cfg.provider?.[id]?.name || cat.get(id)?.name || id,
    kind: cfg.provider?.[id]?.npm ? 'propio' : auth[id]?.type === 'api' ? 'clave' : auth[id]?.type || 'clave',
    hasKey: !!auth[id], models: count(id), whitelist: cfg.provider?.[id]?.whitelist || null, baseURL: cfg.provider?.[id]?.options?.baseURL || null,
  }));
}
export function connectProvider(id, key) {
  if (!ID_RE.test(String(id))) throw fail(400, 'Proveedor inválido.');
  const k = String(key || '').trim();
  if (!/^\S{8,500}$/.test(k)) throw fail(400, 'La clave no parece válida (sin espacios, al menos 8 caracteres).');
  const auth = readJson(AUTH()); auth[id] = { type: 'api', key: k }; writeJson(AUTH(), auth); clearModelCache();
}
export function disconnectProvider(id) {
  if (!ID_RE.test(String(id))) throw fail(400, 'Proveedor inválido.');
  const auth = readJson(AUTH()); delete auth[id]; writeJson(AUTH(), auth);
  const cfg = readJson(CONFIG()); if (cfg.provider) { delete cfg.provider[id]; writeJson(CONFIG(), cfg, 0o644); }
  clearModelCache();
}
/** Proveedor propio compatible con OpenAI (LM Studio, Ollama, un servidor privado…). */
export function addCustomProvider({ id, name, baseURL, apiKey, models }) {
  if (!ID_RE.test(String(id))) throw fail(400, 'El identificador usa letras minúsculas, números, punto, guion y guion bajo (hasta 60).');
  let u; try { u = new URL(String(baseURL)); } catch { throw fail(400, 'La dirección (URL base) no es válida, por ejemplo https://mi-servidor.com/v1'); }
  if (!/^https?:$/.test(u.protocol)) throw fail(400, 'La dirección debe empezar con http:// o https://');
  const list = (Array.isArray(models) ? models : String(models || '').split(/[\n,]+/)).map((m) => (typeof m === 'string' ? { id: m.trim() } : m)).filter((m) => m?.id && /^[\w.:/@-]{1,100}$/.test(m.id)).slice(0, 100);
  if (!list.length) throw fail(400, 'Indicá al menos un modelo (su ID, tal como lo espera el servidor).');
  const cfg = readJson(CONFIG()); cfg.$schema = 'https://opencode.ai/config.json'; cfg.provider = cfg.provider || {};
  cfg.provider[id] = { npm: '@ai-sdk/openai-compatible', name: String(name || id).slice(0, 60), options: { baseURL: u.toString().replace(/\/$/, '') }, models: Object.fromEntries(list.map((m) => [m.id, { name: m.name || m.id }])) };
  writeJson(CONFIG(), cfg, 0o644);
  if (apiKey && String(apiKey).trim()) connectProvider(id, apiKey); else clearModelCache();
}
/** Qué modelos del proveedor se muestran (null = todos). Sirve para ocultar los que no querés usar. */
export function setWhitelist(id, models) {
  if (!ID_RE.test(String(id))) throw fail(400, 'Proveedor inválido.');
  const cfg = readJson(CONFIG()); cfg.$schema = 'https://opencode.ai/config.json'; cfg.provider = cfg.provider || {}; cfg.provider[id] = cfg.provider[id] || {};
  if (Array.isArray(models) && models.length) cfg.provider[id].whitelist = [...new Set(models.map(String))].slice(0, 500); else delete cfg.provider[id].whitelist;
  if (!Object.keys(cfg.provider[id]).length) delete cfg.provider[id];
  writeJson(CONFIG(), cfg, 0o644); clearModelCache();
}
export async function providerModels(id) {
  const all = await listOpencodeModels({ refresh: true });
  return all.models.filter((m) => m.provider === id).map((m) => ({ id: m.value.slice(id.length + 1), label: m.label, description: m.description }));
}
/** Prueba real: una frase mínima con un modelo del proveedor. Devuelve { ok, ms } o el motivo del fallo. */
export async function testProvider(id, model) {
  const ms = await providerModels(id);
  const m = model || ms[0]?.id;
  if (!m) return { ok: false, error: 'No hay modelos disponibles para este proveedor (¿clave inválida o proveedor sin modelos?).' };
  const t0 = Date.now();
  try { const out = await askOpencode('Respondé solo con la palabra: ok', { ocModel: `${id}/${m}`, timeoutMs: 60000 }); return { ok: true, model: `${id}/${m}`, ms: Date.now() - t0, sample: out.slice(0, 60) }; }
  catch (e) { return { ok: false, model: `${id}/${m}`, error: String(e.message).slice(0, 300) }; }
}
