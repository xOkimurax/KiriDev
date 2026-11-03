// Recordatorios y tareas programadas en lenguaje natural: el agente las crea con schedule_create (una vez o repetidas) y a la hora
// indicada el agente le escribe a la persona (y si hace falta trabajo, lo delega a un sub agente como siempre).
import { Cron } from 'croner';
import { db } from './db.js';
import { readSettings } from './persona.js';
import { resolveFor, settingsFor } from './personas.js';
import { enqueue, getContact, runClaude, collectAttachments, recoverIfLost, stripRefs, nowLine } from './agent.js';
import { deliver } from './deliver.js';
import { autoSaveDocs } from './panel-settings.js';

db.exec(`CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY AUTOINCREMENT, jid TEXT NOT NULL, title TEXT NOT NULL, instructions TEXT NOT NULL,
  kind TEXT NOT NULL, cron TEXT, tz TEXT NOT NULL, next_run INTEGER, status TEXT NOT NULL DEFAULT 'active',
  last_run INTEGER, runs INTEGER NOT NULL DEFAULT 0, last_error TEXT, created_by TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);

const MAX_PER_CONTACT = 20, MIN_CRON_MINUTES = 15, MAX_AHEAD_MS = 366 * 864e5, LATE_ONCE_MS = 6 * 3600e3, LATE_CRON_MS = 30 * 60e3;
const fail = (status, message) => Object.assign(new Error(message), { status });
const tzOf = () => readSettings().timezone || 'America/Asuncion';

/** Convierte "2026-10-10 09:00" (hora local de la zona `tz`) en un instante exacto, o lanza si no es válido. */
function localToEpoch(at, tz) {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/.exec(String(at || '').trim());
  if (!m) throw fail(400, 'La fecha debe tener el formato "AAAA-MM-DD HH:mm" (hora local).');
  const [, Y, Mo, D, H, Mi] = m.map(Number);
  // un cron de una sola vez para esa fecha/hora en esa zona (croner resuelve el huso y los cambios de horario)
  const next = new Cron(`${Mi} ${H} ${D} ${Mo} *`, { timezone: tz }).nextRun(new Date(Date.UTC(Y, Mo - 1, D, 0, 0) - 36 * 3600e3));
  if (!next) throw fail(400, 'Esa fecha no es válida.');
  return next.getTime();
}

const parse = (s) => s && ({ ...s });
export const listSchedules = ({ jid } = {}) => db.prepare(`SELECT * FROM schedules ${jid ? 'WHERE jid = ?' : ''} ORDER BY (status = 'active') DESC, COALESCE(next_run, 9e15), id DESC LIMIT 300`).all(...(jid ? [jid] : [])).map(parse);
export const getSchedule = (id) => parse(db.prepare('SELECT * FROM schedules WHERE id = ?').get(id));

export function createSchedule(jid, { title, instructions, at, cron }, createdBy = 'agente') {
  const tz = tzOf();
  const t = String(title || '').trim().slice(0, 80) || 'Recordatorio';
  const ins = String(instructions || title || '').trim().slice(0, 2000);
  if (!ins) throw fail(400, 'Faltan las instrucciones.');
  if (db.prepare("SELECT COUNT(*) AS n FROM schedules WHERE jid = ? AND status IN ('active','paused')").get(jid).n >= MAX_PER_CONTACT) throw fail(409, `Ya hay ${MAX_PER_CONTACT} tareas programadas para este contacto: cancelá alguna primero.`);
  let kind, next, expr = null;
  if (cron) {
    expr = String(cron).trim();
    let c; try { c = new Cron(expr, { timezone: tz }); } catch { throw fail(400, 'La expresión cron no es válida (5 campos: minuto hora día mes díaSemana).'); }
    const [a, b] = c.nextRuns(2);
    if (!a || !b) throw fail(400, 'Esa expresión no tiene próximas ejecuciones.');
    if (b - a < MIN_CRON_MINUTES * 60e3) throw fail(400, `La repetición mínima es cada ${MIN_CRON_MINUTES} minutos.`);
    kind = 'cron'; next = a.getTime();
  } else {
    kind = 'once'; next = localToEpoch(at, tz);
    if (next < Date.now() + 30e3) throw fail(400, 'Esa fecha y hora ya pasó (o es dentro de menos de un minuto). Indicá una futura.');
    if (next - Date.now() > MAX_AHEAD_MS) throw fail(400, 'Solo puedo programar hasta un año hacia adelante.');
  }
  const id = Number(db.prepare('INSERT INTO schedules (jid, title, instructions, kind, cron, tz, next_run, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(jid, t, ins, kind, expr, tz, next, createdBy).lastInsertRowid);
  db.prepare("INSERT INTO messages (jid, role, content) VALUES (?, 'system', ?)").run(jid, `⏰ Programado #${id}: ${t} — ${describe(getSchedule(id))}`);
  return getSchedule(id);
}

export function describe(s) {
  const when = s.next_run ? new Intl.DateTimeFormat('es', { timeZone: s.tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(s.next_run)) : '—';
  return s.kind === 'cron' ? `repite (${s.cron}); próxima: ${when}` : `una vez: ${when}`;
}

function setStatus(id, status, jid) {
  const s = getSchedule(id);
  if (!s || (jid && s.jid !== jid)) throw fail(404, 'Esa tarea programada no existe.');
  if (status === 'active') { // reanudar: recalcula la próxima ejecución
    const next = s.kind === 'cron' ? new Cron(s.cron, { timezone: s.tz }).nextRun()?.getTime() : s.next_run > Date.now() ? s.next_run : null;
    if (!next) throw fail(409, 'No se puede reanudar: ya pasó la fecha de esa tarea.');
    db.prepare("UPDATE schedules SET status = 'active', next_run = ? WHERE id = ?").run(next, id);
  } else db.prepare('UPDATE schedules SET status = ? WHERE id = ?').run(status, id);
  return getSchedule(id);
}
export const pauseSchedule = (id, jid) => setStatus(id, 'paused', jid);
export const resumeSchedule = (id, jid) => setStatus(id, 'active', jid);
export const cancelSchedule = (id, jid) => setStatus(id, 'cancelled', jid);
export function deleteSchedule(id) { db.prepare('DELETE FROM schedules WHERE id = ?').run(id); }

/** El agente le escribe a la persona: mensaje NUEVO (no es respuesta a nada), con la personalidad de ese contacto. */
function fire(s, late) {
  return enqueue(s.jid, async () => {
    const c = getContact(s.jid);
    if (c.paused) { db.prepare('UPDATE schedules SET last_error = ? WHERE id = ?').run('el agente está pausado en este chat', s.id); return; }
    const prompt = `[RECORDATORIO PROGRAMADO #${s.id} — aviso interno del sistema, no lo menciones tal cual] ${nowLine()}\nLlegó la hora de: «${s.title}»${late ? ' (se avisa con algo de retraso: no te disculpes, solo ubicá a la persona si hace falta)' : ''}.\nLo que quedó acordado: ${s.instructions}\nEscribile AHORA a la persona, en tu estilo, un mensaje NUEVO (no es respuesta a nada que haya dicho): si es un recordatorio, recordáselo de forma clara y breve; si implica buscar, revisar o preparar algo, hacelo delegando con delegate_task y avisale que ya estás en eso. Nunca digas que es un mensaje automático ni menciones "programado".`;
    let text = '', attachments = [];
    try {
      const recovered = recoverIfLost(s.jid);
      const r = await runClaude(getContact(s.jid), recovered + prompt, settingsFor(resolveFor(getContact(s.jid))), resolveFor(getContact(s.jid)));
      text = stripRefs(r.text);
      attachments = collectAttachments(s.jid).slice(0, 5);
      autoSaveDocs(s.jid, resolveFor(getContact(s.jid)), attachments);
      db.prepare('UPDATE contacts SET session_started = 1 WHERE jid = ?').run(s.jid);
    } catch (e) {
      console.error(`[programada #${s.id}] el agente no pudo redactar el aviso: ${e.message}`);
      db.prepare('UPDATE schedules SET last_error = ? WHERE id = ?').run(String(e.message).slice(0, 200), s.id);
    }
    if (!text && !attachments.length) text = `⏰ Recordatorio: ${s.title}`;
    db.prepare("INSERT INTO messages (jid, role, content) VALUES (?, 'assistant', ?)").run(s.jid, [text, ...attachments.map((a) => `📎 ${a.fileName}`)].filter(Boolean).join('\n'));
    try { await deliver(s.jid, text, attachments); }
    catch (e) { console.error(`[programada #${s.id}] no se pudo enviar: ${e.message}`); db.prepare('UPDATE schedules SET last_error = ? WHERE id = ?').run(`no se pudo enviar: ${String(e.message).slice(0, 150)}`, s.id); }
  });
}

/** Revisa cada 30 s qué tareas vencieron. Lo atrasado (servidor caído) se avisa si no pasó demasiado tiempo; si no, se salta. */
export function tick(now = Date.now()) {
  for (const s of db.prepare("SELECT * FROM schedules WHERE status = 'active' AND next_run IS NOT NULL AND next_run <= ?").all(now)) {
    const lateMs = now - s.next_run;
    if (s.kind === 'cron') {
      const next = new Cron(s.cron, { timezone: s.tz }).nextRun(new Date(now))?.getTime() ?? null;
      db.prepare("UPDATE schedules SET next_run = ?, status = ?, last_run = ?, runs = runs + 1 WHERE id = ?").run(next, next ? 'active' : 'done', now, s.id);
      if (lateMs <= LATE_CRON_MS) fire(s, lateMs > 120e3);
    } else {
      db.prepare("UPDATE schedules SET status = 'done', last_run = ?, runs = runs + 1 WHERE id = ?").run(now, s.id);
      if (lateMs <= LATE_ONCE_MS) fire(s, lateMs > 120e3);
      else db.prepare("UPDATE schedules SET last_error = 'se perdió: el servidor estuvo caído a esa hora' WHERE id = ?").run(s.id);
    }
  }
}
let timer = null;
export function startScheduler() { if (!timer) { timer = setInterval(() => { try { tick(); } catch (e) { console.error('[programadas]', e.message); } }, 30e3); timer.unref(); setTimeout(() => { try { tick(); } catch { /* */ } }, 5000).unref(); } }
