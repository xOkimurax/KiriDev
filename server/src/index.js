import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { db, seedAdmin } from './db.js';
import * as persona from './persona.js';
import * as personas from './personas.js';
import * as evo from './evolution.js';
import { chat, getContact, resetSession, INTERNAL_TOKEN, askClaude } from './agent.js';
import * as tasks from './tasks.js';
import { deleteChat, resetMemory } from './cleanup.js';
import * as mcp from './mcp.js';
import * as memory from './memory.js';
import * as mcpOauth from './mcp-oauth.js';
import * as schedules from './schedules.js';
import { skillLog } from './learn.js';
import { listModels } from './models.js';
import { listOpencodeModels, initOpencodeDir, opencodeVersion, latestOpencodeVersion, updateOpencode, revertOpencode, usingUpdatedCopy, askOpencode } from './opencode.js';
import * as engines from './engines.js';
import * as claudeLogin from './claude-login.js';
import * as ocAccounts from './opencode-accounts.js';
import * as outreach from './outreach.js';
import * as apps from './apps.js';
import * as voice from './voice.js';
import * as assistant from './assistant.js';
import { cleanInbox } from './media.js';
import { COOKIES_FILE, cookiesStatus, saveCookies, deleteCookies, groqStatus, saveGroqKey, deleteGroqKey, testGroq } from './secrets.js';
import { readRules, writeRules, accountOverrideKeys, replyDelaySec } from './rules.js';
import * as accounts from './accounts.js';
import * as attention from './attention.js';
import * as office from './office.js';
import * as profile from './profile.js';
import * as panels from './panels.js';
import * as documents from './documents.js';
import { agentCall } from './panels-agent.js';

const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('[warn] JWT_SECRET no definido: las sesiones se invalidan al reiniciar');
const AGENT_TOKEN = process.env.AGENT_TOKEN;

seedAdmin();
persona.initAgentDir();
initOpencodeDir();
personas.seedPersonas(path.join(persona.SEED_DIR, 'CLAUDE.md'));

const app = express();
app.set('trust proxy', 1);
app.use(apps.middleware); // <slug><sufijo>: proxy hacia las apps del agente (antes de todo lo demás: el cuerpo del pedido pasa tal cual)
// el endpoint del agente recibe archivos en base64 (hasta ~30 MB); el resto, solo JSON chico
app.use((req, res, next) => (['/api/agent/chat', '/internal/documents'].includes(req.path) ? next() : express.json({ limit: '1mb' })(req, res, next)));
app.use(cookieParser());

const wrap = (fn) => (req, res) => Promise.resolve().then(() => fn(req, res)).catch((e) => {
  console.error(`[${req.method} ${req.path}]`, e.message);
  res.status(e.status && e.status < 600 ? e.status : 500).json({ error: e.message });
});

// ---------- auth ----------
const attempts = new Map();
function auth(req, res, next) {
  try {
    req.user = jwt.verify(req.cookies.session, JWT_SECRET);
    next();
  } catch { res.status(401).json({ error: 'No autenticado' }); }
}
const mcpAgentFlag = () => db.prepare("SELECT value FROM kv WHERE key = 'mcp_agent_install'").get()?.value !== '0';
const setMcpAgentFlag = (on) => db.prepare("INSERT INTO kv (key, value) VALUES ('mcp_agent_install', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(on ? '1' : '0');
const readSettingsSafe = () => { try { return persona.readSettings(); } catch { return {}; } };
const adminOnly = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Solo administradores' }));

app.post('/api/auth/login', wrap((req, res) => {
  const key = req.ip;
  const a = attempts.get(key) || { n: 0, t: Date.now() };
  if (Date.now() - a.t > 15 * 60e3) { a.n = 0; a.t = Date.now(); }
  if (a.n >= 8) return res.status(429).json({ error: 'Demasiados intentos, probá en unos minutos' });
  const { username, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE username = ?').get(String(username || ''));
  if (!u || !bcrypt.compareSync(String(password || ''), u.password_hash)) {
    attempts.set(key, { ...a, n: a.n + 1 });
    return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
  }
  attempts.delete(key);
  const token = jwt.sign({ id: u.id, username: u.username, role: u.role }, JWT_SECRET, { expiresIn: '7d' });
  res.cookie('session', token, { httpOnly: true, sameSite: 'lax', secure: req.secure, maxAge: 7 * 864e5 });
  res.json({ username: u.username, role: u.role });
}));
app.post('/api/auth/logout', (req, res) => { res.clearCookie('session'); res.json({ ok: true }); });
app.get('/api/auth/me', auth, (req, res) => res.json({ username: req.user.username, role: req.user.role }));
app.post('/api/auth/password', auth, wrap((req, res) => {
  const { current, next } = req.body || {};
  if (String(next || '').length < 8) return res.status(400).json({ error: 'La nueva contraseña debe tener al menos 8 caracteres' });
  const u = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!bcrypt.compareSync(String(current || ''), u.password_hash)) return res.status(400).json({ error: 'La contraseña actual no coincide' });
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(next, 10), u.id);
  res.json({ ok: true });
}));

// ---------- usuarios ----------
app.get('/api/users', auth, adminOnly, (req, res) =>
  res.json(db.prepare('SELECT id, username, role, created_at FROM users ORDER BY id').all()));
app.post('/api/users', auth, adminOnly, wrap((req, res) => {
  const { username, password, role } = req.body || {};
  if (!/^[a-z0-9._-]{3,32}$/i.test(String(username || ''))) return res.status(400).json({ error: 'Usuario inválido (3-32 caracteres: letras, números . _ -)' });
  if (String(password || '').length < 8) return res.status(400).json({ error: 'La contraseña debe tener al menos 8 caracteres' });
  try {
    db.prepare('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)')
      .run(username, bcrypt.hashSync(password, 10), role === 'viewer' ? 'viewer' : 'admin');
  } catch { return res.status(409).json({ error: 'Ese usuario ya existe' }); }
  res.json({ ok: true });
}));
app.delete('/api/users/:id', auth, adminOnly, (req, res) => {
  if (Number(req.params.id) === req.user.id) return res.status(400).json({ error: 'No podés eliminar tu propio usuario' });
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// ---------- WhatsApp (vía Evolution API): varios números ----------
// Todas las rutas aceptan ?instance=<nombre>; sin eso actúan sobre la cuenta principal.
const scoped = (fn) => wrap((req, res) => {
  const instance = String(req.query.instance || req.body?.instance || evo.PRIMARY_INSTANCE());
  if (!accounts.getAccount(instance)) return res.status(404).json({ error: 'Ese número de WhatsApp no está registrado en el panel' });
  return evo.withInstance(instance, () => fn(req, res, instance));
});
const statusOf = async (instance) => {
  const [st, hook] = await evo.withInstance(instance, () => Promise.all([evo.status(), evo.getWebhook()]));
  return { ...st, instance, webhook: hook?.url || hook?.webhook?.url || null, webhookEnabled: hook?.enabled ?? null, expectedWebhook: process.env.N8N_WEBHOOK_URL || null };
};
app.get('/api/whatsapp/status', auth, scoped(async (req, res, instance) => res.json(await statusOf(instance))));
app.post('/api/whatsapp/connect', auth, adminOnly, scoped(async (req, res) => res.json(await evo.connect())));
app.post('/api/whatsapp/logout', auth, adminOnly, scoped(async (req, res) => res.json(await evo.logout())));
app.post('/api/whatsapp/restart', auth, adminOnly, scoped(async (req, res) => res.json(await evo.restart())));
app.post('/api/whatsapp/webhook', auth, adminOnly, scoped(async (req, res) => res.json(await evo.setWebhook())));
// cuentas (números) registradas en el panel
app.get('/api/whatsapp/accounts', auth, wrap(async (req, res) => {
  const list = accounts.listAccounts();
  const out = await Promise.all(list.map(async (a) => {
    const st = await statusOf(a.instance).catch((e) => ({ state: 'unreachable', error: e.message }));
    return { instance: a.instance, label: a.label || a.instance, primary: a.primary, persona_id: a.persona_id, rulesOverride: accountOverrideKeys(a.instance).length, state: st.state, number: st.number || null, profileName: st.profileName || null, profilePicUrl: st.profilePicUrl || null, exists: st.exists !== false };
  }));
  res.json(out);
}));
app.post('/api/whatsapp/accounts', auth, adminOnly, wrap(async (req, res) => {
  const name = String(req.body?.instance || '').trim();
  const acc = accounts.addAccount(name, req.body?.label);
  try { await evo.withInstance(name, () => evo.connect()); } catch (e) { accounts.removeAccount(name); throw e; }
  res.json(acc);
}));
app.put('/api/whatsapp/accounts/:instance', auth, adminOnly, wrap((req, res) => {
  const pid = req.body?.personaId;
  if (pid !== undefined && pid !== null && !personas.getPersona(pid)) return res.status(404).json({ error: 'Esa personalidad no existe' });
  res.json(accounts.updateAccount(req.params.instance, { label: req.body?.label, personaId: pid }));
}));
app.get('/api/whatsapp/accounts/:instance/office', auth, wrap((req, res) => { if (!accounts.getAccount(req.params.instance)) return res.status(404).json({ error: 'Ese número no existe' }); res.json(office.getOffice(req.params.instance)); }));
app.put('/api/whatsapp/accounts/:instance/office', auth, adminOnly, wrap((req, res) => res.json(office.saveOffice(req.params.instance, req.body || {}))));
app.delete('/api/whatsapp/accounts/:instance', auth, adminOnly, wrap(async (req, res) => {
  const name = req.params.instance;
  if (!accounts.getAccount(name)) return res.status(404).json({ error: 'Ese número no existe' });
  accounts.removeAccount(name); // los chats quedan guardados; solo se deja de atender esa línea
  await evo.withInstance(name, () => evo.logout()).catch(() => {});
  if (req.query.deleteInstance === '1') await evo.withInstance(name, () => evo.deleteInstance()).catch(() => {});
  res.json({ ok: true });
}));

// ---------- configuración POR personalidad (modelo, permisos, límites) ----------
app.get('/api/personas/:id/settings', auth, wrap((req, res) => {
  const p = personas.getPersona(req.params.id);
  if (!p) return res.status(404).json({ error: 'Esa personalidad no existe' });
  res.json({ settings: personas.settingsFor(p), inherited: !p.is_default && !personas.settingsOverride(p), isDefault: !!p.is_default, general: persona.readSettings(), limits: persona.LIMITS, containerRoot: process.env.AGENT_ROOT === '1' });
}));
app.put('/api/personas/:id/settings', auth, adminOnly, wrap((req, res) => res.json({ ok: true, settings: personas.saveSettingsFor(req.params.id, req.body?.settings || {}) })));
app.delete('/api/personas/:id/settings', auth, adminOnly, wrap((req, res) => { personas.clearSettingsFor(req.params.id); res.json({ ok: true }); }));

// ---------- personalidad / skills ----------
app.get('/api/persona', auth, (req, res) => res.json({ settings: persona.readSettings(), skills: persona.listSkills(), containerRoot: process.env.AGENT_ROOT === '1' }));
app.put('/api/persona', auth, adminOnly, wrap((req, res) => {
  if (req.body.settings) persona.writeSettings(req.body.settings);
  res.json({ ok: true, settings: persona.readSettings() });
}));

// ---------- personalidades (varias; una predeterminada y asignaciones por contacto) ----------
const personaOut = (p) => ({ id: p.id, name: p.name, content: p.content, is_default: p.is_default, updated_at: p.updated_at, mcp: personas.mcpOf(p), skills: personas.skillsOf(p) });
app.get('/api/personas', auth, (req, res) => res.json(personas.listPersonas()));
app.post('/api/personas', auth, adminOnly, wrap((req, res) => {
  const src = req.body.copyFrom ? personas.getPersona(req.body.copyFrom) : null;
  res.json(personaOut(personas.createPersona({ name: req.body.name, content: req.body.content ?? src?.content, mcp: req.body.mcp !== undefined ? req.body.mcp : src ? personas.mcpOf(src) : undefined, skills: req.body.skills !== undefined ? req.body.skills : src ? personas.skillsOf(src) : undefined }, req.user.username)));
}));
app.get('/api/personas/:id', auth, wrap((req, res) => {
  const p = personas.getPersona(req.params.id);
  if (!p) return res.status(404).json({ error: 'Esa personalidad no existe' });
  res.json({ ...personaOut(p), versions: personas.versionsOf(p.id), contacts: personas.contactsOf(p.id) });
}));
app.put('/api/personas/:id', auth, adminOnly, wrap((req, res) => res.json(personaOut(personas.updatePersona(req.params.id, req.body || {}, req.user.username)))));
app.get('/api/personas/:id/accounts', auth, (req, res) => res.json(personas.accountsOf(req.params.id)));
app.put('/api/personas/:id/accounts', auth, adminOnly, wrap((req, res) => { personas.setAccountsOf(req.params.id, Array.isArray(req.body?.instances) ? req.body.instances.filter((i) => accounts.getAccount(i)) : []); res.json({ ok: true, accounts: personas.accountsOf(req.params.id) }); }));
app.post('/api/personas/:id/default', auth, adminOnly, wrap((req, res) => { personas.setDefault(req.params.id); res.json({ ok: true }); }));
app.delete('/api/personas/:id', auth, adminOnly, wrap((req, res) => { personas.deletePersona(req.params.id); res.json({ ok: true }); }));

// asignar una personalidad a un contacto (jid o número); null = volver a la predeterminada
app.put('/api/contacts/:jid/persona', auth, adminOnly, wrap((req, res) => {
  let jid = decodeURIComponent(req.params.jid).trim();
  if (/^\+?[\d\s-]{6,}$/.test(jid)) jid = `${jid.replace(/\D/g, '')}@s.whatsapp.net`;
  if (req.body?.instance && !jid.includes('::')) { if (!accounts.getAccount(req.body.instance)) return res.status(404).json({ error: 'Ese número no existe' }); jid = accounts.chatKey(req.body.instance, jid); }
  if (!/^[\w.+-]+@(s\.whatsapp\.net|g\.us|lid)$/.test(accounts.splitKey(jid).jid) && !jid.startsWith('playground:')) return res.status(400).json({ error: 'Número o contacto inválido (usá el número con código de país, ej. 595981123456)' });
  const id = req.body.personaId ?? null;
  if (id !== null && !personas.getPersona(id)) return res.status(404).json({ error: 'Esa personalidad no existe' });
  getContact(jid);
  db.prepare('UPDATE contacts SET persona_id = ? WHERE jid = ?').run(id, jid);
  res.json({ ok: true, jid });
}));
app.get('/api/persona/versions/:id', auth, (req, res) => res.json(persona.getVersion(req.params.id) || {}));
app.put('/api/persona/skills/:name', auth, adminOnly, wrap((req, res) => {
  persona.writeSkill(req.params.name, String(req.body.content || ''), req.user.username);
  res.json({ ok: true });
}));
app.delete('/api/persona/skills/:name', auth, adminOnly, wrap((req, res) => { persona.deleteSkill(req.params.name); res.json({ ok: true }); }));

// ---------- reglas de respuesta ----------
const ruleScope = (req) => { const i = req.query.instance ? String(req.query.instance) : null; if (i && !accounts.getAccount(i)) throw Object.assign(new Error('Ese número no existe'), { status: 404 }); return i; };
const rulesOut = (i) => ({ ...readRules(i), _overridden: i ? accountOverrideKeys(i) : [] });
app.get('/api/rules', auth, wrap((req, res) => res.json(rulesOut(ruleScope(req)))));
app.put('/api/rules', auth, adminOnly, wrap((req, res) => { const i = ruleScope(req); writeRules(req.body || {}, i); res.json(rulesOut(i)); }));
app.delete('/api/rules', auth, adminOnly, wrap((req, res) => { const i = ruleScope(req); if (i) accounts.setRulesOverride(i, null); res.json(rulesOut(i)); })); // volver a heredar todo lo general
// grupos que el agente ya conoce (para personalizar cada uno en Reglas)
app.get('/api/groups', auth, (req, res) => res.json(db.prepare("SELECT c.jid, c.name, c.last_message_at, (SELECT COUNT(*) FROM messages m WHERE m.jid = c.jid) AS total FROM contacts c WHERE c.jid LIKE '%@g.us' ORDER BY c.last_message_at DESC").all().map((g) => { const k = accounts.splitKey(g.jid); return { ...g, wa_jid: k.jid, instance: k.instance }; }).filter((g) => !req.query.instance || g.instance === req.query.instance)));

// miembros de los grupos (para elegir a quién se le permite activarlo): de un grupo (jid de WhatsApp) o de todos los de esa línea
app.get('/api/groups/members', auth, wrap(async (req, res) => {
  const instance = String(req.query.instance || evo.PRIMARY_INSTANCE());
  if (!accounts.getAccount(instance)) return res.status(404).json({ error: 'Ese número no existe' });
  const num = (j) => String(j || '').split('@')[0].split(':')[0].replace(/\D/g, '');
  const parts = await evo.withInstance(instance, async () => req.query.jid ? evo.groupParticipants(String(req.query.jid), true) : (await evo.fetchAllGroups().catch(() => [])).flatMap((g) => g.participants || []));
  const seen = new Map();
  for (const p of parts) { const n = num(p.phoneNumber) || (/@s\.whatsapp\.net$/.test(String(p.id)) ? num(p.id) : ''); if (/^\d{6,}$/.test(n)) seen.set(n, { number: n, admin: !!p.admin }); }
  res.json([...seen.values()]);
}));

// ---------- cookies para descargas (YouTube, etc.) ----------
app.get('/api/secrets/cookies', auth, (req, res) => res.json(cookiesStatus()));
app.put('/api/secrets/cookies', auth, adminOnly, express.json({ limit: '2mb' }), wrap((req, res) => res.json(saveCookies(String(req.body?.content || '')))));
app.delete('/api/secrets/cookies', auth, adminOnly, (req, res) => { deleteCookies(); res.json(cookiesStatus()); });

// ---------- tareas delegadas a sub agentes ----------
app.get('/api/tasks', auth, (req, res) => res.json(tasks.listTasks({ jid: req.query.jid ? String(req.query.jid) : undefined, limit: Math.min(200, Number(req.query.limit) || 100) })));
app.post('/api/tasks/delete', auth, adminOnly, wrap((req, res) => res.json(tasks.deleteTasks(req.body || {}))));
app.post('/api/tasks/:id/cancel', auth, adminOnly, wrap((req, res) => { tasks.cancelTask(Number(req.params.id)); res.json({ ok: true }); }));
// lo usa la herramienta delegate_task del agente (token interno aleatorio por arranque; el agente nunca lo ve en su entorno)
app.post('/internal/tasks', wrap((req, res) => {
  const t = String(req.headers['x-kiri-token'] || '');
  if (t.length !== INTERNAL_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(INTERNAL_TOKEN))) return res.status(401).json({ error: 'token inválido' });
  res.json(tasks.createTask(String(req.body?.jid || ''), req.body || {}));
}));

app.get('/api/models', auth, wrap(async (req, res) => res.json(req.query.engine === 'opencode' ? await listOpencodeModels({ refresh: req.query.refresh === '1' }) : await listModels())));
app.get('/api/engines', auth, wrap(async (req, res) => { const oc = await listOpencodeModels(), st = engines.engineStates(); res.json({ claude: { installed: true, paused: st.claude }, opencode: { installed: oc.installed, models: oc.models.length, free: oc.models.filter((m) => m.free).length, paused: st.opencode }, settings: engines.readEngineSettings() }); }));
// ---- Claude Code: iniciar sesión desde el panel ----
app.get('/api/engines/claude/auth', auth, adminOnly, wrap(async (req, res) => res.json(await claudeLogin.claudeAuthStatus())));
app.post('/api/engines/claude/login', auth, adminOnly, wrap(async (req, res) => res.json(await claudeLogin.startLogin({ mode: req.body?.mode === 'console' ? 'console' : 'claudeai' }))));
app.post('/api/engines/claude/login/code', auth, adminOnly, wrap(async (req, res) => res.json(await claudeLogin.submitCode(String(req.body?.id || ''), req.body?.code))));
app.post('/api/engines/claude/logout', auth, adminOnly, wrap(async (req, res) => res.json(await claudeLogin.claudeLogout())));
app.put('/api/engines/claude/use-login', auth, adminOnly, wrap(async (req, res) => { claudeLogin.setUsePanelLogin(!!req.body?.on); res.json(await claudeLogin.claudeAuthStatus()); }));
// ---- OpenCode: proveedores y claves (formato propio de OpenCode) ----
app.get('/api/engines/opencode/providers', auth, adminOnly, wrap(async (req, res) => res.json({ connected: await ocAccounts.connected(), catalog: await ocAccounts.providerCatalog() })));
app.post('/api/engines/opencode/providers', auth, adminOnly, wrap((req, res) => { ocAccounts.connectProvider(String(req.body?.id || ''), req.body?.key); res.json({ ok: true }); }));
app.post('/api/engines/opencode/custom', auth, adminOnly, wrap((req, res) => { ocAccounts.addCustomProvider(req.body || {}); res.json({ ok: true }); }));
app.delete('/api/engines/opencode/providers/:id', auth, adminOnly, wrap((req, res) => { ocAccounts.disconnectProvider(req.params.id); res.json({ ok: true }); }));
app.get('/api/engines/opencode/providers/:id/models', auth, adminOnly, wrap(async (req, res) => res.json(await ocAccounts.providerModels(req.params.id))));
app.put('/api/engines/opencode/providers/:id/whitelist', auth, adminOnly, wrap((req, res) => { ocAccounts.setWhitelist(req.params.id, req.body?.models); res.json({ ok: true }); }));
app.post('/api/engines/opencode/providers/:id/test', auth, adminOnly, wrap(async (req, res) => res.json(await ocAccounts.testProvider(req.params.id, req.body?.model ? String(req.body.model) : undefined))));
app.get('/api/engines/transcription', auth, adminOnly, (req, res) => res.json(groqStatus()));
app.put('/api/engines/transcription', auth, adminOnly, wrap((req, res) => res.json(saveGroqKey(req.body?.key))));
app.delete('/api/engines/transcription', auth, adminOnly, (req, res) => res.json(deleteGroqKey()));
app.post('/api/engines/transcription/test', auth, adminOnly, wrap(async (req, res) => res.json(await testGroq(req.body?.key))));
app.get('/api/engines/opencode/version', auth, wrap(async (req, res) => { const [version, latest] = [opencodeVersion(), await latestOpencodeVersion()]; res.json({ version, latest, updated: usingUpdatedCopy(), canUpdate: !!latest && !!version && latest !== version }); }));
app.post('/api/engines/opencode/update', auth, adminOnly, wrap(async (req, res) => res.json(await updateOpencode(String(req.body?.version || 'latest')))));
app.post('/api/engines/opencode/revert', auth, adminOnly, wrap((req, res) => res.json({ version: revertOpencode() })));
// prueba real de cada motor con una pregunta mínima (gasta unos pocos tokens)
app.post('/api/engines/health', auth, adminOnly, wrap(async (req, res) => {
  const t = async (fn) => { const t0 = Date.now(); try { const out = await fn(); return { ok: true, ms: Date.now() - t0, sample: String(out).slice(0, 40) }; } catch (e) { return { ok: false, ms: Date.now() - t0, error: String(e.message).slice(0, 240) }; } };
  const [claude, opencode] = await Promise.all([t(() => askClaude('Respondé solo con la palabra: ok', { model: 'haiku', timeoutMs: 60000 })), t(() => askOpencode('Respondé solo con la palabra: ok', { timeoutMs: 90000 }))]);
  res.json({ claude, opencode });
}));
app.get('/api/usage', auth, (req, res) => res.json(engines.usageSummary(Number(req.query.days) || 30)));
app.put('/api/engines/settings', auth, adminOnly, wrap((req, res) => res.json(engines.writeEngineSettings(req.body || {}))));
app.post('/api/engines/:engine/resume', auth, adminOnly, wrap((req, res) => { if (!['claude', 'opencode'].includes(req.params.engine)) return res.status(404).json({ error: 'Motor desconocido' }); engines.clearPause(req.params.engine); res.json({ ok: true }); })); // «reintentar ahora»: quita la pausa por límite

// ---------- servidores MCP (herramientas externas del agente) ----------
// Solo admin: un MCP stdio ejecuta un comando dentro del contenedor del agente.
app.get('/api/mcp', auth, wrap(async (req, res) => { await mcp.adoptNative(); res.json({ servers: mcp.listServers().map(mcp.publicView), agentCanInstall: mcpAgentFlag() }); }));
app.post('/api/mcp/import', auth, adminOnly, express.json({ limit: '200kb' }), wrap(async (req, res) => res.json({ servers: await mcp.addFromText(req.body?.text, { test: req.body?.test !== false }) })));
app.put('/api/mcp/:name', auth, adminOnly, express.json({ limit: '200kb' }), wrap((req, res) => {
  const def = mcp.normalize(req.params.name, req.body || {}); def.name = req.params.name;
  res.json(mcp.publicView(mcp.saveServer(def)));
}));
app.post('/api/mcp/:name/test', auth, adminOnly, wrap(async (req, res) => res.json(await mcp.testServer(req.params.name))));
app.post('/api/mcp/:name/enabled', auth, adminOnly, wrap((req, res) => res.json(mcp.publicView(mcp.setEnabled(req.params.name, !!req.body?.enabled)))));
app.delete('/api/mcp/:name', auth, adminOnly, wrap((req, res) => res.json({ ok: mcp.removeServer(req.params.name) })));
app.post('/api/mcp/:name/login', auth, adminOnly, wrap(async (req, res) => res.json(await mcpOauth.startLogin(req.params.name))));
// el proveedor devuelve a la persona acá tras iniciar sesión (sin sesión del panel: se valida con `state`, de un solo uso y 20 min)
app.get('/api/mcp/oauth/callback', wrap(async (req, res) => {
  const page = (ok, title, text) => res.status(ok ? 200 : 400).type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body style="font-family:system-ui;max-width:440px;margin:18vh auto;padding:0 20px;text-align:center"><h2>${ok ? '✅' : '⚠️'} ${title}</h2><p>${text}</p>`);
  if (req.query.error) return page(false, 'No se completó el inicio de sesión', String(req.query.error_description || req.query.error).replace(/[<>&]/g, ''));
  try { const r = await mcpOauth.finishLogin(req.query.state, req.query.code); page(true, 'Listo, ya podés volver', `«${r.name}» quedó conectado. Podés cerrar esta pestaña y seguir en WhatsApp.`); }
  catch (e) { page(false, 'No se pudo conectar', String(e.message).replace(/[<>&]/g, '')); }
}));
app.put('/api/mcp-settings', auth, adminOnly, wrap((req, res) => { setMcpAgentFlag(!!req.body?.agentCanInstall); res.json({ agentCanInstall: mcpAgentFlag() }); }));
// lo usa la herramienta add_mcp_server del sub agente (mismo token interno que delegate_task)
app.post('/internal/mcp', wrap(async (req, res) => {
  const t = String(req.headers['x-kiri-token'] || '');
  if (t.length !== INTERNAL_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(INTERNAL_TOKEN))) return res.status(401).json({ error: 'token inválido' });
  if (!mcpAgentFlag()) return res.status(403).json({ error: 'El administrador desactivó que el agente instale MCPs por su cuenta. Pedile que lo agregue desde el panel (sección MCPs).' });
  const servers = await mcp.addFromText(req.body?.config);
  for (const s of servers) if (s.status === 'auth_required') { try { s.login_url = (await mcpOauth.startLogin(s.name, { jid: req.body?.jid || null })).url; } catch (e) { s.login_error = e.message; } }
  res.json({ servers });
}));
app.post('/internal/mcp-login', wrap(async (req, res) => {
  const t = String(req.headers['x-kiri-token'] || '');
  if (t.length !== INTERNAL_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(INTERNAL_TOKEN))) return res.status(401).json({ error: 'token inválido' });
  res.json(await mcpOauth.startLogin(String(req.body?.name || ''), { jid: req.body?.jid || null }));
}));

// ---------- memoria (memoria.md) ----------
app.get('/api/memory/global', auth, (req, res) => res.json(memory.readGlobal()));
app.put('/api/memory/global', auth, adminOnly, express.json({ limit: '100kb' }), wrap((req, res) => res.json(memory.writeGlobal(req.body?.content))));
app.get('/api/memory/account/:instance', auth, (req, res) => res.json(memory.readAccount(req.params.instance)));
app.put('/api/memory/account/:instance', auth, adminOnly, express.json({ limit: '100kb' }), wrap((req, res) => { if (!accounts.getAccount(req.params.instance)) return res.status(404).json({ error: 'Ese número no existe' }); res.json(memory.writeAccount(req.params.instance, req.body?.content)); }));
app.get('/api/memory/contacts', auth, (req, res) => res.json(memory.listContactMemories()));
app.get('/api/memory/contact/:jid', auth, (req, res) => res.json(memory.readContact(decodeURIComponent(req.params.jid))));
app.put('/api/memory/contact/:jid', auth, adminOnly, express.json({ limit: '100kb' }), wrap((req, res) => res.json(memory.writeContact(decodeURIComponent(req.params.jid), req.body?.content))));
app.delete('/api/memory/contact/:jid', auth, adminOnly, (req, res) => { memory.deleteContactMemory(decodeURIComponent(req.params.jid)); res.json({ ok: true }); });
const internalAuth = (req, res, next) => {
  const t = String(req.headers['x-kiri-token'] || '');
  if (t.length !== INTERNAL_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(INTERNAL_TOKEN))) return res.status(401).json({ error: 'token inválido' });
  next();
};
app.post('/internal/memory', internalAuth, wrap((req, res) => {
  const { jid, action, text } = req.body || {};
  if (!jid) return res.status(400).json({ error: 'falta jid' });
  if (action === 'add' && readSettingsSafe().memoryAuto === false) return res.json({ ok: false, message: 'El administrador desactivó el guardado automático de memoria.' });
  res.json(action === 'remove' ? memory.removeFacts(jid, text) : memory.addFact(jid, text));
}));

// ---------- tareas programadas / recordatorios ----------
const schedOut = (s) => ({ ...s, description: schedules.describe(s) });
app.get('/api/schedules', auth, (req, res) => res.json(schedules.listSchedules({ jid: req.query.jid ? String(req.query.jid) : undefined }).map(schedOut)));
app.post('/api/schedules', auth, adminOnly, wrap((req, res) => res.json(schedOut(schedules.createSchedule(String(req.body?.jid || ''), req.body || {}, 'panel')))));
app.post('/api/schedules/:id/:action', auth, adminOnly, wrap((req, res) => {
  const id = Number(req.params.id), a = req.params.action;
  if (a === 'pause') return res.json(schedOut(schedules.pauseSchedule(id)));
  if (a === 'resume') return res.json(schedOut(schedules.resumeSchedule(id)));
  if (a === 'cancel') return res.json(schedOut(schedules.cancelSchedule(id)));
  res.status(404).json({ error: 'acción desconocida' });
}));
app.delete('/api/schedules/:id', auth, adminOnly, (req, res) => { schedules.deleteSchedule(Number(req.params.id)); res.json({ ok: true }); });
app.post('/internal/schedules', internalAuth, wrap((req, res) => {
  const { jid, action } = req.body || {};
  if (!jid) return res.status(400).json({ error: 'falta jid' });
  if (action === 'create') { const s = schedules.createSchedule(jid, req.body, 'agente'); return res.json({ id: s.id, description: schedules.describe(s) }); }
  if (action === 'list') return res.json({ items: schedules.listSchedules({ jid }).filter((s) => ['active', 'paused'].includes(s.status)).map(schedOut) });
  if (action === 'cancel') { schedules.cancelSchedule(Number(req.body.id), jid); return res.json({ ok: true }); }
  res.status(400).json({ error: 'acción desconocida' });
}));

// ---------- perfil de comunicación por chat ----------
app.get('/api/profiling-settings', auth, (req, res) => res.json(profile.readProfileSettings()));
app.put('/api/profiling-settings', auth, adminOnly, wrap((req, res) => {
  const before = profile.readProfileSettings(), now = profile.writeProfileSettings(req.body || {});
  if (now.enabled && now.auto && (!before.enabled || JSON.stringify(before.personas) !== JSON.stringify(now.personas))) profile.backfillProfiles().catch(() => {}); // al activarla, empieza ya con los chats recientes
  res.json(now);
}));
app.get('/api/profile-overview', auth, (req, res) => res.json(profile.profileOverview()));
app.post('/api/profile-backfill', auth, adminOnly, wrap(async (req, res) => res.json(await profile.backfillProfiles({ limit: Math.min(50, Number(req.body?.limit) || 15) }))));
app.get('/api/profile/:jid', auth, (req, res) => res.json(profile.readProfile(decodeURIComponent(req.params.jid)) || {}));
app.put('/api/profile/:jid', auth, adminOnly, wrap((req, res) => res.json(profile.editProfile(decodeURIComponent(req.params.jid), req.body?.text) || {})));
app.delete('/api/profile/:jid', auth, adminOnly, (req, res) => { profile.deleteProfile(decodeURIComponent(req.params.jid)); res.json({ ok: true }); });
app.post('/api/profile/:jid/generate', auth, adminOnly, wrap(async (req, res) => {
  const key = decodeURIComponent(req.params.jid);
  res.json(await evo.withInstance(accounts.splitKey(key).instance, () => profile.generateProfile(key, { force: true })));
}));

// agrega un chat a "Memorias por contacto" sin que haya escrito: queda conocido (no se le responde por eso, las reglas siguen mandando)
app.post('/api/contacts/ensure', auth, adminOnly, wrap((req, res) => {
  const instance = String(req.body?.instance || evo.PRIMARY_INSTANCE()), number = String(req.body?.number || '').replace(/\D/g, '');
  if (!accounts.getAccount(instance)) return res.status(404).json({ error: 'Ese número de WhatsApp no existe' });
  if (number.length < 6) return res.status(400).json({ error: 'Número inválido (usá el código de país, ej. 595981123456)' });
  const key = accounts.chatKey(instance, `${number}@s.whatsapp.net`);
  getContact(key, req.body?.name ? String(req.body.name).slice(0, 80) : null);
  res.json({ jid: key });
}));
// contactos elegibles para las listas permitida/bloqueada: los de WhatsApp de esa línea (si Evolution los guarda) + todos los que ya escribieron
const contactCache = new Map();
app.get('/api/contacts', auth, wrap(async (req, res) => {
  const only = req.query.instance ? String(req.query.instance) : null;
  if (only && !accounts.getAccount(only)) return res.status(404).json({ error: 'Ese número no existe' });
  const out = new Map();
  const put = (instance, number, name) => {
    if (!/^\d{6,}$/.test(number)) return;
    const k = `${instance}:${number}`, cur = out.get(k);
    out.set(k, { instance, instanceLabel: accounts.labelFor(`${instance}::x`), number, name: cur?.name || name || null });
  };
  for (const a of accounts.listAccounts().filter((x) => !only || x.instance === only)) {
    for (const c of db.prepare('SELECT jid, name FROM contacts').all()) { const k = accounts.splitKey(c.jid); if (k.instance === a.instance && k.jid.endsWith('@s.whatsapp.net')) put(a.instance, k.jid.split('@')[0], c.name); }
    for (const c of db.prepare('SELECT number, name FROM seen_contacts WHERE instance = ?').all(a.instance)) put(a.instance, c.number, c.name);
    let evoList = contactCache.get(a.instance);
    if (!evoList || Date.now() - evoList.at > 120e3) { evoList = { at: Date.now(), list: await evo.withInstance(a.instance, () => evo.findContacts()).catch(() => []) }; contactCache.set(a.instance, evoList); }
    for (const c of evoList.list) put(a.instance, c.number, c.name);
  }
  const list = [...out.values()].sort((x, y) => String(x.name || '~').localeCompare(String(y.name || '~')));
  res.json({ contacts: list, fromEvolution: [...contactCache.values()].some((v) => v.list.length > 0) });
}));

// ---------- paneles (secciones que arma el agente: tablas, calendario, tablero, notas) ----------
// Cada panel/colección tiene DUEÑO: el hub (null) o un chat. El admin ve todo desde acá; cada persona ve solo lo suyo desde su enlace personal (/p/<token>).
const ownerQ = (v) => (v === undefined || v === '' ? undefined : v === 'hub' ? null : String(v)); // filtro de lectura: sin dato = todo
const ownerW = (v) => (v === undefined || v === '' || v === 'hub' || v === null ? null : String(v)); // dueño al crear
const ownerInfo = (key) => (key ? { owner_name: db.prepare('SELECT name FROM contacts WHERE jid = ?').get(key)?.name || accounts.splitKey(key).jid.split('@')[0], owner_label: accounts.labelFor(key) } : { owner_name: null, owner_label: null });
const linkUrl = (token) => `${(process.env.HUB_BASE_URL || process.env.HUB_PUBLIC_URL || '').replace(/\/$/, '')}/p/${token}`;
app.get('/api/panel-settings', auth, (req, res) => res.json(panels.readPanelSettings()));
app.put('/api/panel-settings', auth, adminOnly, wrap((req, res) => res.json(panels.writePanelSettings(req.body || {}))));
app.get('/api/panel-templates', auth, (req, res) => res.json(panels.TEMPLATES));
app.get('/api/panels', auth, (req, res) => res.json(panels.listPanels({ owner: ownerQ(req.query.owner) }).map((p) => ({ ...p, ...ownerInfo(p.owner) }))));
app.get('/api/panel-owners', auth, (req, res) => { const keys = [...new Set(panels.listPanels().map((p) => p.owner).filter(Boolean))]; res.json(keys.map((k) => ({ key: k, ...ownerInfo(k) }))); });
app.post('/api/panels', auth, adminOnly, wrap((req, res) => { const owner = ownerW(req.body?.owner); res.json(req.body?.template ? panels.createFromTemplate(req.body.template, { title: req.body.title, owner }) : panels.createPanel({ title: req.body?.title, folder: req.body?.folder, widgets: req.body?.widgets || [], owner })); }));
app.get('/api/panels/:id', auth, wrap((req, res) => {
  const p = panels.getPanel(req.params.id); if (!p) return res.status(404).json({ error: 'Ese panel no existe' });
  const ids = [...new Set(p.widgets.map((w) => w.collection).filter((c) => c && c !== 'reminders'))];
  res.json({ panel: { ...p, ...ownerInfo(p.owner) }, collections: ids.map((id) => panels.getCollection(id)).filter(Boolean) });
}));
app.put('/api/panels/:id', auth, adminOnly, wrap((req, res) => res.json(panels.updatePanel(req.params.id, req.body || {}))));
app.delete('/api/panels/:id', auth, adminOnly, wrap((req, res) => { panels.deletePanel(req.params.id); res.json({ ok: true }); }));
app.get('/api/collections', auth, (req, res) => res.json(panels.listCollections({ owner: ownerQ(req.query.owner) })));
app.post('/api/collections', auth, adminOnly, wrap((req, res) => res.json(panels.createCollection({ ...(req.body || {}), owner: ownerW(req.body?.owner) }))));
app.put('/api/collections/:id', auth, adminOnly, wrap((req, res) => res.json(panels.renameCollection(req.params.id, req.body?.name))));
app.delete('/api/collections/:id', auth, adminOnly, wrap((req, res) => { panels.deleteCollection(req.params.id); res.json({ ok: true }); }));
app.post('/api/collections/:id/fields', auth, adminOnly, wrap((req, res) => res.json(panels.addField(req.params.id, req.body || {}))));
app.put('/api/collections/:id/fields/:key', auth, adminOnly, wrap((req, res) => res.json(panels.updateField(req.params.id, req.params.key, req.body || {}))));
app.get('/api/collections/:id/rows', auth, wrap((req, res) => res.json(panels.listRows(req.params.id, { q: String(req.query.q || ''), filter: String(req.query.filter || '').slice(0, 6000), limit: req.query.limit, offset: req.query.offset }))));
app.post('/api/collections/:id/rows', auth, adminOnly, wrap((req, res) => res.json(panels.addRows(req.params.id, Array.isArray(req.body?.rows) ? req.body.rows : [req.body?.row || {}], req.user.username))));
app.put('/api/collections/:id/rows/:rid', auth, adminOnly, wrap((req, res) => res.json(panels.updateRow(req.params.id, req.params.rid, req.body || {}, req.user.username))));
app.delete('/api/collections/:id/rows/:rid', auth, adminOnly, wrap((req, res) => { panels.deleteRow(req.params.id, req.params.rid, req.user.username); res.json({ ok: true }); }));
app.get('/api/collections/:id/history', auth, wrap((req, res) => res.json(panels.historyOf(req.params.id))));
app.post('/api/history/:hid/revert', auth, adminOnly, wrap((req, res) => res.json(panels.revert(req.params.hid))));
const sendExport = (res, x) => res.set({ 'Content-Type': x.type, 'Content-Disposition': `attachment; filename="${x.name}"` }).send(x.body);
app.get('/api/collections/:id/export', auth, wrap((req, res) => sendExport(res, panels.exportCollection(req.params.id, req.query.format === 'json' ? 'json' : 'csv', {}, String(req.query.filter || '').slice(0, 6000)))));
app.get('/api/panel-events', auth, wrap((req, res) => res.json(panels.reminderEvents(Number(req.query.from) || Date.now(), Number(req.query.to) || Date.now() + 31 * 864e5, { owner: ownerQ(req.query.owner) === null ? undefined : ownerQ(req.query.owner) }))));
// enlaces personales: el admin los ve, rota o revoca
app.get('/api/panel-links', auth, adminOnly, (req, res) => res.json(panels.listLinks().map((l) => ({ owner: l.owner, ...ownerInfo(l.owner), url: linkUrl(l.token), created_at: l.created_at, last_used: l.last_used, uses: l.uses }))));
app.post('/api/panel-links', auth, adminOnly, wrap((req, res) => { const k = String(req.body?.owner || ''); if (!k || (!db.prepare('SELECT 1 FROM contacts WHERE jid = ?').get(k) && !panels.listLinks().some((l) => l.owner === k))) return res.status(404).json({ error: 'Ese chat no existe' }); res.json({ owner: k, url: linkUrl((req.body?.rotate ? panels.rotateLink(k) : panels.ensureLink(k)).token) }); }));
app.delete('/api/panel-links/:owner', auth, adminOnly, (req, res) => { panels.revokeLink(decodeURIComponent(req.params.owner)); res.json({ ok: true }); });

// ----- versión personal (sin contraseña): /p/<token> muestra SOLO los paneles y datos del chat dueño del enlace -----
const hits = new Map(); // limitador simple por IP
const limited = (ip, max, windowMs, bucket) => { const k = `${bucket}:${ip}`, now = Date.now(), h = (hits.get(k) || []).filter((t) => now - t < windowMs); h.push(now); hits.set(k, h); if (hits.size > 5000) hits.clear(); return h.length > max; };
const personalHeaders = (req, res, next) => {
  res.set({ 'X-Robots-Tag': 'noindex, nofollow, noarchive', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" });
  next();
};
const personal = (req, res, next) => {
  if (limited(req.ip, 600, 60e3, 'p')) return res.status(429).json({ error: 'Demasiadas solicitudes, probá en un minuto' });
  const owner = panels.readPanelSettings().personalLinks ? panels.ownerOfToken(req.params.token) : null;
  if (!owner) { if (limited(req.ip, 30, 600e3, 'bad')) return res.status(429).json({ error: 'Demasiados intentos' }); return res.status(404).json({ error: 'Este enlace no es válido o ya no está activo' }); }
  req.owner = owner;
  next();
};
const P = '/api/p/:token';
app.use(P, personalHeaders);
app.get(`${P}/me`, personal, (req, res) => res.json({ name: db.prepare('SELECT name FROM contacts WHERE jid = ?').get(req.owner)?.name || null, panels: panels.listPanels({ owner: req.owner }) }));
app.get(`${P}/panels/:id`, personal, wrap((req, res) => {
  const p = panels.getPanel(req.params.id, { owner: req.owner }); if (!p) return res.status(404).json({ error: 'Ese panel no existe' });
  const ids = [...new Set(p.widgets.map((w) => w.collection).filter((c) => c && c !== 'reminders'))];
  res.json({ panel: p, collections: ids.map((id) => panels.getCollection(id, { owner: req.owner })).filter(Boolean) });
}));
app.get(`${P}/collections`, personal, (req, res) => res.json(panels.listCollections({ owner: req.owner })));
app.get(`${P}/collections/:id/rows`, personal, wrap((req, res) => res.json(panels.listRows(req.params.id, { q: String(req.query.q || ''), filter: String(req.query.filter || '').slice(0, 6000), limit: req.query.limit, offset: req.query.offset }, { owner: req.owner }))));
app.post(`${P}/collections/:id/rows`, personal, wrap((req, res) => res.json(panels.addRows(req.params.id, Array.isArray(req.body?.rows) ? req.body.rows : [req.body?.row || {}], 'enlace personal', { owner: req.owner }))));
app.put(`${P}/collections/:id/rows/:rid`, personal, wrap((req, res) => res.json(panels.updateRow(req.params.id, req.params.rid, req.body || {}, 'enlace personal', { owner: req.owner }))));
app.delete(`${P}/collections/:id/rows/:rid`, personal, wrap((req, res) => { panels.deleteRow(req.params.id, req.params.rid, 'enlace personal', { owner: req.owner }); res.json({ ok: true }); }));
app.get(`${P}/collections/:id/history`, personal, wrap((req, res) => res.json(panels.historyOf(req.params.id, 30, { owner: req.owner }))));
app.post(`${P}/history/:hid/revert`, personal, wrap((req, res) => res.json(panels.revert(req.params.hid, { owner: req.owner }))));
app.get(`${P}/collections/:id/export`, personal, wrap((req, res) => sendExport(res, panels.exportCollection(req.params.id, req.query.format === 'json' ? 'json' : 'csv', { owner: req.owner }, String(req.query.filter || '').slice(0, 6000)))));
app.get(`${P}/panel-events`, personal, wrap((req, res) => res.json(panels.reminderEvents(Number(req.query.from) || Date.now(), Number(req.query.to) || Date.now() + 31 * 864e5, { owner: req.owner }))));
app.get(`${P}/documents`, personal, (req, res) => res.json(documents.listDocuments({ owner: req.owner })));
app.get(`${P}/documents/:id/file`, personal, wrap((req, res) => sendDoc(res, needDoc(req.params.id, req.owner), req.query.download === '1')));
app.get(`${P}/documents/:id/preview`, personal, wrap(async (req, res) => res.json(await documents.preview(needDoc(req.params.id, req.owner)))));
app.use(P, (req, res) => res.status(404).json({ error: 'No encontrado' })); // cualquier otra ruta (estructura, ajustes, hub…) no existe para un enlace personal
// documentos: lista, sube (admin), borra, archivo y vista previa. Cada uno con su dueño, igual que los paneles.
const sendDoc = (res, d, download) => {
  const inline = !download && d.view === 'image';
  res.set({ 'Content-Type': inline ? d.mime : d.view === 'pdf' ? 'application/pdf' : 'application/octet-stream', 'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(d.name)}`,
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox", 'Cache-Control': 'private, no-store' }).send(documents.readDocument(d));
};
const needDoc = (id, owner) => { const d = documents.getDocument(id, { owner }); if (!d) throw Object.assign(new Error('Ese documento no existe'), { status: 404 }); return d; };
app.get('/api/documents', auth, (req, res) => res.json(documents.listDocuments({ owner: ownerQ(req.query.owner) }).map((d) => ({ ...d, ...ownerInfo(d.owner) }))));
app.post('/api/documents', auth, adminOnly, express.raw({ type: () => true, limit: '26mb' }), wrap((req, res) => res.json(documents.saveDocument({ owner: ownerW(req.query.owner), name: String(req.query.name || 'archivo'), buffer: req.body, by: req.user.username }))));
app.delete('/api/documents/:id', auth, adminOnly, wrap((req, res) => { documents.deleteDocument(req.params.id); res.json({ ok: true }); }));
app.get('/api/documents/:id/file', auth, wrap((req, res) => sendDoc(res, needDoc(req.params.id), req.query.download === '1')));
app.get('/api/documents/:id/preview', auth, wrap(async (req, res) => res.json(await documents.preview(needDoc(req.params.id)))));
app.post('/internal/documents', internalAuth, express.json({ limit: '40mb' }), wrap((req, res) => {
  const b = req.body || {}; if (!b.jid) return res.status(400).json({ error: 'falta jid' });
  if (!panels.readPanelSettings().enabled) return res.status(403).json({ error: 'Los paneles no están habilitados.' });
  res.json(documents.saveDocument({ owner: String(b.jid), name: b.name, title: b.title, buffer: Buffer.from(String(b.data_b64 || ''), 'base64'), by: 'agente' }));
}));
app.post('/internal/panels', internalAuth, wrap((req, res) => {
  if (!req.body?.jid) return res.status(400).json({ error: 'falta jid' });
  res.json(agentCall(String(req.body.jid), String(req.body.action || ''), req.body));
}));

// ---------- necesita atención (pasar a un humano) ----------
app.get('/api/attention', auth, (req, res) => res.json({ items: attention.listItems({ status: req.query.status ? String(req.query.status) : undefined }).map((a) => ({ ...a, instanceLabel: accounts.labelFor(a.jid), wa_jid: accounts.splitKey(a.jid).jid })), open: attention.openCount() }));
app.post('/api/attention/:id/resolve', auth, adminOnly, wrap((req, res) => res.json(attention.resolveItem(Number(req.params.id), { resume: req.body?.resume !== false }))));
app.get('/api/attention-settings', auth, (req, res) => res.json(attention.readAttentionSettings()));
app.put('/api/attention-settings', auth, adminOnly, wrap((req, res) => res.json(attention.writeAttentionSettings(req.body || {}))));
app.post('/internal/attention', internalAuth, wrap((req, res) => {
  if (!req.body?.jid) return res.status(400).json({ error: 'falta jid' });
  res.json(attention.requestHuman(String(req.body.jid), req.body));
}));

// ---------- conversaciones que inicia el agente ----------
app.post('/internal/outreach', internalAuth, wrap(async (req, res) => {
  const b = req.body || {}, key = String(b.jid || '');
  if (!key) return res.status(400).json({ error: 'falta jid' });
  try {
    if (b.action === 'start') return res.json({ message: await outreach.start(key, b) });
    if (b.action === 'pending') return res.json({ message: outreach.pendingText(key) });
    if (b.action === 'edit') return res.json({ message: await outreach.edit(key, Number(b.id), b.text) });
    if (b.action === 'cancel') return res.json({ message: await outreach.cancel(key, Number(b.id)) });
    res.status(400).json({ error: 'acción desconocida' });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
}));
// ---------- notas de voz (ElevenLabs) ----------
app.post('/internal/voice', internalAuth, wrap(async (req, res) => {
  const key = String(req.body?.jid || '');
  if (!key) return res.status(400).json({ error: 'falta jid' });
  try {
    if (!voice.enabledFor(personas.resolveFor(getContact(key)))) return res.status(403).json({ error: 'Las notas de voz no están activadas para esta personalidad.' });
    const r = await voice.speak(key, req.body?.text);
    res.json({ audio: r.audio.toString('base64'), chars: r.chars });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
}));
app.get('/api/voice', auth, adminOnly, wrap((req, res) => res.json({ settings: voice.readSettings(), defaults: { guide: voice.DEFAULT_GUIDE }, key: voice.keyStatus(), usage: voice.usageToday() })));
app.get('/api/voice/edge-voices', auth, adminOnly, wrap(async (req, res) => { try { res.json({ voices: await voice.listEdgeVoices() }); } catch (e) { res.json({ voices: [], error: e.message }); } }));
app.get('/api/voice/usage', auth, adminOnly, wrap(async (req, res) => { try { res.json({ ok: true, ...(await voice.usage()) }); } catch (e) { res.json({ ok: false, error: e.message }); } }));
app.get('/api/voice/models', auth, adminOnly, wrap(async (req, res) => { try { res.json({ models: await voice.listModels({ fresh: req.query.fresh === '1' }) }); } catch (e) { res.json({ models: [], error: e.message }); } }));
app.get('/api/voice/voices', auth, adminOnly, wrap(async (req, res) => { try { res.json({ voices: await voice.listVoices({ premadeOnly: req.query.premade === '1' }) }); } catch (e) { res.json({ voices: [], error: e.message }); } }));
app.put('/api/voice/settings', auth, adminOnly, wrap((req, res) => res.json(voice.writeSettings(req.body || {}))));
app.put('/api/voice/key', auth, adminOnly, wrap((req, res) => res.json(voice.saveKey(req.body?.key))));
app.delete('/api/voice/key', auth, adminOnly, (req, res) => res.json(voice.deleteKey()));
app.post('/api/voice/test', auth, adminOnly, wrap(async (req, res) => {
  try { const r = await voice.test(req.body?.text, req.body?.settings || {}, req.body?.engine); res.json({ ok: true, audio: r.audio.toString('base64'), mime: 'audio/mpeg', ms: r.ms, chars: r.chars, engine: r.engine }); }
  catch (e) { res.json({ ok: false, error: e.message }); }
}));
// ---------- apps del agente (Docker aislado + URLs públicas con aprobación por WhatsApp) ----------
app.post('/internal/apps', internalAuth, wrap(async (req, res) => {
  const b = req.body || {}, key = String(b.jid || '');
  if (!key) return res.status(400).json({ error: 'falta jid' });
  try {
    if (b.action === 'publish') return res.json({ message: await apps.publish(key, b) });
    if (b.action === 'unpublish') { const o = apps.unpublish(key, b.app); return res.json({ message: `Listo: «${o.name}» ya no está publicada.` }); }
    if (b.action === 'list') return res.json({ message: apps.listFor(key) });
    res.status(400).json({ error: 'acción desconocida' });
  } catch (e) { res.status(e.status || 400).json({ error: e.message }); }
}));
const bashOn = () => (readSettingsSafe().allowedTools || []).some((t) => t === 'Bash' || String(t).startsWith('Bash('));
app.get('/api/apps', auth, wrap(async (req, res) => res.json({ settings: apps.readSettings(), available: apps.available(), bashEnabled: bashOn(), docker: await apps.dockerStatus(), items: await apps.listAll({ status: req.query.status ? String(req.query.status) : undefined }) })));
app.put('/api/apps/settings', auth, adminOnly, wrap((req, res) => res.json(apps.writeSettings(req.body || {}))));
app.post('/api/apps/:id/approve', auth, adminOnly, wrap(async (req, res) => { try { res.json(await apps.approve(Number(req.params.id), 'panel')); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } }));
app.post('/api/apps/:id/reject', auth, adminOnly, wrap(async (req, res) => { try { res.json(await apps.reject(Number(req.params.id), 'panel')); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } }));
app.post('/api/apps/:id/unpublish', auth, adminOnly, wrap((req, res) => res.json(apps.unpublish(null, String(Number(req.params.id))))));
app.post('/api/apps/prune', auth, adminOnly, wrap(async (req, res) => res.json(await apps.prune(Number(req.body?.hours) || 72))));
app.get('/api/outreach/settings', auth, (req, res) => res.json({ ...outreach.readSettings(), overview: outreach.overview() }));
app.put('/api/outreach/settings', auth, adminOnly, wrap((req, res) => res.json({ ...outreach.writeSettings(req.body || {}), overview: outreach.overview() })));
app.get('/api/outreach/targets', auth, (req, res) => res.json(outreach.listTargets().map((t) => ({ ...t, name: t.alias || null }))));
app.put('/api/outreach/targets', auth, adminOnly, wrap((req, res) => res.json(outreach.saveTarget(req.body || {}))));
app.delete('/api/outreach/targets/:number', auth, adminOnly, (req, res) => { outreach.deleteTarget(req.params.number); res.json({ ok: true }); });
app.get('/api/outreach/log', auth, (req, res) => res.json(outreach.listLog({ status: req.query.status ? String(req.query.status) : undefined, limit: req.query.limit })));
app.post('/api/outreach/log/:id/approve', auth, adminOnly, wrap(async (req, res) => { try { res.json(await outreach.approve(Number(req.params.id), 'panel')); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } }));
app.post('/api/outreach/log/:id/reject', auth, adminOnly, wrap(async (req, res) => { try { res.json(await outreach.reject(Number(req.params.id), 'panel')); } catch (e) { res.status(e.status || 400).json({ error: e.message }); } }));
// ¿Tiene WhatsApp este número? (para agregar destinatarios desde el panel)
// asistente del Hub (chat flotante): contesta con el motor configurado; los cambios de ajustes solo se aplican por /apply (solo administradores)
let assistantBusy = 0;
app.post('/api/assistant/chat', auth, wrap(async (req, res) => {
  if (assistantBusy >= 4) return res.status(429).json({ error: 'El asistente está ocupado con otras consultas. Probá en unos segundos.' });
  assistantBusy++;
  try {
    const admin = req.user.role === 'admin';
    const out = await assistant.ask(req.body || {}, { user: req.user.username, admin });
    res.json({ ...out, actions: admin ? out.actions : out.actions.filter((a) => a.type !== 'apply') });
  } finally { assistantBusy--; }
}));
app.post('/api/assistant/apply', auth, adminOnly, wrap((req, res) => res.json(assistant.applyChange(String(req.body?.area || ''), req.body?.changes))));
app.post('/api/outreach/check', auth, adminOnly, wrap(async (req, res) => {
  const number = String(req.body?.number || '').replace(/\D/g, ''), instance = String(req.body?.instance || evo.PRIMARY_INSTANCE());
  if (number.length < 8 || number.length > 15) return res.status(400).json({ error: 'El número no es válido (usá el código de país, ej. 595981123456).' });
  if (!accounts.getAccount(instance)) return res.status(404).json({ error: 'Ese número de WhatsApp no existe' });
  if (!process.env.EVOLUTION_URL) return res.json({ exists: null, number, note: 'Sin conexión con Evolution: no se puede verificar.' });
  const r = await evo.withInstance(instance, () => evo.whatsappNumbers([number])).catch((e) => { throw Object.assign(new Error(`No se pudo verificar: ${e.message}`), { status: 502 }); });
  const hit = (Array.isArray(r) ? r : [])[0];
  res.json({ exists: !!hit?.exists, number: String(hit?.jid || number).split('@')[0] });
}));

// ---------- aprendizaje de skills ----------
app.get('/api/skills', auth, (req, res) => {
  const origin = (name) => db.prepare("SELECT author, created_at FROM persona_versions WHERE file = ? ORDER BY id DESC LIMIT 1").get(`skills/${name}`);
  const created = new Map(db.prepare("SELECT name, MIN(created_at) AS at FROM skill_log WHERE action = 'create' GROUP BY name").all().map((r) => [r.name, r.at]));
  const plist = db.prepare('SELECT id, name, skills FROM personas').all().map((p) => ({ id: p.id, name: p.name, allow: personas.skillsOf(p) }));
  res.json(persona.listSkills().map((s) => { const o = origin(s.name); const used_by = plist.filter((p) => !p.allow || p.allow.includes(s.name)).map((p) => ({ id: p.id, name: p.name, all: !p.allow })); return { name: s.name, description: /^description:\s*(.+)$/m.exec(s.content)?.[1]?.trim() || '', size: s.content.length, content: s.content, origin: o?.author === 'auto' || created.has(s.name) ? 'auto' : 'manual', updated_at: o?.created_at || null, learned_at: created.get(s.name) || null, used_by }; }));
});
app.get('/api/skill-log', auth, (req, res) => res.json(skillLog(Number(req.query.limit) || 50)));

// ---------- conversaciones ----------
app.get('/api/conversations', auth, (req, res) => res.json(db.prepare(`
  SELECT c.jid, c.name, c.paused, c.last_message_at, c.persona_id,
         (SELECT content FROM messages m WHERE m.jid = c.jid ORDER BY id DESC LIMIT 1) AS last,
         (SELECT COUNT(*) FROM messages m WHERE m.jid = c.jid) AS total
  FROM contacts c ORDER BY c.last_message_at DESC LIMIT 200`).all().map((c) => ({ ...c, instance: accounts.splitKey(c.jid).instance, wa_jid: accounts.splitKey(c.jid).jid, instanceLabel: accounts.labelFor(c.jid) }))));
app.get('/api/conversations/:jid', auth, (req, res) =>
  res.json(db.prepare('SELECT id, role, content, cost_usd, duration_ms, created_at, quoted, quoted_id, sender FROM messages WHERE jid = ? ORDER BY id DESC LIMIT 200').all(req.params.jid).reverse()));
app.post('/api/conversations/:jid/pause', auth, adminOnly, (req, res) => {
  db.prepare('UPDATE contacts SET paused = ? WHERE jid = ?').run(req.body.paused ? 1 : 0, req.params.jid);
  res.json({ ok: true });
});
app.post('/api/conversations/:jid/reset', auth, adminOnly, (req, res) => res.json({ ok: true, ...resetMemory(req.params.jid) }));
// elimina el chat COMPLETO: mensajes, tareas, archivos y el contexto (sesiones de Claude) del agente
app.delete('/api/conversations/:jid', auth, adminOnly, wrap((req, res) => res.json({ ok: true, ...deleteChat(decodeURIComponent(req.params.jid)) })));
app.get('/api/stats', auth, (req, res) => res.json({
  contacts: db.prepare('SELECT COUNT(*) n FROM contacts').get().n,
  messages24h: db.prepare("SELECT COUNT(*) n FROM messages WHERE created_at > datetime('now','-1 day')").get().n,
  replies: db.prepare("SELECT COUNT(*) n FROM messages WHERE role='assistant'").get().n,
  avgMs: Math.round(db.prepare("SELECT AVG(duration_ms) a FROM messages WHERE role='assistant'").get().a || 0),
}));

// ---------- probar el agente desde el panel ----------
app.post('/api/playground', auth, adminOnly, wrap(async (req, res) => {
  const message = String(req.body.message || '').trim();
  if (!message) return res.status(400).json({ error: 'Mensaje vacío' });
  res.json(await chat({ jid: `playground:${req.user.username}`, name: `Prueba (${req.user.username})`, message, override: req.body.override || null }));
}));
// compara el MISMO mensaje con dos motores/modelos a la vez (cada carril tiene su propia charla de prueba)
app.post('/api/playground/compare', auth, adminOnly, wrap(async (req, res) => {
  const message = String(req.body.message || '').trim(), lanes = (Array.isArray(req.body.lanes) ? req.body.lanes : []).slice(0, 2);
  if (!message) return res.status(400).json({ error: 'Mensaje vacío' });
  if (lanes.length < 2) return res.status(400).json({ error: 'Elegí dos motores/modelos para comparar' });
  const out = await Promise.all(lanes.map(async (ov, i) => {
    const t0 = Date.now(), jid = `playground:${req.user.username}:${'AB'[i]}`;
    try {
      const r = await chat({ jid, name: `Comparar ${'AB'[i]} (${req.user.username})`, message, override: ov });
      const m = r.msgId ? db.prepare('SELECT cost_usd, duration_ms FROM messages WHERE id = ?').get(r.msgId) : null;
      return { lane: 'AB'[i], engine: ov.engine, model: ov.model, reply: r.reply, attachments: (r.attachments || []).map((a) => a.fileName), ms: m?.duration_ms ?? Date.now() - t0, cost: m?.cost_usd ?? null };
    } catch (e) { return { lane: 'AB'[i], engine: ov.engine, model: ov.model, error: String(e.message).slice(0, 300), ms: Date.now() - t0 }; }
  }));
  res.json(out);
}));

// ---------- endpoint para n8n ----------
function agentAuth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  if (!AGENT_TOKEN || t.length !== AGENT_TOKEN.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(AGENT_TOKEN)))
    return res.status(401).json({ error: 'Token inválido' });
  next();
}
app.post('/api/agent/chat', agentAuth, express.json({ limit: '30mb' }), wrap(async (req, res) => {
  const b = req.body || {};
  if (!b.sessionId || !(b.message || b.text || b.kind)) return res.status(400).json({ error: 'sessionId y message (o kind) son obligatorios' });
  const t0 = Date.now(), key = accounts.chatKey(b.instance, String(b.sessionId));
  const out = await chat({ ...b, jid: key }, { friendly: true });
  if (out.attachments) out.attachments = out.attachments.map(({ src, ...a }) => a); // la ruta interna del archivo no sale del hub
  // demora configurada: n8n espera `delaySec` (ya descontado lo que tardó en pensar) antes de enviar. No aplica a correcciones por edición.
  if ((out.reply || out.attachments?.length) && !out.edit && !key.startsWith('playground:')) {
    const want = replyDelaySec(readRules(accounts.splitKey(key).instance));
    out.delaySec = Math.max(0, want - Math.round((Date.now() - t0) / 1000));
  }
  res.json(out);
}));
app.post('/api/client-error', express.json({ type: '*/*', limit: '8kb' }), (req, res) => {
  console.error('[client-error]', JSON.stringify(req.body || {}).slice(0, 800));
  res.status(204).end();
});
app.get('/api/health', (req, res) => res.json({ ok: true }));

// n8n avisa qué ids de WhatsApp tuvieron los mensajes que envió como respuesta (para poder citarlos o editarlos después)
app.post('/api/agent/sent', agentAuth, express.json({ limit: '100kb' }), (req, res) => {
  const { jid: rawJid, instance, msgId, replyTo, ids } = req.body || {};
  const jid = rawJid ? accounts.chatKey(instance, String(rawJid)) : rawJid;
  if (!jid || !msgId || !Array.isArray(ids)) return res.status(400).json({ error: 'jid, msgId e ids son obligatorios' });
  ids.slice(0, 10).forEach((id, idx) => db.prepare('INSERT OR REPLACE INTO sent_msgs (wa_id, jid, msg_id, idx, reply_to) VALUES (?, ?, ?, ?, ?)').run(String(id), String(jid), Number(msgId), idx, replyTo ? String(replyTo) : null));
  res.json({ ok: true });
});

// ---------- archivos que envía el agente (Evolution los descarga por acá; id aleatorio, vence en 1 h) ----------
app.get('/f/:id/:name', (req, res) => {
  const r = db.prepare('SELECT * FROM outfiles WHERE id = ? AND expires > ?').get(req.params.id, Date.now());
  if (!r || !fs.existsSync(r.path)) return res.status(404).end();
  res.set({ 'Content-Type': r.mime, 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(r.name)}`,
    'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': 'sandbox', 'Cache-Control': 'private, no-store' });
  res.sendFile(r.path);
});

// ---------- frontend estático ----------
const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist');
if (fs.existsSync(dist)) {
  // los assets llevan hash en el nombre (inmutables); el index.html nunca se cachea para que los clientes tomen siempre el build nuevo
  app.use('/assets', express.static(path.join(dist, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(dist, { index: false, maxAge: 0 }));
  app.get('/p/:token', personalHeaders, (req, res) => res.sendFile(path.join(dist, 'p.html'))); // versión personal: otra página, sin el panel del hub
  app.get('*', (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(dist, 'index.html')); });
}

for (const d of ['inbox', 'outbox']) fs.rmSync(path.join(persona.AGENT_DIR, d), { recursive: true, force: true }); // esquema viejo: descargas dentro del volumen compartido
cleanInbox(); setInterval(cleanInbox, 6 * 3600e3).unref();
const port = Number(process.env.PORT) || 4961;
const server = app.listen(port, () => console.log(`[hub] escuchando en :${port}`));
server.on('upgrade', apps.upgrade); // WebSockets de las apps; el hub no usa otros
schedules.startScheduler();
mcpOauth.startRefresher();
memory.migrateLegacy(persona.HOME_DIR);
mcp.adoptNative().then((a) => a.length && console.log(`[mcp] adoptados del archivo nativo: ${a.join(", ")}`)).catch(() => {});
if (!process.env.KIRI_SKIP_RECOVERY) setTimeout(() => { try { tasks.recoverTasks(); } catch (e) { console.error('[tareas] recuperación falló:', e.message); } }, 15000).unref();
