// Tareas delegadas: el agente principal responde rápido ("ya estoy en eso") y un SUB AGENTE hace el trabajo en segundo plano.
// Al terminar, el agente principal le escribe a la persona con el resultado (mensaje nuevo, por WhatsApp).
import crypto from 'node:crypto';
import { db } from './db.js';
import { readSettings } from './persona.js';
import { resolveFor } from './personas.js';
import { enqueue, getContact, runClaude, collectAttachments, recoverIfLost } from './agent.js';
import { deliver } from './deliver.js';
import { adoptNative, listServers, getServer } from './mcp.js';
import { startLogin, refreshExpiring } from './mcp-oauth.js';
import { mcpOf, skillsOf, settingsFor, personaForKey, appliesTo } from './personas.js';
import { curateAfterTask } from './learn.js';
import { panelsOnFor, autoSaveDocs } from './panel-settings.js';
import { enabledFor as appsEnabledFor } from './apps.js';
import { enabledFor as voiceEnabledFor, audioOnly as voiceAudioOnly } from './voice.js';
import { DEFAULT_MODEL } from './engines.js';
import { readAttentionSettings, requestHuman } from './attention.js';

const MAX_GLOBAL = Number(process.env.KIRI_MAX_SUBAGENTS) || 2; // sub agentes corriendo a la vez en todo el contenedor
const MAX_PER_CONTACT = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const running = new Map(); // id -> { child, cancelled }
const waiting = [];
let active = 0;

async function acquire() { while (active >= MAX_GLOBAL) await new Promise((r) => waiting.push(r)); active++; }
function release() { active--; waiting.shift()?.(); }

const sysMsg = (jid, text) => db.prepare("INSERT INTO messages (jid, role, content) VALUES (?, 'system', ?)").run(jid, text);
const parse = (t) => (t ? { ...t, files: t.files ? JSON.parse(t.files) : [] } : t);

export const getTask = (id) => parse(db.prepare('SELECT * FROM tasks WHERE id = ?').get(id));
export const listTasks = ({ jid, limit = 100 } = {}) =>
  db.prepare(`SELECT * FROM tasks ${jid ? 'WHERE jid = ?' : ''} ORDER BY id DESC LIMIT ?`).all(...(jid ? [jid, limit] : [limit])).map(parse);

export function createTask(jid, { title, instructions }) {
  const fail = (status, message) => Object.assign(new Error(message), { status });
  const t = String(title || '').trim().slice(0, 80) || 'Tarea';
  const ins = String(instructions || '').trim().slice(0, 8000);
  if (!jid) throw fail(400, 'falta la persona (jid)');
  if (ins.length < 10) throw fail(400, 'las instrucciones son demasiado cortas: explicá bien qué tiene que hacer el sub agente');
  if (db.prepare("SELECT COUNT(*) n FROM tasks WHERE jid = ? AND status = 'running'").get(jid).n >= MAX_PER_CONTACT)
    throw fail(429, `ya hay ${MAX_PER_CONTACT} tareas en curso para esta persona: esperá a que termine alguna`);
  const id = Number(db.prepare('INSERT INTO tasks (jid, title, instructions) VALUES (?, ?, ?)').run(jid, t, ins).lastInsertRowid);
  sysMsg(jid, `🧩 Tarea #${id} delegada a un sub agente: ${t}`);
  setImmediate(() => execute(id));
  return { id, title: t };
}

async function execute(id) {
  const t = getTask(id);
  if (!t || t.status !== 'running') return;
  await acquire();
  const entry = { child: null, cancelled: false };
  running.set(id, entry);
  let outcome;
  try {
    if (entry.cancelled) return;
    const persona = resolveFor(getContact(t.jid));
    const st = settingsFor(persona);
    let settings = { ...st, maxTurns: st.subagentMaxTurns, timeoutSec: st.subagentTimeoutSec };
    if (st.subOverride) { // el trabajo en segundo plano con otro motor/modelo (p. ej. uno más barato); su respaldo es el otro motor
      const eng = st.subEngine || st.engine;
      settings = { ...settings, engine: eng, model: st.subModel || DEFAULT_MODEL[eng], variant: st.subVariant || '', fallbackModel: eng !== st.engine ? st.model : st.fallbackModel };
    }
    const sid = crypto.randomUUID();
    db.prepare("INSERT OR IGNORE INTO session_log (session_id, jid, kind) VALUES (?, ?, 'tarea')").run(sid, t.jid);
    // el sub agente trabaja con los MCPs que permite la personalidad de ESTE contacto (null = todos)
    const mcpAllow = mcpOf(persona);
    await refreshExpiring().catch(() => {}); // tokens de MCPs con inicio de sesión
    const before = new Set(listServers().map((s) => s.name));
    const r = await runClaude({ jid: t.jid, session_id: sid, session_started: 0 }, `Tarea #${id}: ${t.title}\n\n${t.instructions}`, settings, null,
      { sub: true, panels: panelsOnFor(persona), apps: appsEnabledFor(persona), voice: voiceEnabledFor(persona), outboxKey: `${t.jid}#t${id}`, mcpAllow, skillsAllow: skillsOf(persona), onChild: (c) => { entry.child = c; } });
    // si el sub agente instaló un MCP con `claude mcp add`, pasa al panel (solo si no hay otra tarea verificando el suyo en este momento)
    let loginNote = '';
    if (running.size <= 1) {
      const adopted = await adoptNative(true).catch(() => []);
      for (const n of adopted) if (getServer(n)?.status === 'auth_required') { try { loginNote += `\n\n🔐 El MCP «${n}» quedó instalado pero PIDE INICIAR SESIÓN. Enlace para la persona (vale ~20 min, abrirlo en el celular o navegador): ${(await startLogin(n, { jid: t.jid })).url}`; } catch { /* sin enlace posible */ } }
    }
    // un MCP que el agente instaló en esta tarea queda también permitido para la personalidad que lo pidió (si esa personalidad tiene lista propia)
    if (mcpAllow) {
      const nuevos = listServers().map((s) => s.name).filter((n) => !before.has(n));
      if (nuevos.length) db.prepare('UPDATE personas SET mcp_servers = ? WHERE id = ?').run(JSON.stringify([...new Set([...mcpAllow, ...nuevos])]), persona.id);
    }
    curateAfterTask(t, sid, r.text, persona).catch((e) => console.error(`[skills] ${e.message}`)); // en segundo plano: no demora el aviso
    const files = collectAttachments(t.jid, `${t.jid}#t${id}`);
    autoSaveDocs(t.jid, persona, files);
    outcome = { ok: true, text: (r.text || (r.truncated ? 'El sub agente llegó al máximo de pasos sin dejar un resumen final.' : '')) + loginNote, files, cost: r.cost };
  } catch (e) {
    outcome = { ok: false, error: String(e.message).slice(0, 400), files: [] };
  } finally {
    running.delete(id);
    release();
  }
  if (entry.cancelled) return;
  finish(t, outcome);
}

function finish(t, o) {
  db.prepare("UPDATE tasks SET status = ?, result = ?, error = ?, files = ?, cost_usd = ?, finished_at = datetime('now') WHERE id = ?")
    .run(o.ok ? 'done' : 'failed', o.text || null, o.error || null, JSON.stringify(o.files.map((f) => ({ fileName: f.fileName, size: f.size }))), o.cost ?? null, t.id);
  sysMsg(t.jid, o.ok ? `✅ Tarea #${t.id} terminada: ${t.title}` : `❌ Tarea #${t.id} falló: ${t.title}`);
  if (!o.ok && readAttentionSettings().notifyFailedTasks && appliesTo(readAttentionSettings(), personaForKey(t.jid))) { try { requestHuman(t.jid, { kind: 'tarea', reason: `La tarea #${t.id} «${t.title}» falló`, summary: o.error, urgency: 'normal' }); } catch { /* sin aviso */ } }
  notify(t, o);
}

/** El agente principal (con la personalidad de ese contacto) le escribe a la persona cuando el sub agente termina. */
function notify(t, o) {
  return enqueue(t.jid, async () => {
    await sleep(Number(process.env.KIRI_NOTIFY_DELAY_MS ?? 5000)); // que salga primero el "ya estoy en eso" del turno que delegó
    const names = o.files.map((f) => f.fileName).join(', ');
    const voiceOnly = o.ok && voiceAudioOnly(resolveFor(getContact(t.jid)), o.files); // el resultado ya va como nota de voz: sin texto
    const prompt = o.ok
      ? `[AVISO INTERNO DEL SISTEMA — no lo menciones tal cual ni lo copies] El sub agente terminó la tarea #${t.id} «${t.title}».\nResultado del sub agente:\n"""\n${o.text}\n"""\n${names ? `Estos archivos se adjuntan solos a tu mensaje: ${names}.` : 'No hay archivos adjuntos.'}\nEscribile ahora a la persona, en tu estilo, avisándole que ya está listo y contándole el resultado de forma clara y breve. Es un mensaje NUEVO, no la respuesta a algo que acaba de decir.${voiceOnly ? ' IMPORTANTE: el resultado ya se envía como nota de voz: no escribas ningún texto (respondé vacío).' : ''} Si el resultado no cumple lo que pidió, decíselo con honestidad. No delegues de nuevo salvo que haga falta.`
      : `[AVISO INTERNO DEL SISTEMA — no lo menciones tal cual ni lo copies] La tarea #${t.id} «${t.title}» que delegaste NO se pudo completar. Motivo: ${o.error}\nEscribile ahora a la persona, en tu estilo: contale con claridad qué se intentó y por qué no se pudo (en tus palabras, sin jerga técnica) y qué alternativas hay; ofrecele reintentar. Es un mensaje NUEVO.`;
    let text = '', attachments = [...o.files];
    try {
      const recovered = recoverIfLost(t.jid);
      const c = getContact(t.jid);
      const r = await runClaude(c, recovered + prompt, settingsFor(resolveFor(c)), resolveFor(c));
      attachments = [...o.files, ...collectAttachments(t.jid)].slice(0, 5);
      text = voiceOnly ? '' : r.text;
      db.prepare('UPDATE contacts SET session_started = 1 WHERE jid = ?').run(t.jid);
    } catch (e) {
      console.error(`[tarea #${t.id}] no pude generar el aviso con el agente: ${e.message}`);
    }
    if (!text && !voiceOnly) text = o.ok ? `¡Listo! Terminé lo que pediste.\n\n${o.text}` : `No pude completar lo que pediste (${o.error}). ¿Querés que lo intente de otra forma?`;
    const shown = [text, ...attachments.map((a) => `📎 ${a.fileName}`)].join('\n');
    db.prepare("INSERT INTO messages (jid, role, content) VALUES (?, 'assistant', ?)").run(t.jid, shown);
    try { await deliver(t.jid, text, attachments); }
    catch (e) { console.error(`[tarea #${t.id}] no pude entregar el aviso por WhatsApp: ${e.message}`); }
  });
}

/** Limpia la lista del panel: borra SOLO las filas de `tasks` ya terminadas (nunca las en curso). No toca el chat, la memoria, las sesiones ni las skills. */
export function deleteTasks({ ids, olderThanDays, status, jid } = {}) {
  const where = ["status != 'running'"], args = [];
  if (Array.isArray(ids)) {
    const list = ids.map(Number).filter(Number.isInteger).slice(0, 1000);
    if (!list.length) return { deleted: 0 };
    where.push(`id IN (${list.map(() => '?').join(',')})`); args.push(...list);
  } else if (olderThanDays == null && !status && !jid) {
    throw Object.assign(new Error('Indicá qué tareas limpiar (ids, antigüedad, estado o chat).'), { status: 400 });
  }
  if (olderThanDays != null) {
    const d = Number(olderThanDays);
    if (!Number.isFinite(d) || d < 0 || d > 3650) throw Object.assign(new Error('Antigüedad inválida'), { status: 400 });
    where.push("COALESCE(finished_at, created_at) < datetime('now', ?)"); args.push(`-${Math.floor(d)} days`);
  }
  if (status) {
    if (!['done', 'failed', 'cancelled'].includes(status)) throw Object.assign(new Error('Solo se pueden limpiar tareas terminadas, fallidas o canceladas'), { status: 400 });
    where.push('status = ?'); args.push(status);
  }
  if (jid) { where.push('jid = ?'); args.push(String(jid)); }
  return { deleted: db.prepare(`DELETE FROM tasks WHERE ${where.join(' AND ')}`).run(...args).changes };
}

export function cancelTask(id) {
  const t = getTask(id);
  if (!t) throw Object.assign(new Error('Esa tarea no existe'), { status: 404 });
  if (t.status !== 'running') throw Object.assign(new Error('La tarea ya terminó'), { status: 409 });
  const e = running.get(id);
  if (e) { e.cancelled = true; try { e.child?.kill('SIGKILL'); } catch { /* ya terminó */ } }
  db.prepare("UPDATE tasks SET status = 'cancelled', finished_at = datetime('now') WHERE id = ?").run(id);
  sysMsg(t.jid, `⛔ Tarea #${id} cancelada: ${t.title}`);
}

/** Tareas que quedaron "en curso" porque el servidor se reinició: se marcan como fallidas y se le avisa a la persona. */
export function recoverTasks() {
  for (const t of db.prepare("SELECT * FROM tasks WHERE status = 'running'").all().map(parse)) {
    if (running.has(t.id)) continue;
    finish(t, { ok: false, error: 'el servidor se reinició mientras trabajaba en la tarea', files: [] });
  }
}
