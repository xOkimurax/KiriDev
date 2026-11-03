// Skills que se crean y mejoran solas: tras una tarea delegada compleja y exitosa, un "curador" mira cómo se resolvió (los pasos reales
// del transcript) y decide si hay un procedimiento reutilizable que valga la pena guardar como skill (o mejorar una existente).
// Las skills son COMPARTIDAS por todos los contactos: por eso el curador nunca debe guardar datos personales ni secretos.
import fs from 'node:fs';
import path from 'node:path';
import { db } from './db.js';
import { HOME_DIR, readSettings, listSkills, writeSkill } from './persona.js';
import { askModel } from './agent.js';
import { skillsOf, allowSkills } from './personas.js';

db.exec(`CREATE TABLE IF NOT EXISTS skill_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, action TEXT NOT NULL, task_id INTEGER, summary TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
)`);
export const skillLog = (limit = 50) => db.prepare('SELECT * FROM skill_log ORDER BY id DESC LIMIT ?').all(limit);

const MIN_TOOL_CALLS = 6;
const SECRET = /(sk-ant-|sk-[a-z0-9]{20,}|xkeysib-|AIza[0-9A-Za-z_-]{20}|ghp_[0-9A-Za-z]{20}|cfut_|Bearer\s+[A-Za-z0-9._-]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY|\b\d{9,15}@(s\.whatsapp\.net|g\.us|lid)|(contraseña|password|token|cookie)\s*[:=]\s*\S{6,})/i;

function transcriptPath(sid) {
  const root = path.join(HOME_DIR, '.claude', 'projects');
  try { for (const d of fs.readdirSync(root)) { const f = path.join(root, d, `${sid}.jsonl`); if (fs.existsSync(f)) return f; } } catch { /* */ }
  return null;
}

/** Pasos reales de la tarea (herramienta + argumento clave + resultado corto), en texto. */
function steps(file) {
  const out = []; let calls = 0;
  const short = (v, n) => String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, n);
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    let j; try { j = JSON.parse(line); } catch { continue; }
    const content = j.message?.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_use') { calls++; out.push(`▶ ${b.name}: ${short(b.input?.command ?? b.input?.url ?? b.input?.query ?? b.input?.prompt ?? b.input, 220)}`); }
      else if (b.type === 'tool_result') out.push(`   ↳ ${short(Array.isArray(b.content) ? b.content.map((x) => x.text || '').join(' ') : b.content, 140)}${b.is_error ? ' [ERROR]' : ''}`);
    }
  }
  return { calls, text: out.join('\n').slice(0, 7000) };
}

const descOf = (md) => /^description:\s*(.+)$/m.exec(md)?.[1]?.trim() || '';

export async function curateAfterTask(task, sid, resultText, persona = null) {
  if (!readSettings().skillLearning) return null;
  const file = transcriptPath(sid);
  if (!file) return null;
  const { calls, text } = steps(file);
  if (calls < MIN_TOOL_CALLS) return null; // tarea simple: no vale la pena una skill
  const allowed = skillsOf(persona); // null = esa personalidad ve todas; si no, solo esas: el curador solo ve (y puede mejorar) las suyas
  const visible = listSkills().filter((s) => !allowed || allowed.includes(s.name));
  const existing = visible.map((s) => `- ${s.name}: ${descOf(s.content)}`).join('\n') || '(ninguna)';
  const prompt = `Sos el curador de skills de un asistente de WhatsApp. Una skill es un procedimiento reutilizable (en markdown) que el asistente consulta cuando una tarea parecida vuelve a aparecer. Mirá cómo se resolvió esta tarea y decidí si vale la pena guardar o mejorar una skill.

CRITERIOS
- Solo si hay un procedimiento NO trivial y GENERALIZABLE que probablemente se repita (cómo bajar algo de cierto sitio, cómo generar cierto tipo de documento, un flujo de varios pasos que costó descubrir, un error común y su solución). No para tareas de una sola vez.
- Si ya existe una skill del mismo tema, ACTUALIZALA (devolvé el contenido completo mejorado) en lugar de crear otra.
- Escribí pasos concretos y comandos que funcionaron, y los errores a evitar. Con parámetros en vez de valores fijos.
- PROHIBIDO incluir: datos personales, nombres o números de personas, claves, tokens, cookies, contraseñas, enlaces privados. Es una skill compartida entre todos los contactos.
- Si no hay nada valioso, respondé none.

TAREA: ${task.title}
INSTRUCCIONES: ${String(task.instructions).slice(0, 1500)}
RESULTADO FINAL: ${String(resultText || '').slice(0, 800)}

PASOS REALES (${calls} llamadas a herramientas):
${text}

SKILLS EXISTENTES:
${existing}

Respondé SOLO con un JSON: {"action":"none"|"create"|"update","name":"slug-en-minusculas","description":"cuándo usarla, en 1-2 frases","body":"markdown con los pasos"}. Si es none, omití el resto.`;
  let j;
  try {
    const out = await askModel(prompt, { model: 'sonnet', timeoutMs: 150000 });
    j = JSON.parse(/\{[\s\S]*\}/.exec(out)?.[0] || 'null');
  } catch (e) { console.error(`[skills] el curador no pudo evaluar la tarea #${task.id}: ${e.message}`); return null; }
  if (!j || !['create', 'update'].includes(j.action)) return null;
  const name = String(j.name || '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  const description = String(j.description || '').replace(/\s+/g, ' ').trim().slice(0, 300);
  const body = String(j.body || '').trim();
  if (!name || !description || body.length < 80 || body.length > 8000) return null;
  if (SECRET.test(`${description}\n${body}`)) { console.error(`[skills] se descartó "${name}": parecía contener datos sensibles`); return null; }
  const existsAny = listSkills().some((s) => s.name === name), existsVisible = visible.some((s) => s.name === name);
  if (existsAny && !existsVisible) { console.error(`[skills] se descartó "${name}": existe pero esta personalidad no la usa`); return null; }
  if (j.action === 'update' && !existsVisible) j.action = 'create';
  if (j.action === 'create' && existsVisible) j.action = 'update';
  writeSkill(name, `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`, 'auto');
  db.prepare('INSERT INTO skill_log (name, action, task_id, summary) VALUES (?, ?, ?, ?)').run(name, j.action, task.id, description);
  if (persona && allowed) allowSkills(persona.id, [name]); // la aprendió esa personalidad: queda en su lista
  console.log(`[skills] ${j.action === 'create' ? 'creada' : 'mejorada'} la skill "${name}" tras la tarea #${task.id}`);
  return { name, action: j.action };
}
