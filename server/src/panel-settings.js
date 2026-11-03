// Ajustes de Paneles (kv del hub). Módulo aparte para que el runner del agente los lea sin cargar la base de paneles.
import { db as hub } from './db.js';
import { appliesTo, cleanPersonaIds } from './personas.js';

export const PANEL_DEFAULTS = { enabled: false, personas: null, suggest: true, personalLinks: true, autoSaveDocs: true }; // autoSaveDocs: los archivos que el agente envía a una persona se guardan en su sección Documentos // personalLinks: el agente puede dar un enlace personal (sin contraseña) para ver/editar SUS paneles
export function readPanelSettings() {
  const row = hub.prepare("SELECT value FROM kv WHERE key = 'panels'").get();
  try { return { ...PANEL_DEFAULTS, ...(row ? JSON.parse(row.value) : {}) }; } catch { return { ...PANEL_DEFAULTS }; }
}
export function writePanelSettings(s) {
  const clean = { enabled: !!s.enabled, suggest: s.suggest !== false, personalLinks: s.personalLinks !== false, autoSaveDocs: s.autoSaveDocs !== false, personas: cleanPersonaIds(s.personas) };
  hub.prepare("INSERT INTO kv (key, value) VALUES ('panels', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(clean));
  return clean;
}
export const panelsOnFor = (persona) => { const s = readPanelSettings(); return s.enabled && appliesTo(s, persona); };


/** Guarda en Documentos los archivos que el agente acaba de enviar (si los paneles y la opción están activos para esta personalidad). Nunca lanza ni demora. */
export function autoSaveDocs(jid, persona, attachments) {
  try {
    const cfg = readPanelSettings();
    if (!attachments?.length || !cfg.enabled || !cfg.autoSaveDocs || !appliesTo(cfg, persona)) return;
    import('./documents.js').then((m) => m.autoSave(jid, attachments)).catch((e) => console.error(`[documentos] ${e.message}`));
  } catch { /* nunca afecta a la charla */ }
}
