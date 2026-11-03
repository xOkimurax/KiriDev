// Borrado de un chat con TODO su contexto: mensajes, tareas, archivos recibidos/generados y las sesiones de Claude en disco.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { HOME_DIR } from './persona.js';
import { INBOX, OUTBOX, safe } from './media.js';
import { cancelTask } from './tasks.js';
import { resetSession } from './agent.js';
import { deleteOcSession } from './opencode.js';
import { deleteContactMemory } from './memory.js';
import { deleteProfile } from './profile.js';

const CLAUDE_HOME = path.join(HOME_DIR, '.claude');
const rm = (p) => { try { fs.rmSync(p, { recursive: true, force: true }); return true; } catch { return false; } };
const ls = (d) => { try { return fs.readdirSync(d); } catch { return []; } };

/** Borra de ~/.claude todo rastro de una sesión (transcripción, tareas, entorno, historial de archivos…). */
export function purgeSession(id) {
  if (!/^[0-9a-f-]{36}$/i.test(String(id))) return 0;
  let n = 0;
  for (const proj of ls(path.join(CLAUDE_HOME, 'projects'))) {
    for (const e of ls(path.join(CLAUDE_HOME, 'projects', proj))) if (e === id || e.startsWith(`${id}.`)) n += rm(path.join(CLAUDE_HOME, 'projects', proj, e)) ? 1 : 0;
  }
  for (const sub of ['todos', 'session-env', 'shell-snapshots', 'file-history', 'debug']) {
    for (const e of ls(path.join(CLAUDE_HOME, sub))) if (e.includes(id)) n += rm(path.join(CLAUDE_HOME, sub, e)) ? 1 : 0;
  }
  db.prepare('DELETE FROM session_log WHERE session_id = ?').run(id);
  return n;
}

/** Ids de sesión de un contacto: los registrados + las transcripciones que mencionan su número o sus carpetas (sesiones viejas sin registro). */
function sessionIdsOf(jid) {
  const ids = new Set(db.prepare('SELECT session_id FROM session_log WHERE jid = ?').all(jid).map((r) => r.session_id));
  const c = db.prepare('SELECT session_id FROM contacts WHERE jid = ?').get(jid);
  if (c?.session_id) ids.add(c.session_id);
  const key = safe(jid);
  // sesiones que pertenecen a OTROS contactos: jamás se tocan, aunque mencionen este número
  const others = new Set([
    ...db.prepare('SELECT session_id FROM contacts WHERE jid != ?').all(jid).map((r) => r.session_id),
    ...db.prepare('SELECT session_id FROM session_log WHERE jid != ?').all(jid).map((r) => r.session_id),
  ]);
  for (const proj of ls(path.join(CLAUDE_HOME, 'projects'))) {
    for (const e of ls(path.join(CLAUDE_HOME, 'projects', proj))) {
      if (!e.endsWith('.jsonl')) continue;
      const f = path.join(CLAUDE_HOME, 'projects', proj, e);
      try {
        if (fs.statSync(f).size > 80 * 1048576) continue;
        const text = fs.readFileSync(f, 'utf8');
        if ((text.includes(jid) || text.includes(key)) && !others.has(e.slice(0, -6))) ids.add(e.slice(0, -6));
      } catch { /* ilegible: se ignora */ }
    }
  }
  return ids;
}

export function deleteChat(jid) {
  const out = { messages: 0, tasks: 0, files: 0, sessions: 0 };
  for (const t of db.prepare('SELECT id, status FROM tasks WHERE jid = ?').all(jid)) {
    if (t.status === 'running') { try { cancelTask(t.id); } catch { /* ya terminó */ } }
  }
  deleteOcSession(db.prepare('SELECT oc_session FROM contacts WHERE jid = ?').get(jid)?.oc_session);
  for (const id of sessionIdsOf(jid)) out.sessions += purgeSession(id);

  const key = safe(jid);
  const dirs = [];
  for (const base of [INBOX, OUTBOX]) for (const d of ls(base)) if (d === key || d.startsWith(`${key}_t`)) dirs.push(path.join(base, d));
  for (const d of dirs) out.files += rm(d) ? 1 : 0;
  for (const r of db.prepare('SELECT id, path FROM outfiles').all()) if (dirs.some((d) => r.path.startsWith(d + path.sep))) db.prepare('DELETE FROM outfiles WHERE id = ?').run(r.id);

  out.messages = db.prepare('DELETE FROM messages WHERE jid = ?').run(jid).changes;
  out.tasks = db.prepare('DELETE FROM tasks WHERE jid = ?').run(jid).changes;
  db.prepare('DELETE FROM session_log WHERE jid = ?').run(jid);
  deleteContactMemory(jid);
  deleteProfile(jid);
  db.prepare('DELETE FROM schedules WHERE jid = ?').run(jid);
  db.prepare('DELETE FROM sent_msgs WHERE jid = ?').run(jid);
  db.prepare('DELETE FROM contacts WHERE jid = ?').run(jid);
  return out;
}

/** "Reiniciar memoria": el agente olvida la conversación (se borran sus sesiones viejas) pero el historial visible se conserva. */
export function resetMemory(jid) {
  const old = db.prepare('SELECT session_id FROM contacts WHERE jid = ?').get(jid)?.session_id;
  resetSession(jid);
  const n = old ? purgeSession(old) : 0;
  return { sessions: n };
}
