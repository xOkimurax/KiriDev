// Lo que el agente puede hacer con los paneles (herramientas MCP → /internal/panels). Siempre acotado a validaciones: nunca HTML ni SQL libre.
import * as P from './panels.js';
import { readPanelSettings } from './panel-settings.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const need = (ref, owner) => { const c = P.findCollection(ref, { owner }); if (!c) throw fail(404, `No existe la colección «${ref}». Mirá panel_overview o creala con collection_create.`); return c; };
const brief = (c) => ({ id: c.id, name: c.name, rows: c.rowCount, fields: c.fields.map((f) => `${f.key} (${f.type}${f.options?.length ? `: ${f.options.join('/')}` : ''})`) });
const shortPanel = (p) => ({ id: p.id, title: p.title, folder: p.folder, sections: p.widgets.map((w) => `${w.type}${w.title ? `: ${w.title}` : ''}`) });

export function agentCall(jid, action, a = {}) {
  const owner = jid; // los paneles que arma el agente son SIEMPRE de este chat: no ve ni toca los de otras personas ni los del hub
  const by = 'agente';
  switch (action) {
    case 'overview': return P.overview({ owner });
    case 'collection_create': return { created: brief(P.createCollection({ name: a.name, fields: a.fields, rows: a.rows, owner })) };
    case 'collection_add_field': { const c = need(a.collection, owner); return { updated: brief(P.addField(c.id, { label: a.label, type: a.type, options: a.options })) }; }
    case 'rows_add': { const c = need(a.collection, owner); return { ...P.addRows(c.id, a.rows, by, { owner }), collection: c.name }; }
    case 'rows_find': { const c = need(a.collection, owner); const r = P.listRows(c.id, { q: a.query || '', filter: a.filter, limit: Math.min(50, Number(a.limit) || 20) }, { owner }); return { collection: c.name, total: r.total, filtered: !!r.filtered, rows: r.rows.map(({ _created, _updated, ...x }) => x) }; }
    case 'rows_update': { const c = need(a.collection, owner); const r = P.updateRow(c.id, a.row_id, a.set, by, { owner }); const { _created, _updated, ...x } = r; return { updated: x }; }
    case 'rows_delete': {
      if (a.confirmed !== true) throw fail(400, 'Para borrar filas la persona tiene que haberlo confirmado en la charla: volvé a llamar con confirmed=true solo después de que lo haya confirmado.');
      const c = need(a.collection, owner); const ids = (Array.isArray(a.row_ids) ? a.row_ids : []).slice(0, 50);
      if (!ids.length) throw fail(400, 'Indicá row_ids.');
      ids.forEach((id) => P.deleteRow(c.id, id, by, { owner }));
      return { deleted: ids.length, note: 'Quedan en el historial del panel por si hay que deshacerlo.' };
    }
    case 'panel_create': {
      if (a.template) return { created: shortPanel(P.createFromTemplate(a.template, { title: a.title, owner })) };
      return { created: shortPanel(P.createPanel({ title: a.title, folder: a.folder, widgets: a.widgets || [], owner }, by)) };
    }
    case 'panel_update': {
      const p = P.findPanel(a.panel, { owner }); if (!p) throw fail(404, `No existe el panel «${a.panel}».`);
      const widgets = a.widgets !== undefined ? a.widgets : a.add_widgets ? [...p.widgets, ...a.add_widgets] : undefined;
      return { updated: shortPanel(P.updatePanel(p.id, { title: a.title, folder: a.folder, widgets }, { owner })) };
    }
    case 'panel_link': {
      if (!readPanelSettings().personalLinks) throw fail(403, 'El administrador no habilitó los enlaces personales.');
      const base = (process.env.HUB_BASE_URL || process.env.HUB_PUBLIC_URL || '').replace(/\/$/, '');
      if (!base) throw fail(500, 'No hay una dirección pública configurada (HUB_BASE_URL).');
      return { url: `${base}/p/${P.ensureLink(owner).token}`, note: 'Pasale este enlace COMPLETO a la persona: es personal (no lo compartas) y muestra y permite editar solo SUS paneles, sin contraseña.' };
    }
    default: throw fail(400, 'acción desconocida');
  }
}
