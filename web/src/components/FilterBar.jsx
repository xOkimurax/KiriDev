import React, { useEffect, useMemo, useState } from 'react';
import { Badge, Button, Combo, Icon, Segmented } from './ui.jsx';
import { GROUP, OPS, OP_LABEL, NEEDS, describeCond, hasSpec, activeCount } from './filters.js';

const EMPTY = { match: 'all', conds: [], sort: null };
const same = (a, b) => JSON.stringify(a || null) === JSON.stringify(b || null);

/** Estado del filtro de una sección: arranca con el filtro "del panel" (si lo hay) y lo que la persona cambia se recuerda en su navegador. */
export function useFilterState(storageKey, defaults) {
  const read = () => { try { const t = localStorage.getItem(storageKey); return t ? JSON.parse(t) : defaults || null; } catch { return defaults || null; } };
  const [spec, setSpecRaw] = useState(read);
  useEffect(() => setSpecRaw(read()), [storageKey, JSON.stringify(defaults || null)]);
  const setSpec = (next) => { const v = hasSpec(next) ? next : null; setSpecRaw(v); try { if (same(v, defaults)) localStorage.removeItem(storageKey); else localStorage.setItem(storageKey, JSON.stringify(v ?? { match: 'all', conds: [], sort: null })); } catch { /* sin almacenamiento: vale igual mientras la página esté abierta */ } };
  return [spec, setSpec];
}

function ValueEditor({ field, cond, onChange, options }) {
  const g = GROUP(field.type), n = NEEDS(cond.op);
  if (n === 0) return null;
  if (g === 'select') {
    const sel = Array.isArray(cond.value) ? cond.value : String(cond.value || '').split(/[,;|]/).filter(Boolean);
    return (
      <div className="filter-chips" role="group" aria-label="Valores">
        {options.map((o) => <button key={o} type="button" className={sel.includes(o) ? 'active' : ''} aria-pressed={sel.includes(o)} onClick={() => onChange({ ...cond, value: sel.includes(o) ? sel.filter((x) => x !== o) : [...sel, o] })}>{o}</button>)}
        {!options.length && <span className="muted">Sin opciones todavía</span>}
      </div>
    );
  }
  const type = g === 'number' ? 'number' : g === 'date' ? 'date' : 'text';
  return (
    <div className="filter-values">
      <input type={type} step={g === 'number' ? 'any' : undefined} aria-label="Valor" value={cond.value ?? ''} onChange={(e) => onChange({ ...cond, value: e.target.value })} placeholder={g === 'text' ? 'Texto…' : ''} />
      {n === 2 && <><span className="muted">y</span><input type={type} step={g === 'number' ? 'any' : undefined} aria-label="Segundo valor" value={cond.value2 ?? ''} onChange={(e) => onChange({ ...cond, value2: e.target.value })} /></>}
    </div>
  );
}

/**
 * Barra de filtros para CUALQUIER tabla o lista: condiciones por campo (según su tipo), combinadas con «todas / cualquiera», más orden.
 *  fields: [{ key, label, type, options? }]  ·  value: { match, conds, sort } | null  ·  rows: filas cargadas (para ofrecer los valores existentes en campos de selección)
 */
export function FilterBar({ fields, value, onChange, rows = [], defaults, onSaveDefault }) {
  const [open, setOpen] = useState(false);
  const spec = value || EMPTY, byKey = useMemo(() => new Map(fields.map((f) => [f.key, f])), [fields]);
  const active = activeCount(spec);
  const optionsOf = (f) => [...new Set([...(f.options || []), ...rows.map((r) => r[f.key]).filter((v) => v !== null && v !== undefined && v !== '').map(String)])].sort();
  const setConds = (conds) => onChange({ ...spec, conds });
  const addCond = () => { const f = fields[0]; if (f) setConds([...(spec.conds || []), { field: f.key, op: OPS[GROUP(f.type)][0], value: '' }]); setOpen(true); };
  const opOptions = (f) => OPS[GROUP(f.type)].map((o) => ({ value: o, label: OP_LABEL[o] }));
  const changedFromDefault = !same(hasSpec(spec) ? spec : null, defaults);
  return (
    <div className="filter-bar">
      <div className="row filter-head">
        <Button variant={open || active ? 'primary' : 'secondary'} icon="rules" aria-expanded={open} onClick={() => setOpen((v) => !v)}>Filtros{active ? ` (${active})` : ''}</Button>
        {active > 0 && <Button variant="ghost" onClick={() => onChange(null)}>Limpiar</Button>}
        {!open && (spec.conds || []).map((c, i) => (
          <span key={i} className="filter-tag">{describeCond(c, byKey.get(c.field))}<button type="button" aria-label="Quitar este filtro" onClick={() => setConds(spec.conds.filter((_, j) => j !== i))}><Icon name="close" size={12} /></button></span>
        ))}
        {!open && spec.sort && <span className="filter-tag">Orden: {byKey.get(spec.sort.field)?.label || spec.sort.field} {spec.sort.dir === 'desc' ? '↓' : '↑'}<button type="button" aria-label="Quitar el orden" onClick={() => onChange({ ...spec, sort: null })}><Icon name="close" size={12} /></button></span>}
      </div>
      {open && (
        <div className="filter-panel">
          {(spec.conds || []).length > 1 && <Segmented label="Mostrar filas que cumplan" value={spec.match} onChange={(m) => onChange({ ...spec, match: m })} options={[{ value: 'all', label: 'Todas las condiciones' }, { value: 'any', label: 'Alguna condición' }]} />}
          {(spec.conds || []).map((c, i) => {
            const f = byKey.get(c.field) || fields[0];
            const upd = (n) => setConds(spec.conds.map((x, j) => (j === i ? n : x)));
            return (
              <div key={i} className="filter-cond">
                <Combo label="Campo" value={f.key} options={fields.map((x) => ({ value: x.key, label: x.label }))} onChange={(k) => { const nf = byKey.get(k); upd({ field: k, op: OPS[GROUP(nf.type)][0], value: '' }); }} />
                <Combo label="Condición" value={c.op} options={opOptions(f)} onChange={(op) => upd({ ...c, op, value: NEEDS(op) ? c.value : '', value2: NEEDS(op) === 2 ? c.value2 : undefined })} />
                {NEEDS(c.op) > 0 && <div className="filter-value-cell"><span className="field-label">Valor</span><ValueEditor field={f} cond={c} onChange={upd} options={optionsOf(f)} /></div>}
                <Button variant="ghost" aria-label="Quitar condición" onClick={() => setConds(spec.conds.filter((_, j) => j !== i))}><Icon name="trash" size={16} /></Button>
              </div>
            );
          })}
          <div className="row filter-actions">
            <Button variant="secondary" icon="plus" onClick={addCond}>Agregar filtro</Button>
            <Combo label="Ordenar por" value={spec.sort?.field || ''} placeholder="Sin orden" options={[{ value: '', label: 'Sin orden' }, ...fields.map((f) => ({ value: f.key, label: f.label }))]} onChange={(k) => onChange({ ...spec, sort: k ? { field: k, dir: spec.sort?.dir || 'asc' } : null })} />
            {spec.sort && <Segmented label="Sentido" value={spec.sort.dir} onChange={(d) => onChange({ ...spec, sort: { ...spec.sort, dir: d } })} options={[{ value: 'asc', label: 'A → Z / menor' }, { value: 'desc', label: 'Z → A / mayor' }]} />}
          </div>
          {(onSaveDefault || defaults) && (
            <div className="row filter-actions">
              {onSaveDefault && <Button variant="secondary" icon="save" disabled={!changedFromDefault} onClick={() => onSaveDefault(hasSpec(spec) ? spec : null)}>Guardar como filtro del panel</Button>}
              {defaults && changedFromDefault && <Button variant="ghost" onClick={() => onChange(defaults)}>Volver al filtro del panel</Button>}
              <small className="help">El filtro del panel es el que ven todos al abrirlo; lo que cambies acá solo lo ves vos.</small>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
