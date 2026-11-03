// Varias personalidades: una predeterminada + asignaciones por contacto. Cada una es un texto (el "CLAUDE.md" del agente).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { db } from './db.js';
import { splitKey, getAccount } from './accounts.js';
import { AGENT_DIR, readSettings, writeSettings, cleanSettings, PER_PERSONA_KEYS } from './persona.js';

// Cláusula de delegación: la predeterminada SIEMPRE la lleva (si se borra al editar, se vuelve a agregar al guardar).
export const CLAUSE_START = '<!-- kiri:delegacion -->';
export const CLAUSE_END = '<!-- /kiri:delegacion -->';
export const DELEGATION_CLAUSE = `${CLAUSE_START}
## Delegación de tareas (obligatoria)
Sos el coordinador de la conversación: conversás y respondés rápido, y todo el trabajo lo hace un sub agente.
- SIEMPRE que la persona te pida hacer, conseguir, buscar, descargar, generar, enviar o pasarle algo —aunque parezca simple— delegalo con la herramienta delegate_task. No lo intentes vos. Dale al sub agente instrucciones completas y autosuficientes: qué hacer, los datos exactos que dio la persona (enlaces, nombres, formato), si es un archivo que ella te mandó pasale su ruta exacta, y qué debe entregar.
- Apenas delegues, respondé con un mensaje corto y en tu estilo: confirmale que ya te pusiste a trabajar en eso y que le avisás en cuanto esté listo. No inventes resultados ni esperes a que termine.
- Cuando el sub agente termina, el sistema te avisa con un mensaje interno. Entonces escribile a la persona con el resultado, como un mensaje nuevo y natural (los archivos se adjuntan solos a tu mensaje; no hace falta que los envíes).
- Respondé directo, sin delegar, solo a charla, saludos, preguntas de conocimiento general que no requieren buscar nada y aclaraciones que se resuelven en una frase.
- Si intentás usar una herramienta y te dice que está deshabilitada, no es una falta de permisos: significa que ese trabajo lo hace un sub agente, así que delegalo. Nunca le digas a la persona que no tenés permisos, acceso a internet o herramientas.
- Podés tener varias tareas en curso a la vez; no repitas una que ya delegaste.
${CLAUSE_END}`;
export const hasClause = (text) => String(text).includes(CLAUSE_START);
/** Deja la cláusula vigente en el texto: si ya hay un bloque lo reemplaza (así las mejoras llegan a las existentes); si no, la agrega al final. */
export function ensureClause(text) {
  const t = String(text), a = t.indexOf(CLAUSE_START), b = t.indexOf(CLAUSE_END);
  if (a >= 0 && b > a) return t.slice(0, a) + DELEGATION_CLAUSE + t.slice(b + CLAUSE_END.length);
  return `${t.replace(/\s+$/, '')}\n\n${DELEGATION_CLAUSE}\n`;
}

db.exec(`CREATE TABLE IF NOT EXISTS personas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  content TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
)`);
// qué MCPs puede usar cada personalidad: NULL = todos los activos; un arreglo JSON de nombres = solo esos
try { db.exec('ALTER TABLE personas ADD COLUMN mcp_servers TEXT'); } catch { /* ya existe */ }
// qué skills puede usar cada personalidad: NULL = todas; un arreglo JSON de nombres = solo esas
try { db.exec('ALTER TABLE personas ADD COLUMN skills TEXT'); } catch { /* ya existe */ }
// ajustes propios de la personalidad (modelo, permisos, límites…): NULL = hereda la configuración general
try { db.exec('ALTER TABLE personas ADD COLUMN settings TEXT'); } catch { /* ya existe */ }
for (const col of ['persona_id INTEGER', 'persona_hash TEXT', 'oc_session TEXT', 'last_engine TEXT', 'on_fallback INTEGER NOT NULL DEFAULT 0']) { // oc_session: sesión de OpenCode de este chat · last_engine: motor del último turno
  try { db.exec(`ALTER TABLE contacts ADD COLUMN ${col}`); } catch { /* ya existe */ }
}

/** Primera vez: la personalidad que ya existía (CLAUDE.md) pasa a ser la predeterminada. */
export function seedPersonas(seedFile) {
  if (db.prepare('SELECT COUNT(*) n FROM personas').get().n > 0) { ensureDefaultClause(); return; }
  const legacy = path.join(AGENT_DIR, 'CLAUDE.md');
  const src = fs.existsSync(legacy) ? legacy : seedFile;
  const content = fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '# Personalidad\n\nSos un asistente amable que conversa por WhatsApp.';
  db.prepare('INSERT INTO personas (name, content, is_default) VALUES (?, ?, 1)').run('Kiri', ensureClause(content));
  if (fs.existsSync(legacy)) fs.renameSync(legacy, `${legacy}.migrado`); // para que Claude Code no cargue dos personalidades a la vez
}

const cleanName = (n) => String(n || '').replace(/\s+/g, ' ').trim().slice(0, 40);
const stamp = (id, content, author) => db.prepare('INSERT INTO persona_versions (file, content, author) VALUES (?, ?, ?)').run(`persona:${id}`, content, author || null);

export const listPersonas = () => db.prepare(`
  SELECT p.id, p.name, p.is_default, p.updated_at, length(p.content) AS size,
         (SELECT COUNT(*) FROM contacts c WHERE c.persona_id = p.id) AS contacts
  FROM personas p ORDER BY p.is_default DESC, p.name COLLATE NOCASE`).all();
export const getPersona = (id) => db.prepare('SELECT * FROM personas WHERE id = ?').get(id);
export const defaultPersona = () => db.prepare('SELECT * FROM personas WHERE is_default = 1').get() || db.prepare('SELECT * FROM personas ORDER BY id LIMIT 1').get();
export const versionsOf = (id) => db.prepare("SELECT id, author, created_at, length(content) AS size FROM persona_versions WHERE file = ? ORDER BY id DESC LIMIT 30").all(`persona:${id}`);
export const contactsOf = (id) => db.prepare('SELECT jid, name FROM contacts WHERE persona_id = ? ORDER BY COALESCE(last_message_at, \'\') DESC').all(id);

const cleanMcp = (v) => (v === null ? null : Array.isArray(v) ? JSON.stringify([...new Set(v.map((x) => String(x).trim().toLowerCase()).filter(Boolean))].slice(0, 50)) : undefined);
/** MCPs permitidos de una personalidad: arreglo de nombres, o null = todos los activos. */
export const mcpOf = (p) => { try { return p?.mcp_servers ? JSON.parse(p.mcp_servers) : null; } catch { return null; } };

/** Ajustes propios de una personalidad (solo las claves por-personalidad) o null si hereda la general. */
export const settingsOverride = (p) => { try { return p?.settings ? JSON.parse(p.settings) : null; } catch { return null; } };
/** Ajustes efectivos para una personalidad: la configuración general + lo propio de esa personalidad (la predeterminada ES la general). */
export function settingsFor(p) {
  const base = readSettings(), ov = p && !p.is_default ? settingsOverride(p) : null;
  if (!ov) return base;
  const clean = cleanSettings({ ...base, ...ov });
  return { ...base, ...Object.fromEntries(PER_PERSONA_KEYS.map((k) => [k, clean[k]])) };
}
export function saveSettingsFor(id, incoming) {
  const p = getPersona(id);
  if (!p) throw Object.assign(new Error('Esa personalidad no existe'), { status: 404 });
  const base = readSettings(), merged = cleanSettings({ ...base, ...incoming });
  if (p.is_default) { writeSettings(merged); return settingsFor(p); }
  writeSettings({ ...base, timezone: merged.timezone, skillLearning: merged.skillLearning, memoryAuto: merged.memoryAuto }); // lo global se guarda siempre en la general
  db.prepare("UPDATE personas SET settings = ?, updated_at = datetime('now') WHERE id = ?").run(JSON.stringify(Object.fromEntries(PER_PERSONA_KEYS.map((k) => [k, merged[k]]))), id);
  return settingsFor(getPersona(id));
}
export function clearSettingsFor(id) { db.prepare('UPDATE personas SET settings = NULL WHERE id = ?').run(id); }

/** Skills permitidas de una personalidad: arreglo de nombres, o null = todas. */
export const skillsOf = (p) => { try { return p?.skills ? JSON.parse(p.skills) : null; } catch { return null; } };
const cleanSkills = (v) => (v === null ? null : Array.isArray(v) ? JSON.stringify([...new Set(v.map((x) => String(x).trim()).filter((x) => /^[a-z0-9][a-z0-9-_]{0,48}$/i.test(x)))].slice(0, 100)) : undefined);
/** Agrega skills a la lista de una personalidad que tiene lista propia (si usa "todas", ya las ve). */
export function allowSkills(id, names) {
  const p = getPersona(id), cur = skillsOf(p);
  if (!p || !cur) return;
  db.prepare('UPDATE personas SET skills = ? WHERE id = ?').run(JSON.stringify([...new Set([...cur, ...names])]), id);
}

export function createPersona({ name, content, mcp, skills, settings }, author) {
  const n = cleanName(name);
  if (!n) throw Object.assign(new Error('Poné un nombre para la personalidad'), { status: 400 });
  const text = String(content ?? `# ${n}\n\nSos ${n}, un asistente que conversa por WhatsApp.\n\n## Tono\n- \n\n## Reglas\n- \n`);
  const id = Number(db.prepare('INSERT INTO personas (name, content, mcp_servers, skills, settings) VALUES (?, ?, ?, ?, ?)').run(n, text, cleanMcp(mcp) ?? null, cleanSkills(skills) ?? null, settings ? JSON.stringify(settings) : null).lastInsertRowid);
  stamp(id, text, author);
  return getPersona(id);
}

export function updatePersona(id, { name, content, mcp, skills }, author) {
  const p = getPersona(id);
  if (!p) throw Object.assign(new Error('Esa personalidad no existe'), { status: 404 });
  const n = name === undefined ? p.name : cleanName(name);
  if (!n) throw Object.assign(new Error('El nombre no puede quedar vacío'), { status: 400 });
  let text = content === undefined ? p.content : String(content);
  if (p.is_default) text = ensureClause(text);
  db.prepare("UPDATE personas SET name = ?, content = ?, mcp_servers = ?, skills = ?, updated_at = datetime('now') WHERE id = ?").run(n, text, mcp === undefined ? p.mcp_servers : mcp === null ? null : cleanMcp(mcp) ?? p.mcp_servers, skills === undefined ? p.skills : skills === null ? null : cleanSkills(skills) ?? p.skills, id);
  if (text !== p.content) stamp(id, text, author);
  return getPersona(id);
}

export function setDefault(id) {
  if (!getPersona(id)) throw Object.assign(new Error('Esa personalidad no existe'), { status: 404 });
  db.exec('UPDATE personas SET is_default = 0');
  db.prepare('UPDATE personas SET is_default = 1 WHERE id = ?').run(id);
  ensureDefaultClause();
}

export function deletePersona(id) {
  const p = getPersona(id);
  if (!p) throw Object.assign(new Error('Esa personalidad no existe'), { status: 404 });
  if (p.is_default) throw Object.assign(new Error('No se puede borrar la personalidad predeterminada: primero marcá otra como predeterminada'), { status: 400 });
  db.prepare('UPDATE contacts SET persona_id = NULL WHERE persona_id = ?').run(id); // vuelven a la predeterminada
  db.prepare('UPDATE wa_accounts SET persona_id = NULL WHERE persona_id = ?').run(id);
  db.prepare('DELETE FROM personas WHERE id = ?').run(id);
}

/** Personalidad que le toca a un chat: la del contacto si tiene; si no, la del número de WhatsApp por el que llegó; si no, la predeterminada. */
export function resolveFor(contact) {
  const acc = contact?.jid ? getAccount(splitKey(contact.jid).instance) : null;
  return (contact?.persona_id && getPersona(contact.persona_id)) || (acc?.persona_id && getPersona(acc.persona_id)) || defaultPersona();
}
/** Personalidad que le toca a un chat, a partir de su clave. */
export const personaForKey = (key) => resolveFor(db.prepare('SELECT * FROM contacts WHERE jid = ?').get(key) || { jid: key });
/** ¿Una función con lista de personalidades (`personas`: null/ausente = todas) aplica a esta personalidad? */
export const appliesTo = (cfg, persona) => !Array.isArray(cfg?.personas) || (!!persona && cfg.personas.includes(persona.id));
export const cleanPersonaIds = (v) => (Array.isArray(v) ? [...new Set(v.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 100) : null);

/** Números de WhatsApp que atiende una personalidad (la tiene como predeterminada del número). */
export const accountsOf = (id) => db.prepare('SELECT instance, label FROM wa_accounts WHERE persona_id = ?').all(id);
export function setAccountsOf(id, instances) {
  if (!getPersona(id)) throw Object.assign(new Error('Esa personalidad no existe'), { status: 404 });
  const want = new Set((instances || []).map(String));
  db.prepare('UPDATE wa_accounts SET persona_id = NULL WHERE persona_id = ?').run(id);
  for (const i of want) db.prepare('UPDATE wa_accounts SET persona_id = ? WHERE instance = ?').run(id, i);
}
export const hashOf = (p) => crypto.createHash('sha1').update(`${p.id}\n${p.content}`).digest('hex').slice(0, 16);

/** Garantiza la cláusula en la predeterminada (al arrancar y cada vez que cambia). */
export function ensureDefaultClause() {
  const d = db.prepare('SELECT id, content FROM personas WHERE is_default = 1').get();
  if (d && ensureClause(d.content) !== d.content) {
    const fixed = ensureClause(d.content);
    db.prepare("UPDATE personas SET content = ?, updated_at = datetime('now') WHERE id = ?").run(fixed, d.id);
    stamp(d.id, fixed, 'sistema');
  }
}
