import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import PersonaScope from '../components/PersonaScope.jsx';
import { PanelBody, TYPE_OPTIONS, WIDGET_LABEL, ALIAS } from '../components/panelWidgets.jsx';
import { Badge, Button, Card, Combo, Empty, Icon, InlineConfirm, PageHead, Skeleton, Switch, fmtDate, useToast } from '../components/ui.jsx';

/** "Producto, Precio:dinero, Estado:seleccion(Nuevo|En curso)" → campos. */
function parseFields(text) {
  return String(text || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const m = /^([^:(]+?)(?::\s*([a-záéíóúñ]+))?(?:\(([^)]*)\))?$/i.exec(s);
      const label = (m?.[1] || s).trim(), type = ALIAS[(m?.[2] || '').toLowerCase()] || (m?.[3] ? 'select' : 'text');
      return { label, type, ...(type === 'select' ? { options: (m?.[3] || '').split('|').map((o) => o.trim()).filter(Boolean) } : {}) };
    });
}
const ownerText = (p) => (p.owner ? `${p.owner_name || 'Contacto'}${p.owner_label ? ` · ${p.owner_label}` : ''}` : 'Hub (solo administradores)');

// ---------- agregar sección ----------
function AddWidget({ collections, owner, onAdd, onCollectionCreated }) {
  const [type, setType] = useState('table'), [col, setCol] = useState(''), [name, setName] = useState(''), [fields, setFields] = useState(''), [err, setErr] = useState('');
  const needsCol = type !== 'note' && type !== 'documents', newCol = col === '__new';
  async function add() {
    setErr('');
    try {
      let collection = col;
      if (needsCol && newCol) { const c = await api('/collections', { method: 'POST', body: { name, fields: parseFields(fields), owner: owner || 'hub' } }); collection = c.id; onCollectionCreated(); }
      await onAdd({ type, title: WIDGET_LABEL[type] || '', collection: type === 'calendar' && col === 'reminders' ? 'reminders' : collection, config: type === 'note' ? { text: '' } : {} });
      setName(''); setFields(''); setCol('');
    } catch (e) { setErr(e.message); }
  }
  const options = [...(type === 'calendar' ? [{ value: 'reminders', label: 'Recordatorios (tareas programadas)' }] : []), ...collections.map((c) => ({ value: String(c.id), label: c.name })), { value: '__new', label: '＋ Nueva colección…' }];
  return (
    <Card title="Agregar sección">
      <div className="row panel-addrow">
        <Combo label="Tipo" value={type} onChange={(t) => { setType(t); setCol(''); }} options={Object.entries(WIDGET_LABEL).map(([value, label]) => ({ value, label }))} />
        {needsCol && <Combo label="Datos" value={col} onChange={setCol} options={options} placeholder="Elegí una colección" />}
      </div>
      {needsCol && newCol && (
        <div className="stack">
          <label>Nombre de la colección<input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ej. Lista de precios" /></label>
          <label>Campos (separados por coma)<input value={fields} onChange={(e) => setFields(e.target.value)} placeholder="Producto, Precio:dinero, Estado:seleccion(Nuevo|En curso|Listo), Fecha:fecha" /></label>
          <small className="help">Tipos: texto, numero, dinero, fecha, fechahora, seleccion(opción|opción), casilla, enlace. Si no ponés tipo es texto.</small>
        </div>
      )}
      {err && <div className="error-block">{err}</div>}
      <div className="row"><Button icon="plus" disabled={needsCol && (!col || (newCol && (!name.trim() || !fields.trim())))} onClick={add}>Agregar</Button></div>
      <p className="help">El calendario necesita un campo de fecha y el tablero uno de tipo selección: se eligen solos. Podés pedirle al agente que arme el panel que necesites.</p>
    </Card>
  );
}

// ---------- enlace personal del dueño del panel ----------
function PersonalLink({ owner, toast }) {
  const [link, setLink] = useState(undefined);
  const load = useCallback(() => api('/panel-links').then((l) => setLink(l.find((x) => x.owner === owner) || null)).catch(() => setLink(null)), [owner]);
  useEffect(() => { setLink(undefined); load(); }, [load]);
  if (link === undefined) return null;
  const make = (rotate) => api('/panel-links', { method: 'POST', body: { owner, rotate } }).then(() => { load(); toast(rotate ? 'Enlace nuevo: el anterior ya no funciona' : 'Enlace creado'); }).catch((e) => toast(e.message, 'err'));
  return (
    <Card title="Enlace personal">
      <p className="help">Esta persona abre sus paneles con este enlace, sin contraseña y sin ver nada más del sistema: solo ve y edita lo suyo. Quien tenga el enlace puede entrar, así que se comparte solo con ella.</p>
      {link ? (
        <>
          <div className="row">
            <input readOnly value={link.url} aria-label="Enlace personal" onFocus={(e) => e.target.select()} style={{ flex: 1, minWidth: 220 }} />
            <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(link.url).then(() => toast('Enlace copiado'))}>Copiar</Button>
            <a className="btn btn-secondary" href={link.url} target="_blank" rel="noreferrer"><span>Abrir</span></a>
          </div>
          <p className="help">{link.last_used ? `Último uso: ${fmtDate(link.last_used)} · ${link.uses} aperturas` : 'Todavía no lo abrió nadie.'}</p>
          <div className="row">
            <InlineConfirm label="Cambiar enlace" variant="secondary" message="El enlace actual deja de funcionar." confirmLabel="Sí, cambiar" onConfirm={() => make(true)} />
            <InlineConfirm label="Desactivar enlace" message="La persona pierde el acceso hasta que se cree otro." confirmLabel="Sí, desactivar" onConfirm={async () => { await api(`/panel-links/${encodeURIComponent(owner)}`, { method: 'DELETE' }); load(); }} />
          </div>
        </>
      ) : <div className="row"><Button onClick={() => make(false)}>Crear enlace personal</Button></div>}
    </Card>
  );
}

// ---------- un panel ----------
function PanelView({ id, admin, onChanged, onDeleted }) {
  const [data, setData] = useState(null), [version, setVersion] = useState(0), [name, setName] = useState(''), [toast, toastNode] = useToast();
  const [only, setOnly] = useState('');
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  const load = useCallback(() => api(`/panels/${id}`).then((d) => { setData(d); setName(d.panel.title); }).catch((e) => toast(e.message, 'err')), [id]);
  useEffect(() => { setData(null); setOnly(''); load(); }, [load]);
  const [allCols, setAllCols] = useState([]);
  const ownerParam = data?.panel?.owner || 'hub';
  const loadCols = useCallback(() => api(`/collections?owner=${encodeURIComponent(ownerParam)}`).then(setAllCols).catch(() => {}), [ownerParam]);
  useEffect(() => { if (data) loadCols(); }, [data?.panel?.id, ownerParam]);
  if (!data) return <Skeleton rows={6} />;
  const { panel, collections } = data;
  const merged = [...collections, ...allCols.filter((c) => !collections.some((x) => x.id === c.id))];
  const saveWidgets = (widgets) => api(`/panels/${id}`, { method: 'PUT', body: { widgets } }).then(() => load()).catch((e) => { toast(e.message, 'err'); throw e; });
  const moveW = (i, d) => { const a = [...panel.widgets]; [a[i], a[i + d]] = [a[i + d], a[i]]; return saveWidgets(a); };
  return (
    <div className="stack">
      <div className="row panel-head">
        {admin ? <input className="panel-title-input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== panel.title && api(`/panels/${id}`, { method: 'PUT', body: { title: name } }).then(() => { load(); onChanged(); })} aria-label="Título del panel" /> : <h2>{panel.title}</h2>}
        <Badge tone={panel.owner ? 'ok' : 'neutral'}>{ownerText(panel)}</Badge>
        <span className="muted">{panel.created_by === 'agente' ? 'Creado por el agente' : panel.created_by === 'plantilla' ? 'Desde una plantilla' : 'Creado desde el panel'} · {fmtDate(panel.updated_at)}</span>
        {admin && <InlineConfirm label="Eliminar panel" message="Se elimina el panel; los datos de sus tablas se conservan." confirmLabel="Sí, eliminar" onConfirm={async () => { await api(`/panels/${id}`, { method: 'DELETE' }); onDeleted(); }} />}
      </div>
      {panel.widgets.length > 1 && (
        <nav className="section-tabs" aria-label="Secciones del panel">
          <button className={!only ? 'active' : ''} onClick={() => setOnly('')}>Todas</button>
          {panel.widgets.map((w) => <button key={w.id} className={only === w.id ? 'active' : ''} onClick={() => setOnly(w.id)}>{w.title || WIDGET_LABEL[w.type]}</button>)}
        </nav>
      )}
      <PanelBody
        only={only} panel={panel} collections={merged} version={version} bump={bump} edit={admin} structure={admin} owner={ownerParam} toast={toast}
        saveConfig={(wid, cfg) => saveWidgets(panel.widgets.map((w) => (w.id === wid ? { ...w, config: { ...w.config, ...cfg } } : w)))}
        saveNote={(wid, p) => saveWidgets(panel.widgets.map((w) => (w.id === wid ? { ...w, config: { ...w.config, ...(p.config || {}) } } : w)))}
        renderActions={admin ? (w, i) => (
          <div className="row">
            <Button variant="ghost" aria-label="Subir" disabled={i === 0} onClick={() => moveW(i, -1)}><span style={{ display: 'inline-block', transform: 'rotate(90deg)' }}><Icon name="back" size={14} /></span></Button>
            <Button variant="ghost" aria-label="Bajar" disabled={i === panel.widgets.length - 1} onClick={() => moveW(i, 1)}><span style={{ display: 'inline-block', transform: 'rotate(-90deg)' }}><Icon name="back" size={14} /></span></Button>
            <InlineConfirm label="Quitar" message="¿Quitar esta sección?" confirmLabel="Sí" onConfirm={() => saveWidgets(panel.widgets.filter((x) => x.id !== w.id))} />
          </div>
        ) : undefined}
      />
      {admin && <AddWidget collections={allCols} owner={panel.owner} onCollectionCreated={loadCols} onAdd={(w) => saveWidgets([...panel.widgets, w])} />}
      {admin && panel.owner && <PersonalLink owner={panel.owner} toast={toast} />}
      {toastNode}
    </div>
  );
}

// ---------- configuración ----------
function PanelSettings({ admin }) {
  const [s, setS] = useState(null), [saved, setSaved] = useState(''), [msg, setMsg] = useState('');
  useEffect(() => { api('/panel-settings').then((x) => { setS(x); setSaved(JSON.stringify(x)); }).catch(() => {}); }, []);
  if (!s) return null;
  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  async function save() { try { const x = await api('/panel-settings', { method: 'PUT', body: s }); setS(x); setSaved(JSON.stringify(x)); setMsg('Guardado'); } catch (e) { setMsg(e.message); } }
  return (
    <Card title="El agente y los paneles">
      <p className="help">Opcional. Si lo activás, el agente puede crear y mantener paneles (tablas, calendario, tableros, notas) dentro de cada conversación. Cada panel pertenece a la persona con la que se armó: el agente no ve ni mezcla los de otras personas. Vos, como administrador, los ves todos acá.</p>
      <Switch title="El agente puede crear y modificar paneles" checked={s.enabled} disabled={!admin} onChange={(v) => set('enabled', v)} />
      {s.enabled && (
        <>
          <PersonaScope value={s.personas} disabled={!admin} onChange={(v) => set('personas', v)} />
          <Switch title="Que sugiera paneles por su cuenta" desc="Si lo apagás, solo los arma cuando se lo pedís" checked={s.suggest} disabled={!admin} onChange={(v) => set('suggest', v)} />
          <Switch title="Guardar en Documentos los archivos que el agente envía" desc="PDF, Word, Excel, imágenes… quedan en la sección Documentos del panel de esa persona (hasta 300 MB por persona)" checked={s.autoSaveDocs} disabled={!admin} onChange={(v) => set('autoSaveDocs', v)} />
          <Switch title="Enlaces personales sin contraseña" desc="El agente le da a cada persona un enlace para ver y editar SOLO sus paneles, sin acceso al resto del sistema" checked={s.personalLinks} disabled={!admin} onChange={(v) => set('personalLinks', v)} />
        </>
      )}
      {admin && <div className="row"><Button icon="save" disabled={JSON.stringify(s) === saved} onClick={save}>Guardar</Button>{msg && <span className="muted">{msg}</span>}</div>}
    </Card>
  );
}

// ---------- página ----------
export default function Panels({ user }) {
  const admin = user.role === 'admin';
  const [params, setParams] = useSearchParams();
  const [list, setList] = useState(null), [owners, setOwners] = useState([]), [filter, setFilter] = useState('all'), [templates, setTemplates] = useState([]), [tpl, setTpl] = useState('agenda'), [title, setTitle] = useState(''), [err, setErr] = useState(''), [open, setOpen] = useState(false);
  const sel = params.get('panel');
  const load = useCallback(() => { api('/panels').then(setList).catch((e) => setErr(e.message)); api('/panel-owners').then(setOwners).catch(() => {}); }, []);
  useEffect(() => { load(); api('/panel-templates').then(setTemplates).catch(() => {}); }, [load]);
  const shown = useMemo(() => (list || []).filter((p) => filter === 'all' || (filter === 'hub' ? !p.owner : p.owner === filter)), [list, filter]);
  useEffect(() => { if (list && !sel && shown.length) setParams({ panel: String(shown[0].id) }, { replace: true }); }, [list, sel, shown.length]);
  async function create() {
    setErr('');
    try { const p = await api('/panels', { method: 'POST', body: { template: tpl, title: title.trim() || undefined, owner: filter !== 'all' && filter !== 'hub' ? filter : 'hub' } }); setTitle(''); setOpen(false); await load(); setParams({ panel: String(p.id) }); }
    catch (e) { setErr(e.message); }
  }
  const groups = useMemo(() => { const m = new Map(); for (const p of shown) { const k = p.owner || ''; if (!m.has(k)) m.set(k, { label: ownerText(p), items: [] }); m.get(k).items.push(p); } return [...m.values()]; }, [shown]);
  return (
    <>
      <PageHead title="Paneles">{admin && <Button icon="plus" onClick={() => setOpen((v) => !v)}>Nuevo panel</Button>}</PageHead>
      {open && (
        <Card title="Nuevo panel">
          <p className="help">{filter !== 'all' && filter !== 'hub' ? 'Se crea para el contacto elegido en el filtro.' : 'Se crea en el hub (solo lo ven los administradores). Los paneles para una persona los arma el agente en su chat, o elegí a la persona en el filtro de abajo.'}</p>
          <div className="row panel-addrow">
            <Combo label="Plantilla" value={tpl} onChange={setTpl} options={templates.map((t) => ({ value: t.id, label: t.label, description: t.desc }))} />
            <label>Título (opcional)<input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={80} placeholder="Ej. Pedidos de octubre" /></label>
            <Button onClick={create}>Crear</Button>
          </div>
          {err && <div className="error-block">{err}</div>}
        </Card>
      )}
      {owners.length > 0 && (
        <div className="row panel-filter">
          <Combo label="Mostrar paneles de" value={filter} onChange={(v) => { setFilter(v); setParams({}, { replace: true }); }} options={[{ value: 'all', label: 'Todos' }, { value: 'hub', label: 'Hub (solo administradores)' }, ...owners.map((o) => ({ value: o.key, label: `${o.owner_name || o.key}${o.owner_label ? ` · ${o.owner_label}` : ''}` }))]} />
        </div>
      )}
      {!list ? <Skeleton rows={5} /> : !shown.length ? (
        <Empty title="Todavía no hay paneles">Creá uno desde una plantilla, o activá al agente abajo (“El agente y los paneles”) y pedile en el chat: «armame un calendario con mis recordatorios».</Empty>
      ) : (
        <div className="panels-layout">
          <nav className="panels-list" aria-label="Paneles">
            {groups.map((g) => (
              <div key={g.label}>
                <small className="panels-folder">{g.label}</small>
                {g.items.map((p) => (
                  <button key={p.id} className={String(p.id) === sel ? 'active' : ''} onClick={() => setParams({ panel: String(p.id) })}>
                    <strong>{p.title}</strong>
                    <small>{p.widgets.length} sección{p.widgets.length === 1 ? '' : 'es'}{p.created_by === 'agente' ? ' · agente' : ''}</small>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="panels-main">{sel ? <PanelView key={sel} id={sel} admin={admin} onChanged={load} onDeleted={() => { setParams({}, { replace: true }); load(); }} /> : null}</div>
        </div>
      )}
      <div style={{ marginTop: 16 }}><PanelSettings admin={admin} /></div>
    </>
  );
}
