// Carpeta de trabajo del agente: contiene CLAUDE.md (personalidad), skills y settings.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DATA_DIR, db } from './db.js';

export const AGENT_DIR = path.join(DATA_DIR, 'agent');
export const HOME_DIR = path.join(DATA_DIR, 'home');
export const SEED_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../agent-seed');
const SETTINGS_FILE = path.join(AGENT_DIR, 'agent-settings.json');
const SKILLS_DIR = path.join(AGENT_DIR, '.claude', 'skills');

export const PERMISSION_MODES = ['default', 'manual', 'acceptEdits', 'plan', 'dontAsk', 'auto', 'bypassPermissions'];
export const ENGINES = ['claude', 'opencode'];
export const DEFAULT_SETTINGS = {
  engine: 'claude',             // motor que ejecuta al agente: 'claude' (Claude Code) o 'opencode' (OpenCode); misma personalidad, MCPs, skills y permisos en los dos
  model: 'sonnet',
  subOverride: false,           // los sub agentes (el trabajo en segundo plano) usan otro motor/modelo que la charla (p. ej. uno más barato)
  subEngine: 'claude',
  subModel: '',
  subVariant: '',
  variant: '',                  // OpenCode: nivel de razonamiento del modelo ('' = el predeterminado)
  fallbackEnabled: false,       // si el motor principal llega a su límite de uso, seguir con el otro motor (y volver cuando se reinicie)
  fallbackModel: '',            // modelo del motor de respaldo ('' = el predeterminado de ese motor)
  maxTurns: 15,
  timeoutSec: 240,
  allowedTools: ['WebSearch', 'WebFetch'],
  sendFiles: true,
  permissionMode: 'default',
  subagentMaxTurns: 40,
  subagentTimeoutSec: 900,
  timezone: 'America/Asuncion', // zona horaria para recordatorios y tareas programadas
  skillLearning: true,          // tras tareas complejas, el agente crea/mejora skills reutilizables
  memoryAuto: true,             // el agente guarda por su cuenta datos relevantes de cada contacto (memoria.md)
};

export function initAgentDir() {
  fs.mkdirSync(HOME_DIR, { recursive: true });
  fs.mkdirSync(SKILLS_DIR, { recursive: true });
  if (!fs.existsSync(SETTINGS_FILE)) writeSettings(DEFAULT_SETTINGS);
  const seedSkills = path.join(SEED_DIR, 'skills');
  if (fs.existsSync(seedSkills) && fs.readdirSync(SKILLS_DIR).length === 0) {
    for (const f of fs.readdirSync(seedSkills)) {
      fs.cpSync(path.join(seedSkills, f), path.join(SKILLS_DIR, f), { recursive: true });
    }
  }
}

export const readPersona = () => {
  const p = path.join(AGENT_DIR, 'CLAUDE.md');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
};

const validTz = (z) => { try { new Intl.DateTimeFormat('es', { timeZone: String(z) }); return true; } catch { return false; } };
export function readSettings() {
  try { return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) }; }
  catch { return { ...DEFAULT_SETTINGS }; }
}

/** Rangos permitidos [mín, máx] de los límites numéricos (la UI los muestra y avisa si un valor se ajusta). */
export const LIMITS = { maxTurns: [1, 100], timeoutSec: [10, 1800], subagentMaxTurns: [5, 100000], subagentTimeoutSec: [60, 86400] };
export const PER_PERSONA_KEYS = ['engine', 'model', 'variant', 'subOverride', 'subEngine', 'subModel', 'subVariant', 'fallbackEnabled', 'fallbackModel', 'maxTurns', 'timeoutSec', 'allowedTools', 'sendFiles', 'permissionMode', 'subagentMaxTurns', 'subagentTimeoutSec'];
/** Valida y normaliza ajustes (completos); lo que falta toma el valor por defecto. */
export function cleanSettings(s) {
  return {
    engine: ENGINES.includes(s.engine) ? s.engine : 'claude',
    variant: /^[\w-]{1,20}$/.test(String(s.variant || '')) ? String(s.variant) : '',
    subOverride: s.subOverride === true,
    subEngine: ENGINES.includes(s.subEngine) ? s.subEngine : 'claude',
    subModel: (s.subEngine === 'opencode' ? /^[\w.-]+\/[\w.\[\]\/:@-]{1,100}$/ : /^[\w.\[\]-]{1,60}$/).test(String(s.subModel || '')) ? String(s.subModel) : '',
    subVariant: /^[\w-]{1,20}$/.test(String(s.subVariant || '')) ? String(s.subVariant) : '',
    fallbackEnabled: s.fallbackEnabled === true,
    // el respaldo es SIEMPRE el otro motor; su modelo se valida con el formato de ese motor
    fallbackModel: (s.engine === 'opencode' ? /^[\w.\[\]-]{1,60}$/ : /^[\w.-]+\/[\w.\[\]\/:@-]{1,100}$/).test(String(s.fallbackModel || '')) ? String(s.fallbackModel) : '',
    // OpenCode usa "proveedor/modelo" (ej. opencode/big-pickle); Claude Code usa alias o id completo (ej. sonnet, claude-opus-5-5)
    model: ENGINES.includes(s.engine) && s.engine === 'opencode'
      ? (/^[\w.-]+\/[\w.\[\]\/:@-]{1,100}$/.test(String(s.model)) ? String(s.model) : 'opencode/big-pickle')
      : (/^[\w.\[\]-]{1,60}$/.test(String(s.model)) ? String(s.model) : DEFAULT_SETTINGS.model),
    maxTurns: Math.min(LIMITS.maxTurns[1], Math.max(LIMITS.maxTurns[0], Number(s.maxTurns) || DEFAULT_SETTINGS.maxTurns)),
    timeoutSec: Math.min(LIMITS.timeoutSec[1], Math.max(LIMITS.timeoutSec[0], Number(s.timeoutSec) || DEFAULT_SETTINGS.timeoutSec)),
    allowedTools: (Array.isArray(s.allowedTools) ? s.allowedTools : []).map(String).filter(Boolean),
    sendFiles: s.sendFiles !== false,
    permissionMode: PERMISSION_MODES.includes(s.permissionMode) ? s.permissionMode : 'default',
    subagentMaxTurns: Math.min(LIMITS.subagentMaxTurns[1], Math.max(LIMITS.subagentMaxTurns[0], Number(s.subagentMaxTurns) || DEFAULT_SETTINGS.subagentMaxTurns)),
    subagentTimeoutSec: Math.min(LIMITS.subagentTimeoutSec[1], Math.max(LIMITS.subagentTimeoutSec[0], Number(s.subagentTimeoutSec) || DEFAULT_SETTINGS.subagentTimeoutSec)),
    timezone: validTz(s.timezone) ? String(s.timezone) : DEFAULT_SETTINGS.timezone,
    skillLearning: s.skillLearning !== false,
    memoryAuto: s.memoryAuto !== false,
  };
}
export function writeSettings(s) {
  const clean = cleanSettings(s);
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(clean, null, 2));
  return clean;
}

function snapshot(file, content, author) {
  db.prepare('INSERT INTO persona_versions (file, content, author) VALUES (?, ?, ?)').run(file, content, author || null);
}

export function writePersona(content, author) {
  fs.writeFileSync(path.join(AGENT_DIR, 'CLAUDE.md'), content);
  snapshot('CLAUDE.md', content, author);
}

const safeName = (n) => {
  if (!/^[a-z0-9][a-z0-9-_]{0,48}$/i.test(n)) throw new Error('Nombre de skill inválido');
  return n;
};

export function listSkills() {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  return fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(SKILLS_DIR, d.name, 'SKILL.md')))
    .map((d) => ({ name: d.name, content: fs.readFileSync(path.join(SKILLS_DIR, d.name, 'SKILL.md'), 'utf8') }));
}

export function writeSkill(name, content, author) {
  const dir = path.join(SKILLS_DIR, safeName(name));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), content);
  snapshot(`skills/${name}`, content, author);
}

export function deleteSkill(name) {
  fs.rmSync(path.join(SKILLS_DIR, safeName(name)), { recursive: true, force: true });
}

export const listVersions = (file) =>
  db.prepare('SELECT id, file, author, created_at, length(content) AS size FROM persona_versions WHERE file = ? ORDER BY id DESC LIMIT 30').all(file);
export const getVersion = (id) => db.prepare('SELECT * FROM persona_versions WHERE id = ?').get(id);
