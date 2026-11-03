// Modelos disponibles: se leen del propio Claude Code (lo mismo que lista /model) y se completan con las versiones completas.
import { spawn } from 'node:child_process';
import { AGENT_DIR, HOME_DIR } from './persona.js';
import { usePanelLogin } from './claude-login.js';

const ALIAS_INFO = {
  default: ['Predeterminado', 'El que Claude Code elige para tu cuenta'],
  best: ['El mejor disponible', 'Siempre el modelo más capaz'],
  sonnet: ['Sonnet (último)', 'Equilibrado: rápido y muy capaz'],
  opus: ['Opus (último)', 'Máxima calidad para tareas difíciles'],
  haiku: ['Haiku (último)', 'Rápido y económico'],
  fable: ['Fable (último)', 'Modelo de la familia Fable'],
  'sonnet[1m]': ['Sonnet · contexto 1M', 'Sonnet con ventana de contexto de 1 millón de tokens'],
  'opus[1m]': ['Opus · contexto 1M', 'Opus con ventana de contexto de 1 millón de tokens'],
  'fable[1m]': ['Fable · contexto 1M', 'Fable con ventana de contexto de 1 millón de tokens'],
  opusplan: ['Opus planifica, Sonnet ejecuta', 'Opus para planear y Sonnet para ejecutar'],
};
// versiones concretas que trae este Claude Code (extraídas de su binario), de la más nueva a la más vieja
const VERSIONS = [
  ['claude-fable-5-1', 'Fable 5.1'], ['claude-opus-5-5', 'Opus 5.5'], ['claude-sonnet-5-5', 'Sonnet 5.5'], ['claude-haiku-5-5', 'Haiku 5.5'],
  ['claude-opus-4-8', 'Opus 4.8'], ['claude-opus-4-7', 'Opus 4.7'], ['claude-opus-4-6', 'Opus 4.6'], ['claude-opus-4-5', 'Opus 4.5'], ['claude-opus-4-1', 'Opus 4.1'],
  ['claude-sonnet-4-6', 'Sonnet 4.6'], ['claude-sonnet-4-5', 'Sonnet 4.5'], ['claude-haiku-4-5', 'Haiku 4.5'],
];
const FALLBACK = ['sonnet', 'opus', 'haiku', 'fable', 'best', 'sonnet[1m]', 'opus[1m]', 'fable[1m]', 'opusplan', 'default'];
let cache = null;

function askCli() {
  return new Promise((resolve) => {
    const c = spawn(process.env.CLAUDE_BIN || 'claude', ['-p', '/model', '--output-format', 'text'], {
      cwd: AGENT_DIR, stdio: ['ignore', 'pipe', 'ignore'],
      env: { PATH: process.env.PATH, HOME: HOME_DIR, ...(usePanelLogin() ? {} : { CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }), DISABLE_TELEMETRY: '1' },
    });
    let out = ''; const t = setTimeout(() => { c.kill('SIGKILL'); resolve(''); }, 30000);
    c.stdout.on('data', (d) => { if (out.length < 20000) out += d; });
    c.on('close', () => { clearTimeout(t); resolve(out); });
    c.on('error', () => { clearTimeout(t); resolve(''); });
  });
}

export async function listModels() {
  if (cache && Date.now() - cache.at < 3600e3) return cache.data;
  const out = await askCli();
  const m = out.match(/Available:\s*(.+?)(?:,\s*or a full model ID)?\.?\s*$/m);
  const aliases = m ? m[1].split(',').map((s) => s.trim()).filter((s) => s && !/^or a full/.test(s)) : FALLBACK;
  const current = out.match(/Current model:\s*`?([^`\n]+)`?/)?.[1] || null;
  const data = {
    source: m ? 'cli' : 'fallback', current,
    models: [
      ...aliases.map((a) => ({ value: a, label: ALIAS_INFO[a]?.[0] || a, description: ALIAS_INFO[a]?.[1] || 'Alias de Claude Code', group: 'Alias' })),
      ...VERSIONS.map(([id, label]) => ({ value: id, label, description: id, group: 'Versiones específicas' })),
    ],
  };
  if (m) cache = { at: Date.now(), data };
  return data;
}
