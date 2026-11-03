import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import MessageMarkdown from './MessageMarkdown.jsx';
import { usePanelApi } from './panelApi.js';
import { useNarrow } from './useNarrow.js';
import { FilterBar, useFilterState } from './FilterBar.jsx';
import { applySpec, hasSpec, activeCount, inferFields } from './filters.js';

const todayLocal = () => new Date().toLocaleDateString('en-CA');
import { Button, Icon, InlineConfirm, Segmented, Skeleton, fmtDate } from './ui.jsx';

const DOC_FIELDS = [
  { key: 'name', label: 'Nombre', type: 'text' },
  { key: 'tipo', label: 'Tipo', type: 'select', options: ['PDF', 'Imagen', 'Tabla', 'Word', 'Texto', 'Archivo'] },
  { key: 'kb', label: 'Tamaño (KB)', type: 'number' },
  { key: 'fecha', label: 'Fecha', type: 'date' },
  { key: 'origen', label: 'Origen', type: 'select', options: ['Agente', 'Panel'] },
];
const KIND = { pdf: 'PDF', image: 'Imagen', text: 'Texto', md: 'Texto', table: 'Tabla', doc: 'Word', none: 'Archivo' };
const ICON = { pdf: 'file', image: 'image', text: 'file', md: 'file', table: 'rules', doc: 'file', none: 'file' };
const sizeText = (b) => (b > 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} KB`);
const cell = (v) => (v === 'true' ? 'sí' : v === 'false' ? 'no' : v);

/** PDF dibujado en la página (funciona también en celulares, donde el visor del navegador no muestra el PDF incrustado). */
function PdfView({ src }) {
  const box = useRef(null), [state, setState] = useState({ status: 'loading', pages: 0, shown: 0, error: '' });
  useEffect(() => {
    let dead = false, task = null;
    (async () => {
      try {
        const [pdfjs, res] = await Promise.all([import('pdfjs-dist'), fetch(src, { credentials: 'same-origin' })]);
        if (!res.ok) throw new Error('No se pudo abrir el archivo');
        pdfjs.GlobalWorkerOptions.workerSrc = pdfWorker;
        task = pdfjs.getDocument({ data: new Uint8Array(await res.arrayBuffer()), isEvalSupported: false });
        const pdf = await task.promise, total = pdf.numPages, show = Math.min(total, 40);
        if (dead) return;
        setState({ status: 'ok', pages: total, shown: show, error: '' });
        box.current.innerHTML = '';
        const width = box.current.clientWidth || 700, dpr = Math.min(2, window.devicePixelRatio || 1);
        for (let n = 1; n <= show && !dead; n++) {
          const page = await pdf.getPage(n), base = page.getViewport({ scale: 1 }), vp = page.getViewport({ scale: (width / base.width) * dpr });
          const c = document.createElement('canvas'); c.width = vp.width; c.height = vp.height; c.className = 'doc-pdf-page'; c.style.width = '100%';
          box.current.appendChild(c);
          await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
        }
      } catch (e) { if (!dead) setState({ status: 'error', pages: 0, shown: 0, error: e.message }); }
    })();
    return () => { dead = true; task?.destroy?.(); };
  }, [src]);
  return (
    <>
      {state.status === 'loading' && <Skeleton rows={4} />}
      {state.status === 'error' && <div className="error-block">No se pudo mostrar el PDF ({state.error}). Podés descargarlo.</div>}
      <div ref={box} className="doc-pdf" />
      {state.pages > state.shown && <p className="help">Se muestran las primeras {state.shown} páginas de {state.pages}. Descargalo para verlo completo.</p>}
    </>
  );
}

function Runs({ runs }) {
  return runs.map((r, i) => (r.b || r.i ? <span key={i} style={{ fontWeight: r.b ? 700 : undefined, fontStyle: r.i ? 'italic' : undefined }}>{r.text}</span> : <React.Fragment key={i}>{r.text}</React.Fragment>));
}
function DocView({ blocks }) {
  const out = []; let list = [];
  const flush = () => { if (list.length) { out.push(<ul key={`l${out.length}`}>{list.map((b, i) => <li key={i}><Runs runs={b.runs} /></li>)}</ul>); list = []; } };
  blocks.forEach((b, i) => {
    if (b.t === 'li') { list.push(b); return; }
    flush();
    if (b.t === 'h1') out.push(<h2 key={i}><Runs runs={b.runs} /></h2>);
    else if (b.t === 'h2') out.push(<h3 key={i}><Runs runs={b.runs} /></h3>);
    else if (b.t === 'h3') out.push(<h4 key={i}><Runs runs={b.runs} /></h4>);
    else if (b.t === 'table') out.push(<div key={i} className="panel-table-wrap"><table className="data-table"><tbody>{b.rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{c}</td>)}</tr>)}</tbody></table></div>);
    else out.push(<p key={i}><Runs runs={b.runs} /></p>);
  });
  flush();
  return <div className="doc-page">{out}</div>;
}
/** Hoja de cálculo en el celular: cada fila es una tarjeta (primera columna como título, 3 datos clave y el detalle completo al tocar). */
function SheetCards({ head, rows }) {
  const [open, setOpen] = useState(null), [limit, setLimit] = useState(25);
  const cols = head.map((h, i) => ({ h: cell(h) || `Columna ${i + 1}`, i }));
  return (
    <div className="row-cards">
      {rows.slice(0, limit).map((r, n) => {
        const isOpen = open === n, meta = cols.slice(1).filter((c) => cell(r[c.i]) !== '' && r[c.i] !== undefined).slice(0, 3);
        return (
          <article key={n} className={`row-card ${isOpen ? 'open' : ''}`}>
            <button type="button" className="row-card-head" aria-expanded={isOpen} onClick={() => setOpen(isOpen ? null : n)}>
              <span className="row-card-main">
                <strong>{cell(r[0]) || '—'}</strong>
                {!isOpen && <span className="row-card-meta">{meta.map((c) => <span key={c.i} className="row-chip"><b>{c.h}</b> {cell(r[c.i])}</span>)}</span>}
              </span>
              <Icon name="chevron" size={16} />
            </button>
            {isOpen && (
              <div className="row-card-body">
                {cols.slice(1).map((c) => <div key={c.i} className="row-card-field"><span>{c.h}</span><span className="cell-text">{cell(r[c.i]) || '—'}</span></div>)}
              </div>
            )}
          </article>
        );
      })}
      {rows.length > limit && <Button variant="secondary" onClick={() => setLimit((x) => x + 25)}>Mostrar más ({rows.length - limit} restantes)</Button>}
      {!rows.length && <p className="muted">No hay filas.</p>}
    </div>
  );
}
function TableView({ sheets, docId }) {
  const { scope } = usePanelApi();
  const [i, setI] = useState(0), [q, setQ] = useState(''), narrow = useNarrow(), sh = sheets[i] || sheets[0];
  const [spec, setSpec] = useFilterState(`kiri-f:${scope}:doc${docId}:${i}`, null);
  const head = sh?.rows[0] || [], all = sh?.rows.slice(1) || [];
  const fields = useMemo(() => inferFields(head, all), [sh]);
  const rows = useMemo(() => {
    let r = q ? all.filter((x) => x.some((c) => String(c ?? '').toLowerCase().includes(q.toLowerCase()))) : all;
    if (hasSpec(spec)) r = applySpec(r.map((x) => Object.fromEntries([['_r', x], ...x.map((c, k) => [`c${k}`, c])])), fields, spec, todayLocal()).map((x) => x._r);
    return r;
  }, [sh, q, spec]);
  if (!sh) return <p className="muted">Está vacío.</p>;
  return (
    <>
      {sheets.length > 1 && <Segmented label="Hoja" value={String(i)} onChange={(v) => { setI(Number(v)); setQ(''); }} options={sheets.map((s, n) => ({ value: String(n), label: s.name || `Hoja ${n + 1}` }))} />}
      <div className="panel-toolbar">
        <label className="panel-search"><Icon name="search" size={15} /><input type="search" placeholder="Buscar en la tabla…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <span className="muted">{rows.length} fila{rows.length === 1 ? '' : 's'}{activeCount(spec) || q ? ' (filtradas)' : ''}</span>
      </div>
      <FilterBar fields={fields} value={spec} onChange={setSpec} rows={all.map((x) => Object.fromEntries(x.map((c, k) => [`c${k}`, c])))} />
      {narrow ? <SheetCards key={`${i}-${q}`} head={head} rows={rows} /> : (
        <div className="panel-table-wrap">
          <table className="data-table doc-table">
            <thead><tr>{head.map((h, k) => <th key={k}>{cell(h)}</th>)}</tr></thead>
            <tbody>{rows.map((r, j) => <tr key={j}>{r.map((c, k) => <td key={k}>{cell(c)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      )}
      {sh.rows.length >= 400 && <p className="help">Se muestran las primeras filas. Descargalo para ver todo.</p>}
    </>
  );
}

function Viewer({ doc }) {
  const { api, url } = usePanelApi();
  const [data, setData] = useState(null), [error, setError] = useState('');
  const file = url(`/documents/${doc.id}/file`);
  useEffect(() => {
    setData(null); setError('');
    if (['pdf', 'image', 'none'].includes(doc.view)) return;
    api(`/documents/${doc.id}/preview`).then(setData).catch((e) => setError(e.message));
  }, [doc.id]);
  if (doc.view === 'pdf') return <PdfView src={file} />;
  if (doc.view === 'image') return <img className="doc-img" src={file} alt={doc.title || doc.name} />;
  if (doc.view === 'none') return <p className="muted">Este tipo de archivo no se puede mostrar acá. Descargalo para abrirlo.</p>;
  if (error) return <div className="error-block">No se pudo mostrar: {error}. Podés descargarlo.</div>;
  if (!data) return <Skeleton rows={4} />;
  if (data.kind === 'table') return <TableView docId={doc.id} sheets={data.sheets} />;
  if (data.kind === 'doc') return <DocView blocks={data.blocks} />;
  if (data.kind === 'md') return <div className="doc-page"><MessageMarkdown text={data.text} /></div>;
  return <><pre className="doc-pre">{data.text}</pre>{data.truncated && <p className="help">Se muestra el comienzo. Descargalo para verlo completo.</p>}</>;
}

/** Sección «Documentos»: lista de archivos guardados (los del dueño del panel) con vista previa dentro de la página, sin descargar. */
export function DocumentsWidget({ owner, version, bump, manage, toast }) {
  const { api, url, scope } = usePanelApi();
  const [docs, setDocs] = useState(null), [open, setOpen] = useState(null), [q, setQ] = useState(''), [busy, setBusy] = useState(false), input = useRef(null);
  const [spec, setSpec] = useFilterState(`kiri-f:${scope}:docs`, null);
  const load = useCallback(() => api(`/documents${owner ? `?owner=${encodeURIComponent(owner)}` : ''}`).then(setDocs).catch((e) => { setDocs([]); toast?.(e.message, 'err'); }), [owner, version]);
  useEffect(() => { load(); }, [load]);
  async function upload(file) {
    if (!file) return;
    setBusy(true);
    try {
      const r = await fetch(url(`/documents?name=${encodeURIComponent(file.name)}&owner=${encodeURIComponent(owner || 'hub')}`), { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error || `Error ${r.status}`);
      toast?.('Documento guardado'); bump?.();
    } catch (e) { toast?.(e.message, 'err'); } finally { setBusy(false); if (input.current) input.current.value = ''; }
  }
  if (!docs) return <Skeleton rows={3} />;
  const frows = docs.map((d) => ({ ...d, name: d.title || d.name, tipo: KIND[d.view], kb: Math.max(1, Math.round(d.size / 1024)), origen: d.created_by === 'agente' ? 'Agente' : 'Panel', fecha: d.created_at }));
  const found = applySpec(frows.filter((d) => !q || `${d.name}`.toLowerCase().includes(q.toLowerCase())), DOC_FIELDS, spec, todayLocal());
  const shown = found.map((f) => docs.find((d) => d.id === f.id));
  const cur = docs.find((d) => d.id === open);
  return (
    <>
      <div className="panel-toolbar">
        <label className="panel-search"><Icon name="search" size={15} /><input type="search" placeholder="Buscar documentos…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
        <span className="muted">{shown.length === docs.length ? `${docs.length} documento${docs.length === 1 ? '' : 's'}` : `${shown.length} de ${docs.length} documentos`}</span>
        {manage && (
          <>
            <input ref={input} type="file" hidden onChange={(e) => upload(e.target.files?.[0])} />
            <Button variant="secondary" icon="plus" disabled={busy} onClick={() => input.current?.click()}>Subir archivo</Button>
          </>
        )}
      </div>
      {!cur && docs.length > 0 && <FilterBar fields={DOC_FIELDS} value={spec} onChange={setSpec} rows={frows} />}
      {!docs.length && <p className="muted">Todavía no hay documentos. Los archivos que el agente te prepare van a aparecer acá.</p>}
      {cur && (
        <div className="doc-viewer">
          <div className="row doc-viewer-head">
            <Button variant="secondary" icon="back" onClick={() => setOpen(null)}>Volver a la lista</Button>
            <strong>{cur.title || cur.name}</strong>
            <a className="btn btn-secondary" href={url(`/documents/${cur.id}/file?download=1`)}><Icon name="download" size={16} /><span>Descargar</span></a>
          </div>
          <Viewer key={cur.id} doc={cur} />
        </div>
      )}
      {!cur && (
        <ul className="list doc-list">
          {shown.map((d) => (
            <li key={d.id}>
              <button className="doc-item" onClick={() => setOpen(d.id)}>
                <Icon name={ICON[d.view] || 'file'} size={20} />
                <span><strong>{d.title || d.name}</strong><small>{KIND[d.view]} · {sizeText(d.size)} · {fmtDate(d.created_at)}{d.created_by === 'agente' ? ' · del agente' : ''}</small></span>
              </button>
              {manage && <InlineConfirm label="Borrar" message="¿Borrar este documento?" confirmLabel="Sí" onConfirm={async () => { await api(`/documents/${d.id}`, { method: 'DELETE' }); bump?.(); load(); }} />}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
