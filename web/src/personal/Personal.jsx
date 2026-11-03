import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api as baseApi } from '../api.js';
import { PanelApiContext, PanelBody, WIDGET_LABEL } from '../components/panelWidgets.jsx';
import { Empty, Icon, Skeleton, useToast } from '../components/ui.jsx';

const token = decodeURIComponent((location.pathname.match(/^\/p\/([^/]+)/) || [])[1] || '');
const WICON = { table: 'rules', calendar: 'clock', board: 'tasks', note: 'memory', stat: 'check', documents: 'file' };

function Section({ panelId, widgetId }) {
  const { api } = React.useContext(PanelApiContext);
  const [data, setData] = useState(null), [version, setVersion] = useState(0), [error, setError] = useState(''), [toast, toastNode] = useToast();
  const bump = useCallback(() => setVersion((v) => v + 1), []);
  useEffect(() => { setData(null); setError(''); api(`/panels/${panelId}`).then(setData).catch((e) => setError(e.message)); }, [panelId]);
  if (error) return <div className="error-block">{error}</div>;
  if (!data) return <Skeleton rows={6} />;
  return (
    <div className="stack">
      <PanelBody panel={data.panel} collections={data.collections} version={version} bump={bump} edit structure={false} only={widgetId} toast={toast} saveNote={() => Promise.resolve()} />
      {toastNode}
    </div>
  );
}

/** Versión personal: mismo esquema del hub (menú lateral en escritorio, hamburguesa en el celular) pero solo con los paneles y secciones de esta persona. */
export default function Personal() {
  const ctx = useMemo(() => ({ api: (path, o) => baseApi(`/p/${encodeURIComponent(token)}${path}`, o), url: (path) => `/api/p/${encodeURIComponent(token)}${path}`, scope: `p${token.slice(0, 8)}` }), []);
  const [me, setMe] = useState(null), [bad, setBad] = useState(false), [sel, setSel] = useState(null), [menu, setMenu] = useState(false);
  useEffect(() => {
    ctx.api('/me').then((m) => { setMe(m); const p = m.panels.find((x) => x.widgets.length); if (p) setSel({ panel: p.id, widget: p.widgets[0].id }); }).catch(() => setBad(true));
  }, [ctx]);
  const pick = (panel, widget) => { setSel({ panel, widget }); setMenu(false); window.scrollTo?.({ top: 0 }); };
  const cur = me && sel ? me.panels.find((p) => p.id === sel.panel) : null, curW = cur?.widgets.find((w) => w.id === sel.widget);
  return (
    <PanelApiContext.Provider value={ctx}>
      <div className="shell">
        <header className="mobile-bar">
          <button className="icon-btn" aria-label="Abrir menú" aria-expanded={menu} onClick={() => setMenu(true)}><Icon name="menu" /></button>
          <strong>kiri<span>.</span></strong>
        </header>
        {menu && <button className="nav-scrim" aria-label="Cerrar menú" onClick={() => setMenu(false)} />}
        <aside className={`sidebar ${menu ? 'open' : ''}`}>
          <div className="brand">
            <span className="brand-mark">kiri<span>.</span></span>
            <small>{me?.name ? `Paneles de ${me.name}` : 'Mis paneles'}</small>
          </div>
          <nav aria-label="Mis paneles" className="personal-nav">
            {me?.panels.map((p) => (
              <div key={p.id} className="nav-group">
                <small className="nav-group-title">{p.title}</small>
                {p.widgets.map((w) => (
                  <button key={w.id} type="button" className={`nav-link ${sel?.panel === p.id && sel?.widget === w.id ? 'active' : ''}`} onClick={() => pick(p.id, w.id)}>
                    <Icon name={WICON[w.type] || 'panel'} size={18} /><span>{w.title || WIDGET_LABEL[w.type]}</span>
                  </button>
                ))}
                {!p.widgets.length && <small className="muted nav-empty">Sin secciones todavía</small>}
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom"><small className="help">Este enlace es personal: no lo compartas. Guardalo en favoritos o en la pantalla de inicio del celular.</small></div>
        </aside>
        <main className="main">
          {bad ? (
            <Empty title="Este enlace no es válido">Ya no está activo o está incompleto. Pedile uno nuevo a quien te lo pasó.</Empty>
          ) : !me ? (
            <Skeleton rows={6} />
          ) : !cur || !curW ? (
            <Empty title="Todavía no hay paneles">Cuando se arme uno para vos, va a aparecer en el menú.</Empty>
          ) : (
            <>
              <p className="personal-crumb">{cur.title}</p>
              <Section key={`${cur.id}-${curW.id}`} panelId={cur.id} widgetId={curW.id} />
            </>
          )}
        </main>
      </div>
    </PanelApiContext.Provider>
  );
}
