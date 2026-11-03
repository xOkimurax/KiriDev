import React, { useEffect, useMemo, useState } from 'react';
import MessageMarkdown from './MessageMarkdown.jsx';
import { PanelApiContext, usePanelApi } from './panelApi.js';
import { DocumentsWidget } from './documents.jsx';
import { useNarrow } from './useNarrow.js';
import { FilterBar, useFilterState } from './FilterBar.jsx';
import { hasSpec, activeCount } from './filters.js';
import { Badge, Button, Card, Combo, Empty, Icon, InlineConfirm, Segmented, Skeleton, fmtDate } from './ui.jsx';

export { PanelApiContext, usePanelApi };
export const TYPE_LABEL = { text: 'Texto', number: 'Número', money: 'Dinero', date: 'Fecha', datetime: 'Fecha y hora', select: 'Selección', checkbox: 'Casilla', url: 'Enlace' };
export const TYPE_OPTIONS = Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }));
export const WIDGET_LABEL = { table: 'Tabla', calendar: 'Calendario', board: 'Tablero por estado', note: 'Nota', stat: 'Resumen numérico', documents: 'Documentos' };
export const ALIAS = { texto: 'text', numero: 'number', número: 'number', dinero: 'money', fecha: 'date', fechahora: 'datetime', seleccion: 'select', selección: 'select', casilla: 'checkbox', enlace: 'url' };
const MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const WEEKDAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DOW = ['lun', 'mar', 'mié', 'jue', 'vie', 'sáb', 'dom'];
const money = (v) => (v === null || v === undefined || v === '' ? '' : Number(v).toLocaleString('es-PY', { maximumFractionDigits: 2 }));
const pad = (n) => String(n).padStart(2, '0');
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// ---------- celdas ----------
const showValue = (f, v) => (v === null || v === undefined || v === '' ? '' : f.type === 'checkbox' ? (v ? 'Sí' : 'No') : f.type === 'money' || f.type === 'number' ? money(v) : String(v));
/** Una celda: se ve como texto limpio y se edita al tocarla (`always` = siempre como campo, para formularios y filas nuevas). */
export function Cell({ field, value, onSave, disabled, always }) {
  const [v, setV] = useState(value ?? ''), [edit, setEdit] = useState(false);
  useEffect(() => setV(value ?? ''), [value]);
  const txt = showValue(field, value);
  if (field.type === 'checkbox') return <input type="checkbox" aria-label={field.label} disabled={disabled} checked={!!value} onChange={(e) => onSave(e.target.checked)} />;
  if (disabled) return <span className="cell-text">{txt || <i className="cell-empty">—</i>}</span>;
  if (field.type === 'select') {
    const options = [{ value: '', label: '—' }, ...[...new Set([...(field.options || []), ...(value ? [value] : [])])].map((o) => ({ value: o, label: o }))];
    if (always || edit) return <Combo label="" value={value || ''} onChange={onSave} placeholder="—" options={options} autoOpen={!always} onClose={() => setEdit(false)} />;
    return <button type="button" className="cell-view" onClick={() => setEdit(true)}>{txt || <i className="cell-empty">—</i>}</button>;
  }
  if (!always && !edit) return <button type="button" className="cell-view" onClick={() => setEdit(true)}>{txt || <i className="cell-empty">—</i>}</button>;
  const type = field.type === 'date' ? 'date' : field.type === 'datetime' ? 'datetime-local' : field.type === 'number' || field.type === 'money' ? 'number' : 'text';
  const shown = field.type === 'datetime' && typeof v === 'string' ? v.replace(' ', 'T') : v;
  const commit = () => { setEdit(false); if (String(v) !== String(value ?? '')) onSave(field.type === 'datetime' ? String(v).replace('T', ' ') : v); };
  return <input className="panel-cell" autoFocus={!always} type={type} step={field.type === 'money' ? 'any' : undefined} aria-label={field.label} value={shown} onChange={(e) => setV(e.target.value)} onBlur={commit} onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); if (e.key === 'Escape') { setV(value ?? ''); setEdit(false); } }} />;
}

const SUMMARY_ORDER = ['select', 'money', 'number', 'date', 'datetime', 'checkbox', 'text', 'url'];
/** Filas como tarjetas (celular): título + datos clave; al tocar se despliega el detalle editable. */
function RowCards({ cols, rows, edit, save, remove, draft, setDraft, add, empty }) {
  const [open, setOpen] = useState(null), [adding, setAdding] = useState(false), [limit, setLimit] = useState(25);
  const [title, ...rest] = cols;
  const pickMeta = (r) => rest.filter((f) => showValue(f, r[f.key]) !== '').sort((a, b) => SUMMARY_ORDER.indexOf(a.type) - SUMMARY_ORDER.indexOf(b.type)).slice(0, 3);
  return (
    <div className="row-cards">
      {edit && (
        <article className={`row-card ${adding ? 'open' : ''}`}>
          <button type="button" className="row-card-head new" onClick={() => setAdding((v) => !v)}><Icon name="plus" size={16} /><strong>Agregar fila</strong><Icon name="chevron" size={16} /></button>
          {adding && (
            <div className="row-card-body">
              {cols.map((f) => <label key={f.key} className="row-card-field"><span>{f.label}</span><Cell always field={f} value={draft[f.key]} onSave={(v) => setDraft((d) => ({ ...d, [f.key]: v }))} /></label>)}
              <div className="row"><Button icon="save" disabled={empty} onClick={async () => { await add(); setAdding(false); }}>Guardar</Button><Button variant="secondary" onClick={() => setAdding(false)}>Cancelar</Button></div>
            </div>
          )}
        </article>
      )}
      {rows.slice(0, limit).map((r) => {
        const isOpen = open === r.id;
        return (
          <article key={r.id} className={`row-card ${isOpen ? 'open' : ''}`}>
            <button type="button" className="row-card-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : r.id)}>
              <span className="row-card-main">
                <strong>{showValue(title, r[title.key]) || '—'}</strong>
                {!isOpen && <span className="row-card-meta">{pickMeta(r).map((f) => <span key={f.key} className="row-chip"><b>{f.label}</b> {showValue(f, r[f.key])}</span>)}</span>}
              </span>
              <Icon name="chevron" size={16} />
            </button>
            {isOpen && (
              <div className="row-card-body">
                <label className="row-card-field"><span>{title.label}</span><Cell always field={title} value={r[title.key]} disabled={!edit} onSave={(v) => save(r.id, title.key, v)} /></label>
                {rest.map((f) => <label key={f.key} className="row-card-field"><span>{f.label}</span><Cell always field={f} value={r[f.key]} disabled={!edit} onSave={(v) => save(r.id, f.key, v)} /></label>)}
                {edit && <div className="row"><InlineConfirm label="Borrar" message="¿Borrar esta fila?" confirmLabel="Sí" onConfirm={() => remove(r.id)} /></div>}
              </div>
            )}
          </article>
        );
      })}
      {rows.length > limit && <Button variant="secondary" onClick={() => setLimit((n) => n + 25)}>Mostrar más ({rows.length - limit} restantes)</Button>}
      {!rows.length && <p className="muted">Todavía no hay filas.</p>}
    </div>
  );
}

// ---------- datos de una colección (compartidos entre secciones del mismo panel por `version`) ----------
function useRows(collectionId, version, q = '', spec = null) {
  const { api } = usePanelApi();
  const fkey = hasSpec(spec) ? JSON.stringify(spec) : '';
  const [state, setState] = useState({ rows: null, collection: null, total: 0, error: '' });
  useEffect(() => {
    if (collectionId === null || collectionId === undefined || collectionId === 'reminders') return undefined;
    let live = true;
    api(`/collections/${collectionId}/rows?limit=1000${q ? `&q=${encodeURIComponent(q)}` : ''}${fkey ? `&filter=${encodeURIComponent(fkey)}` : ''}`).then((r) => live && setState({ ...r, error: '' })).catch((e) => live && setState((s) => ({ ...s, error: e.message })));
    return () => { live = false; };
  }, [collectionId, version, q, fkey]);
  return state;
}

export function HistoryList({ collectionId, onReverted, admin }) {
  const { api } = usePanelApi();
  const [items, setItems] = useState(null);
  useEffect(() => { api(`/collections/${collectionId}/history`).then(setItems).catch(() => setItems([])); }, [collectionId]);
  const label = { add: 'Agregó una fila', update: 'Modificó una fila', delete: 'Borró una fila' };
  if (!items) return <Skeleton rows={2} />;
  if (!items.length) return <p className="muted">Todavía no hay cambios.</p>;
  return (
    <ul className="list panel-history">
      {items.slice(0, 15).map((h) => (
        <li key={h.id}>
          <div>
            <strong>{label[h.action]}</strong>
            <small>{fmtDate(h.at)} · {h.by === 'agente' ? 'el agente' : h.by || 'el panel'}{h.reverted ? ' · deshecho' : ''}</small>
          </div>
          {admin && !h.reverted && <Button variant="secondary" onClick={async () => { await api(`/history/${h.id}/revert`, { method: 'POST' }); onReverted(); }}>Deshacer</Button>}
        </li>
      ))}
    </ul>
  );
}

// ---------- tabla ----------
export function TableWidget({ collectionId, widget, version, bump, admin, structure, toast, saveDefault }) {
  const { api, url, scope } = usePanelApi();
  const [spec, setSpec] = useFilterState(`kiri-f:${scope}:${widget.id}`, widget.config?.filter);
  const [q, setQ] = useState(''), [draft, setDraft] = useState({}), [showHistory, setShowHistory] = useState(false), [addField, setAddField] = useState(false), [nf, setNf] = useState({ label: '', type: 'text', options: '' });
  const { rows, collection, total, error } = useRows(collectionId, version, q, spec);
  const narrow = useNarrow();
  if (error) return <div className="error-block">{error}</div>;
  if (!rows) return <Skeleton rows={4} />;
  const cols = (widget.config?.columns?.length ? widget.config.columns.map((k) => collection.fields.find((f) => f.key === k)).filter(Boolean) : collection.fields);
  const save = (id, key, value) => api(`/collections/${collectionId}/rows/${id}`, { method: 'PUT', body: { [key]: value } }).then(bump).catch((e) => toast(e.message, 'err'));
  const add = () => api(`/collections/${collectionId}/rows`, { method: 'POST', body: { row: draft } }).then(() => { setDraft({}); bump(); }).catch((e) => toast(e.message, 'err'));
  const empty = !Object.values(draft).some((v) => v !== '' && v !== false && v !== undefined);
  async function createField() {
    try { await api(`/collections/${collectionId}/fields`, { method: 'POST', body: { label: nf.label, type: nf.type, options: nf.type === 'select' ? nf.options.split(',').map((s) => s.trim()).filter(Boolean) : undefined } }); setNf({ label: '', type: 'text', options: '' }); setAddField(false); bump(); }
    catch (e) { toast(e.message, 'err'); }
  }
  return (
    <>
      <div className="panel-toolbar">
        <label className="panel-search"><Icon name="search" size={15} /><input type="search" placeholder="Buscar…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <span className="muted">{total} fila{total === 1 ? '' : 's'}{activeCount(spec) ? ' (filtradas)' : ''}</span>
        <a className="btn btn-secondary" href={url(`/collections/${collectionId}/export?format=csv${hasSpec(spec) ? `&filter=${encodeURIComponent(JSON.stringify(spec))}` : ''}`)}><Icon name="download" size={16} /><span>Exportar CSV</span></a>
        <Button variant="secondary" icon="clock" onClick={() => setShowHistory((v) => !v)}>Historial</Button>
        {structure && <Button variant="secondary" icon="plus" onClick={() => setAddField((v) => !v)}>Campo</Button>}
      </div>
      <FilterBar fields={collection.fields} value={spec} onChange={setSpec} rows={rows} defaults={widget.config?.filter || null} onSaveDefault={saveDefault ? (s) => saveDefault(s) : undefined} />
      {addField && (
        <div className="row panel-newfield">
          <label>Nombre<input value={nf.label} onChange={(e) => setNf({ ...nf, label: e.target.value })} placeholder="Ej. Stock" /></label>
          <Combo label="Tipo" value={nf.type} onChange={(type) => setNf({ ...nf, type })} options={TYPE_OPTIONS} />
          {nf.type === 'select' && <label>Opciones (separadas por coma)<input value={nf.options} onChange={(e) => setNf({ ...nf, options: e.target.value })} placeholder="Nuevo, En curso, Listo" /></label>}
          <Button disabled={!nf.label.trim()} onClick={createField}>Agregar campo</Button>
        </div>
      )}
      {narrow ? (
        <RowCards cols={cols} rows={rows} edit={admin} save={save} remove={(id) => api(`/collections/${collectionId}/rows/${id}`, { method: 'DELETE' }).then(bump)} draft={draft} setDraft={setDraft} add={add} empty={empty} />
      ) : (
        <div className="panel-table-wrap">
          <table className="data-table panel-table">
            <thead><tr>{cols.map((f) => <th key={f.key} className={f.type === 'money' || f.type === 'number' ? 'num' : ''}>{f.label}</th>)}{admin && <th />}</tr></thead>
            <tbody>
              {admin && (
                <tr className="panel-newrow">
                  {cols.map((f) => <td key={f.key}><Cell always field={f} value={draft[f.key]} onSave={(v) => setDraft((d) => ({ ...d, [f.key]: v }))} /></td>)}
                  <td><Button icon="plus" disabled={empty} onClick={add}>Agregar</Button></td>
                </tr>
              )}
              {rows.map((r) => (
                <tr key={r.id}>
                  {cols.map((f) => <td key={f.key} className={f.type === 'money' || f.type === 'number' ? 'num' : ''}><Cell field={f} value={r[f.key]} disabled={!admin} onSave={(v) => save(r.id, f.key, v)} /></td>)}
                  {admin && <td><InlineConfirm label="Borrar" message="¿Borrar esta fila?" confirmLabel="Sí" onConfirm={() => api(`/collections/${collectionId}/rows/${r.id}`, { method: 'DELETE' }).then(bump)} /></td>}
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="muted" style={{ padding: 12 }}>{q ? 'Sin resultados.' : 'Todavía no hay filas.'}</p>}
        </div>
      )}
      {showHistory && <HistoryList collectionId={collectionId} admin={admin} onReverted={bump} />}
    </>
  );
}

// ---------- calendario ----------
export function CalendarWidget({ collectionId, widget, version, bump, admin, owner, toast, saveDefault }) {
  const { api, scope } = usePanelApi();
  const [spec, setSpec] = useFilterState(`kiri-f:${scope}:${widget.id}`, widget.config?.filter);
  const now = new Date();
  const [cur, setCur] = useState({ y: now.getFullYear(), m: now.getMonth() }), [sel, setSel] = useState(dayKey(now)), [mode, setMode] = useState('mes'), [title, setTitle] = useState('');
  const reminders = collectionId === 'reminders';
  const { rows, collection } = useRows(reminders ? null : collectionId, version, '', spec);
  const [events, setEvents] = useState([]);
  const from = new Date(cur.y, cur.m, 1).getTime() - 7 * 864e5, to = new Date(cur.y, cur.m + 1, 1).getTime() + 7 * 864e5;
  useEffect(() => {
    if (!reminders) return;
    api(`/panel-events?from=${from}&to=${to}${owner ? `&owner=${encodeURIComponent(owner)}` : ''}`).then(setEvents).catch(() => setEvents([]));
  }, [reminders, from, to, version, owner]);
  const list = useMemo(() => {
    if (reminders) return events.map((e) => { const d = new Date(e.at); return { key: dayKey(d), time: `${pad(d.getHours())}:${pad(d.getMinutes())}`, title: e.title, sub: `${e.contact}${e.recurring ? ' · se repite' : ''}` }; });
    if (!rows) return [];
    const df = widget.config?.dateField, tf = widget.config?.titleField;
    return rows.filter((r) => r[df]).map((r) => ({ key: String(r[df]).slice(0, 10), time: String(r[df]).length > 10 ? String(r[df]).slice(11, 16) : '', title: String(r[tf] ?? '—'), sub: '' }));
  }, [reminders, events, rows, widget]);
  const byDay = useMemo(() => { const m = {}; for (const e of list) (m[e.key] ||= []).push(e); for (const k of Object.keys(m)) m[k].sort((a, b) => a.time.localeCompare(b.time)); return m; }, [list]);
  const first = new Date(cur.y, cur.m, 1), lead = (first.getDay() + 6) % 7, days = new Date(cur.y, cur.m + 1, 0).getDate();
  const cells = [...Array(lead).fill(null), ...Array.from({ length: days }, (_, i) => i + 1)];
  const go = (n) => { const d = new Date(cur.y, cur.m + n, 1); setCur({ y: d.getFullYear(), m: d.getMonth() }); };
  const month = Object.entries(byDay).filter(([k]) => k.startsWith(`${cur.y}-${pad(cur.m + 1)}`)).sort(([a], [b]) => a.localeCompare(b));
  async function addEvent() {
    try { await api(`/collections/${collectionId}/rows`, { method: 'POST', body: { row: { [widget.config.titleField]: title, [widget.config.dateField]: sel } } }); setTitle(''); bump(); } catch (e) { toast(e.message, 'err'); }
  }
  const todayK = dayKey(now), selDate = new Date(Number(sel.slice(0, 4)), Number(sel.slice(5, 7)) - 1, Number(sel.slice(8, 10)));
  const plural = (n) => `${n} ${n === 1 ? 'evento' : 'eventos'}`;
  const longDay = (d) => `${WEEKDAYS[d.getDay()]} ${d.getDate()} de ${MONTHS[d.getMonth()]}`;
  const dayEvents = byDay[sel] || [];
  return (
    <>
      {!reminders && collection && <FilterBar fields={collection.fields} value={spec} onChange={setSpec} rows={rows || []} defaults={widget.config?.filter || null} onSaveDefault={saveDefault ? (x) => saveDefault(x) : undefined} />}
      <div className="panel-toolbar panel-cal-bar">
        <div className="panel-nav">
          <Button variant="secondary" icon="back" className="panel-nav-btn" onClick={() => go(-1)} aria-label="Mes anterior"><span className="panel-nav-txt">Anterior</span></Button>
          <strong className="panel-month" aria-live="polite">{MONTHS[cur.m]} {cur.y}</strong>
          <Button variant="secondary" className="panel-nav-btn" onClick={() => go(1)} aria-label="Mes siguiente"><span className="panel-nav-txt">Siguiente</span><Icon name="next" size={16} /></Button>
        </div>
        <div className="panel-view">
          <Button variant="secondary" onClick={() => { setCur({ y: now.getFullYear(), m: now.getMonth() }); setSel(todayK); }}>Hoy</Button>
          <Segmented hideLabel label="Vista" value={mode} onChange={setMode} options={[{ value: 'mes', label: 'Mes' }, { value: 'lista', label: 'Lista' }]} />
        </div>
      </div>
      {mode === 'mes' ? (
        <>
          <div className="panel-cal">
            {DOW.map((d) => <div key={d} className="panel-cal-dow">{d}</div>)}
            {cells.map((d, i) => {
              if (!d) return <div key={`e${i}`} className="panel-cal-cell empty" aria-hidden="true" />;
              const k = `${cur.y}-${pad(cur.m + 1)}-${pad(d)}`, ev = byDay[k] || [];
              return (
                <button key={k} type="button" className={`panel-cal-cell ${k === sel ? 'sel' : ''} ${k === todayK ? 'today' : ''} ${ev.length ? 'has' : ''}`} onClick={() => setSel(k)} aria-pressed={k === sel} aria-current={k === todayK ? 'date' : undefined} aria-label={`${d} de ${MONTHS[cur.m]}${k === todayK ? ', hoy' : ''}${ev.length ? `, ${plural(ev.length)}` : ''}`}>
                  <span className="panel-cal-top"><b>{d}</b>{ev.length > 0 && <em className="panel-cal-count">{ev.length}</em>}</span>
                  {ev.slice(0, 2).map((e, j) => <span key={j} className="panel-cal-ev">{e.time && <i>{e.time}</i>} {e.title}</span>)}
                  {ev.length > 2 && <span className="panel-cal-more">+{ev.length - 2} más</span>}
                  {ev.length > 0 && <span className="panel-cal-dots" aria-hidden="true">{ev.slice(0, 3).map((_, j) => <i key={j} />)}</span>}
                </button>
              );
            })}
          </div>
          <div className="panel-day">
            <div className="panel-day-head">
              <strong>{longDay(selDate)}</strong>
              {sel === todayK && <Badge>Hoy</Badge>}
              <span className="muted">{dayEvents.length ? plural(dayEvents.length) : ''}</span>
            </div>
            {dayEvents.length ? (
              <ul className="panel-day-list">{dayEvents.map((e, i) => (
                <li key={i}>
                  <span className={`panel-day-time ${e.time ? '' : 'none'}`}>{e.time || 'Todo el día'}</span>
                  <div><strong>{e.title}</strong>{e.sub && <small>{e.sub}</small>}</div>
                </li>
              ))}</ul>
            ) : <p className="panel-day-empty">Nada este día.</p>}
            {!reminders && admin && collection && (
              <div className="row panel-day-add">
                <label style={{ flex: 1 }}>Agregar en este día<input value={title} placeholder="Título" onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && title.trim() && addEvent()} /></label>
                <Button icon="plus" disabled={!title.trim()} onClick={addEvent}>Agregar</Button>
              </div>
            )}
          </div>
        </>
      ) : month.length ? (
        <div className="panel-agenda">
          <p className="muted panel-agenda-sum">{plural(month.reduce((n, [, ev]) => n + ev.length, 0))} en {month.length} {month.length === 1 ? 'día' : 'días'}</p>
          {month.map(([k, ev]) => {
            const d = new Date(Number(k.slice(0, 4)), Number(k.slice(5, 7)) - 1, Number(k.slice(8, 10)));
            return (
              <section key={k} className={`panel-agenda-day ${k === todayK ? 'today' : ''}`}>
                <header>
                  <span className="panel-agenda-num">{d.getDate()}</span>
                  <strong>{longDay(d)}</strong>
                  {k === todayK && <Badge>Hoy</Badge>}
                  <em className="panel-cal-count">{ev.length}</em>
                </header>
                <ul className="panel-day-list">{ev.map((e, i) => (
                  <li key={i}>
                    <span className={`panel-day-time ${e.time ? '' : 'none'}`}>{e.time || 'Todo el día'}</span>
                    <div><strong>{e.title}</strong>{e.sub && <small>{e.sub}</small>}</div>
                  </li>
                ))}</ul>
              </section>
            );
          })}
        </div>
      ) : <p className="panel-day-empty">No hay nada en {MONTHS[cur.m]} de {cur.y}.</p>}
      {reminders && <p className="help">Acá se ven los recordatorios activos (los que se repiten aparecen una vez por día). Se crean desde el chat con el agente.</p>}
    </>
  );
}

// ---------- tablero ----------
export function BoardWidget({ collectionId, widget, version, bump, admin, toast, saveDefault }) {
  const { api, scope } = usePanelApi();
  const [spec, setSpec] = useFilterState(`kiri-f:${scope}:${widget.id}`, widget.config?.filter);
  const { rows, collection, error } = useRows(collectionId, version, '', spec);
  if (error) return <div className="error-block">{error}</div>;
  if (!rows) return <Skeleton rows={3} />;
  const g = collection.fields.find((f) => f.key === widget.config.groupField), tf = widget.config.titleField;
  const others = collection.fields.filter((f) => f.key !== g.key && f.key !== tf).slice(0, 2);
  const cols = [...new Set([...(g.options || []), ...rows.map((r) => r[g.key]).filter(Boolean)])];
  const lanes = [...cols, ...(rows.some((r) => !r[g.key]) ? [''] : [])];
  const move = (r, to) => api(`/collections/${collectionId}/rows/${r.id}`, { method: 'PUT', body: { [g.key]: to } }).then(bump).catch((e) => toast(e.message, 'err'));
  return (
    <>
    <FilterBar fields={collection.fields} value={spec} onChange={setSpec} rows={rows} defaults={widget.config?.filter || null} onSaveDefault={saveDefault ? (x) => saveDefault(x) : undefined} />
    <div className="panel-board">
      {lanes.map((lane, li) => {
        const items = rows.filter((r) => (r[g.key] || '') === lane);
        return (
          <div key={lane || 'none'} className="panel-lane">
            <header><strong>{lane || 'Sin estado'}</strong><Badge>{items.length}</Badge></header>
            {items.map((r) => (
              <div key={r.id} className="panel-card">
                <strong>{String(r[tf] ?? '—')}</strong>
                {others.map((f) => r[f.key] !== null && r[f.key] !== undefined && r[f.key] !== '' && <small key={f.key}>{f.label}: {f.type === 'money' || f.type === 'number' ? money(r[f.key]) : String(r[f.key])}</small>)}
                {admin && (
                  <div className="row panel-card-move">
                    <Button variant="ghost" aria-label="Mover a la columna anterior" disabled={li === 0} onClick={() => move(r, lanes[li - 1])}><Icon name="back" size={14} /></Button>
                    <Button variant="ghost" aria-label="Mover a la columna siguiente" disabled={li === lanes.length - 1} onClick={() => move(r, lanes[li + 1])}><span style={{ display: 'inline-block', transform: 'scaleX(-1)' }}><Icon name="back" size={14} /></span></Button>
                  </div>
                )}
              </div>
            ))}
            {!items.length && <p className="muted">Vacío</p>}
          </div>
        );
      })}
    </div>
    </>
  );
}

// ---------- nota / resumen ----------
export function NoteWidget({ widget, admin, save }) {
  const [text, setText] = useState(widget.config?.text || ''), [edit, setEdit] = useState(false);
  return edit ? (
    <>
      <textarea className="memory-editor" value={text} onChange={(e) => setText(e.target.value)} spellCheck={false} maxLength={20000} />
      <div className="row"><Button icon="save" onClick={() => save({ config: { text } }).then(() => setEdit(false))}>Guardar</Button><Button variant="secondary" onClick={() => { setText(widget.config?.text || ''); setEdit(false); }}>Cancelar</Button></div>
    </>
  ) : (
    <>
      {widget.config?.text ? <MessageMarkdown text={widget.config.text} /> : <p className="muted">Nota vacía.</p>}
      {admin && <div className="row"><Button variant="secondary" onClick={() => setEdit(true)}>Editar</Button></div>}
    </>
  );
}
export function StatWidget({ collectionId, widget, version }) {
  const { rows, collection } = useRows(collectionId, version, '', widget.config?.filter || null);
  if (!rows) return <Skeleton rows={1} />;
  const f = collection.fields.find((x) => x.key === widget.config.field), nums = rows.map((r) => r[widget.config.field]).filter((x) => x !== null && x !== undefined && x !== '').map(Number).filter(Number.isFinite);
  const v = widget.config.fn === 'count' ? rows.length : widget.config.fn === 'sum' ? nums.reduce((a, b) => a + b, 0) : nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0;
  return <div className="panel-stat"><strong>{money(v)}</strong><span className="muted">{widget.config.fn === 'count' ? 'filas' : `${widget.config.fn === 'sum' ? 'suma' : 'promedio'} de ${f?.label || ''}`}</span></div>;
}


/** Las secciones de un panel (cada una en su tarjeta). `renderActions` agrega los controles de administración (subir, bajar, quitar). */
export function PanelBody({ panel, collections, version, bump, edit, structure, owner, renderActions, saveNote, saveConfig, toast, only }) {
  const colById = new Map(collections.map((c) => [String(c.id), c]));
  return (
    <>
      {!panel.widgets.length && <Empty title="Panel vacío">Todavía no hay secciones.</Empty>}
      {panel.widgets.map((w, i) => {
        if (only && w.id !== only) return null;
        const cid = w.collection, col = colById.get(String(cid));
        return (
          <Card key={w.id} title={w.title || WIDGET_LABEL[w.type]} action={renderActions?.(w, i)}>
            {w.type === 'table' && <TableWidget collectionId={cid} widget={w} version={version} bump={bump} admin={edit} structure={structure} toast={toast} saveDefault={saveConfig ? (f) => saveConfig(w.id, { filter: f }) : undefined} />}
            {w.type === 'calendar' && <CalendarWidget collectionId={cid} widget={w} version={version} bump={bump} admin={edit} owner={owner} toast={toast} saveDefault={saveConfig ? (f) => saveConfig(w.id, { filter: f }) : undefined} />}
            {w.type === 'board' && <BoardWidget collectionId={cid} widget={w} version={version} bump={bump} admin={edit} toast={toast} saveDefault={saveConfig ? (f) => saveConfig(w.id, { filter: f }) : undefined} />}
            {w.type === 'stat' && <StatWidget collectionId={cid} widget={w} version={version} />}
            {w.type === 'documents' && <DocumentsWidget owner={owner} version={version} bump={bump} manage={structure} toast={toast} />}
            {w.type === 'note' && <NoteWidget widget={w} admin={structure} save={(p) => saveNote(w.id, p)} />}
            {w.type !== 'note' && w.type !== 'documents' && cid !== 'reminders' && col && <p className="help">Datos: «{col.name}»{panel.widgets.filter((x) => String(x.collection) === String(cid)).length > 1 ? ' (compartidos con otras secciones de este panel)' : ''}.</p>}
          </Card>
        );
      })}
    </>
  );
}
