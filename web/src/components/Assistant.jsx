import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { Badge, Button, Icon, Switch } from './ui.jsx';
import MessageMarkdown from './MessageMarkdown.jsx';

// ---------- lo que se ve en pantalla: opciones que el asistente puede nombrar, resaltar y que la persona puede señalar ----------
const norm = (t) =>
  String(t || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9ñ ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
const ownText = (el) => {
  const c = el.cloneNode(true);
  c.querySelectorAll('input,textarea,select,button,svg,small,.help,[role=listbox],[role=combobox]').forEach((n) => n.remove());
  return c.textContent.replace(/\s+/g, ' ').trim();
};
const visible = (el) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
function collect() {
  const root = document.querySelector('.main');
  if (!root) return [];
  const out = [], seen = new Set();
  const add = (el, text, kind) => {
    text = String(text || '').replace(/\s+/g, ' ').trim();
    if (!text || text.length > 110 || el.closest('.kh-assistant') || !visible(el)) return;
    const k = `${kind}|${norm(text)}`;
    if (seen.has(k)) return;
    seen.add(k);
    out.push({ el, text, kind, section: el.closest('.card')?.querySelector('h2')?.textContent?.trim() || '' });
  };
  root.querySelectorAll('h1,h2,h3').forEach((el) => add(el, el.textContent, 'sección'));
  root.querySelectorAll('.switch-row').forEach((el) => add(el, el.querySelector('strong')?.textContent, 'interruptor'));
  root.querySelectorAll('label:not(.switch-row), .field-label').forEach((el) => add(el, ownText(el), 'campo'));
  root.querySelectorAll('.segmented button').forEach((el) => add(el, el.textContent, 'opción'));
  root.querySelectorAll('.btn').forEach((el) => add(el, el.textContent, 'botón'));
  return out.slice(0, 160);
}
function resolve(text, list = collect()) {
  const n = norm(text);
  if (!n) return null;
  return (list.find((c) => norm(c.text) === n) || list.find((c) => norm(c.text).includes(n) || (norm(c.text).length > 4 && n.includes(norm(c.text)))))?.el || null;
}
const clean = (t, n = 160) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, n);
const UNIT = '.switch-row, label, .field, .btn, .segmented, h1, h2, h3, h4';
const TITLE = ':scope > h2, :scope > h3, :scope > h4, :scope > .field-label, :scope > strong, :scope > legend';
/** La «opción» completa que hay bajo el puntero: no solo su título, sino el bloque con su descripción y su valor actual. */
function unitOf(target) {
  const main = document.querySelector('.main');
  let found = null;
  for (let e = target; e && e !== main && e.nodeType === 1; e = e.parentElement) {
    if (e.matches(UNIT)) { found = e; break; }
    if (e.matches('.card')) break;
    if (e.querySelector(':scope > h3, :scope > h4, :scope > .field-label, :scope > strong, :scope > legend')) { found = e; break; } // bloque con título propio (listas, grupos…)
  }
  if (found?.matches('.segmented')) found = found.closest('.field') || found; // el grupo de opciones se señala junto con su título
  if (found?.matches('.btn') && found.closest('.segmented')) found = found.closest('.field') || found;
  if (!found) found = target.closest?.('.card') || null;
  return found;
}
function describe(unit, target) {
  if (!unit) return null;
  const title = clean(
    unit.matches('.switch-row') ? unit.querySelector('strong')?.textContent
      : unit.matches('h1,h2,h3,h4,.btn') ? unit.textContent
        : unit.querySelector(TITLE)?.textContent || unit.querySelector('strong, .field-label')?.textContent || ownText(unit).split('  ')[0] || unit.querySelector('h2')?.textContent,
    110,
  );
  if (!title) return null;
  const desc = clean(unit.querySelector(':scope small, :scope .help, :scope p')?.textContent, 220);
  const input = unit.querySelector('input, textarea');
  let value = '';
  if (unit.matches('.switch-row') && input) value = input.checked ? 'Activado' : 'Desactivado';
  else if (input && input.type === 'radio') value = input.checked ? 'Elegida' : 'No elegida';
  else if (input && input.type === 'checkbox') value = input.checked ? 'Marcado' : 'Sin marcar';
  else if (input && input.type !== 'password' && input.value) value = clean(input.value, 80);
  else if (unit.querySelector('.combo-trigger')) value = clean(unit.querySelector('.combo-trigger').textContent, 80);
  else if (unit.querySelector('.segmented .selected')) value = clean(unit.querySelector('.segmented .selected').textContent, 80);
  const own = target?.closest?.('button, li, .chip, .tag, [role=radio]');
  const detail = own && unit.contains(own) && own !== unit ? clean(own.textContent, 60) : '';
  const section = unit.closest('.card')?.querySelector('h2')?.textContent?.trim() || '';
  return { el: unit, text: title, desc, value, detail: detail && detail !== title ? detail : '', section: section && section !== title ? section : '', kind: 'opción' };
}
function candidateAt(x, y) {
  const els = document.elementsFromPoint(x, y).filter((e) => !e.closest('.kh-assistant, .kh-marks, .kh-pick-bar') && e.closest('.main'));
  for (const e of els) { const d = describe(unitOf(e), e); if (d) return d; }
  return null;
}

// ---------- almacenamiento local (la charla vive en este navegador) ----------
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento: el asistente funciona igual */ } },
};
const uid = () => Math.random().toString(36).slice(2, 10);

const VALUES = { everyone: 'Todos', allowlist: 'Solo lista permitida', all: 'Todo', mention: 'Solo si lo mencionan', context: 'Mención o charla en curso', ask: 'Preguntar antes', notify: 'Enviar y avisar', direct: 'Enviar directo', each: 'Cada respuesta', off: 'No' };
const show = (v) => {
  if (v === true) return 'Activado';
  if (v === false) return 'Desactivado';
  if (v === null || v === undefined || v === '') return '—';
  if (Array.isArray(v)) return v.length ? v.map((x) => (typeof x === 'object' ? JSON.stringify(x) : x)).join(', ') : '(vacío)';
  if (typeof v === 'object') return Object.entries(v).map(([k, x]) => `${k}: ${show(x)}`).join(' · ');
  return VALUES[v] || String(v);
};

function ChangeCard({ a, admin, onApply, onDiscard, onUndo }) {
  return (
    <div className={`kh-change ${a.status}`}>
      <div className="kh-change-head">
        <Icon name="rules" size={15} />
        <strong>{a.summary || 'Cambio de configuración'}</strong>
      </div>
      <small>{a.label}</small>
      <ul>
        {Object.keys(a.changes).map((k) => (
          <li key={k}>
            <code>{a.names?.[k] || k}</code>
            <span className="kh-vals">
              <span className="kh-from">{show(a.current?.[k])}</span>
              <Icon name="next" size={12} />
              <span className="kh-to">{show(a.changes[k])}</span>
            </span>
          </li>
        ))}
      </ul>
      {a.error && <p className="kh-error">{a.error}</p>}
      <div className="kh-change-actions">
        {a.status === 'pending' && admin && (
          <>
            <Button icon="check" onClick={onApply}>Aplicar</Button>
            <Button variant="ghost" onClick={onDiscard}>Descartar</Button>
          </>
        )}
        {a.status === 'busy' && <small>Aplicando…</small>}
        {a.status === 'applied' && (
          <>
            <Badge tone="ok">Aplicado</Badge>
            <Button variant="ghost" icon="back" onClick={onUndo}>Deshacer</Button>
          </>
        )}
        {a.status === 'undone' && <Badge tone="neutral">Deshecho</Badge>}
        {a.status === 'discarded' && <Badge tone="neutral">Descartado</Badge>}
        {a.status === 'error' && admin && <Button variant="secondary" onClick={onApply}>Reintentar</Button>}
      </div>
    </div>
  );
}

const SUGGEST = ['¿Por dónde empiezo?', 'Explicame esta pantalla', '¿Qué puedo configurar acá?'];

export default function Assistant({ user, onChanged }) {
  const nav = useNavigate();
  const loc = useLocation();
  const admin = user.role === 'admin';
  const key = `kiri-assistant:${user.username}`;
  const [open, setOpen] = useState(false);
  const [msgs, setMsgs] = useState(() => store.get(key, []));
  const [input, setInput] = useState('');
  const [refs, setRefs] = useState([]);
  const [busy, setBusy] = useState(false);
  const [auto, setAuto] = useState(() => store.get(`${key}:auto`, false));
  const [opts, setOpts] = useState(false);
  const [marks, setMarks] = useState([]);
  const [rects, setRects] = useState([]);
  const [picking, setPicking] = useState(false);
  const [hover, setHover] = useState(null);
  const bodyRef = useRef(null), taRef = useRef(null), scrolled = useRef(false), msgsRef = useRef(msgs), autoRef = useRef(auto);
  msgsRef.current = msgs;
  autoRef.current = auto;

  const commit = useCallback((fn) => {
    const next = fn(msgsRef.current);
    msgsRef.current = next;
    setMsgs(next);
    store.set(key, next.slice(-40));
  }, [key]);
  useEffect(() => { store.set(`${key}:auto`, auto); }, [auto, key]);
  useLayoutEffect(() => { if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight; }, [msgs, busy, open]);
  useEffect(() => { if (open && !picking) taRef.current?.focus(); }, [open, picking]);

  // resaltado numerado: se recalcula si la página se mueve o cambia
  useEffect(() => {
    scrolled.current = false;
    if (!marks.length) { setRects([]); return undefined; }
    const tick = () => {
      const list = collect();
      const rs = marks.map((t, i) => { const el = resolve(t, list); if (!el) return null; if (!scrolled.current) { scrolled.current = true; el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } const r = el.getBoundingClientRect(); return { n: i + 1, x: r.left, y: r.top, w: r.width, h: r.height }; }).filter(Boolean);
      setRects(rs);
    };
    tick();
    const id = setInterval(tick, 350);
    window.addEventListener('scroll', tick, true);
    window.addEventListener('resize', tick);
    return () => { clearInterval(id); window.removeEventListener('scroll', tick, true); window.removeEventListener('resize', tick); };
  }, [marks]);

  // modo «señalar»: se pasa el puntero por la pantalla y un clic deja la opción referenciada en el mensaje
  useEffect(() => {
    if (!picking) { setHover(null); return undefined; }
    const move = (e) => { const c = candidateAt(e.clientX, e.clientY); if (!c) return setHover(null); const r = c.el.getBoundingClientRect(); setHover({ x: r.left, y: r.top, w: r.width, h: r.height }); };
    const click = (e) => {
      if (e.target.closest?.('.kh-pick-bar')) return;
      e.preventDefault(); e.stopPropagation();
      const c = candidateAt(e.clientX, e.clientY);
      if (c) setRefs((r) => (r.some((x) => x.label === c.text) ? r : [...r, { label: c.text, section: c.section, desc: c.desc, value: c.value, detail: c.detail, page: loc.pathname }].slice(-6)));
      setPicking(false); setOpen(true);
    };
    const esc = (e) => { if (e.key === 'Escape') { setPicking(false); setOpen(true); } };
    document.addEventListener('mousemove', move, true);
    document.addEventListener('click', click, true);
    document.addEventListener('keydown', esc, true);
    return () => { document.removeEventListener('mousemove', move, true); document.removeEventListener('click', click, true); document.removeEventListener('keydown', esc, true); };
  }, [picking, loc.pathname]);

  const patch = (id, idx, p) => commit((m) => m.map((x) => (x.id === id ? { ...x, actions: x.actions.map((a, i) => (i === idx ? { ...a, ...p } : a)) } : x)));
  async function applyAction(id, idx, a) {
    patch(id, idx, { status: 'busy', error: null });
    try {
      const r = await api('/assistant/apply', { method: 'POST', body: { area: a.area, changes: a.changes } });
      patch(id, idx, { status: 'applied', undo: r.undo });
      onChanged?.();
    } catch (e) { patch(id, idx, { status: 'error', error: e.message }); }
  }
  async function undoAction(id, idx, a) {
    patch(id, idx, { status: 'busy', error: null });
    try { await api('/assistant/apply', { method: 'POST', body: { area: a.area, changes: a.undo } }); patch(id, idx, { status: 'undone' }); onChanged?.(); }
    catch (e) { patch(id, idx, { status: 'applied', error: e.message }); }
  }

  async function ask(history, { sendRefs = [], hidden = false } = {}) {
    setBusy(true);
    try {
      const screen = { path: loc.pathname, labels: collect().map(({ text, kind, section }) => ({ text, kind, section })) };
      const r = await api('/assistant/chat', { method: 'POST', body: { messages: history.map((m) => ({ role: m.role, text: m.text })), screen, refs: sendRefs } });
      const id = uid();
      const actions = (r.actions || []).filter((a) => a.type === 'apply').map((a) => ({ ...a, status: 'pending' }));
      commit((m) => [...m, { id, role: 'assistant', text: r.text, actions }]);
      let navigated = false, highlighted = false;
      for (const a of r.actions || []) {
        if (a.type === 'navigate') { navigated = true; nav(a.to); }
        else if (a.type === 'highlight') { highlighted = true; setMarks(a.items); }
      }
      if (autoRef.current && admin) for (let i = 0; i < actions.length; i++) await applyAction(id, i, actions[i]);
      if (navigated && !highlighted && !hidden) { // la página nueva se ve recién ahora: se vuelve a consultar con lo que aparece
        await new Promise((res) => setTimeout(res, 900));
        const follow = { id: uid(), role: 'user', hidden: true, text: `(Aviso del sistema: el panel ya abrió la página. Con lo que se ve ahora en pantalla, continuá con mi pedido anterior: resaltá las opciones que correspondan y explicalas.)` };
        commit((m) => [...m, follow]);
        await ask([...msgsRef.current], { hidden: true });
      }
    } catch (e) {
      commit((m) => [...m, { id: uid(), role: 'assistant', text: e.message || 'No pude responder.', error: true, actions: [] }]);
    } finally { setBusy(false); }
  }
  function send(text) {
    const t = String(text ?? input).trim();
    if (!t || busy) return;
    const mine = { id: uid(), role: 'user', text: t, refs };
    const sendRefs = refs;
    setInput(''); setRefs([]); setMarks([]);
    commit((m) => [...m, mine]);
    ask([...msgsRef.current], { sendRefs });
  }
  const clear = () => { commit(() => []); setMarks([]); setRefs([]); };

  const shown = msgs.filter((m) => !m.hidden);
  return (
    <>
      {rects.length > 0 && (
        <div className="kh-marks" aria-hidden="true">
          {rects.map((r) => (
            <div key={r.n} className="kh-mark" style={{ left: r.x - 5, top: r.y - 5, width: r.w + 10, height: r.h + 10 }}>
              <b>{r.n}</b>
            </div>
          ))}
        </div>
      )}
      {picking && hover && <div className="kh-marks"><div className="kh-mark kh-hover" style={{ left: hover.x - 3, top: hover.y - 3, width: hover.w + 6, height: hover.h + 6 }} /></div>}
      {picking && (
        <div className="kh-pick-bar" role="status">
          <Icon name="pointer" size={15} />
          <span>Tocá la opción que querés consultar</span>
          <button className="btn btn-ghost" onClick={() => { setPicking(false); setOpen(true); }}>Cancelar</button>
        </div>
      )}
      <div className={`kh-assistant ${picking ? 'is-picking' : ''}`}>
        {open && (
          <section className="kh-panel" role="dialog" aria-label="Asistente de Kiri Hub">
            <header className="kh-head">
              <span className="kh-avatar"><Icon name="spark" size={16} /></span>
              <div>
                <strong>Asistente</strong>
                <small>{admin ? 'Te explico y configuro contigo' : 'Te explico cómo funciona'}</small>
              </div>
              <span className="kh-head-actions">
                {admin && <button className={`icon-btn ${opts ? 'on' : ''}`} onClick={() => setOpts(!opts)} aria-label="Ajustes del asistente" title="Ajustes"><Icon name="rules" size={16} /></button>}
                <button className="icon-btn" onClick={clear} aria-label="Nueva conversación" title="Nueva conversación" disabled={!msgs.length}><Icon name="refresh" size={16} /></button>
                <button className="icon-btn" onClick={() => setOpen(false)} aria-label="Cerrar asistente"><Icon name="close" size={16} /></button>
              </span>
            </header>
            {opts && (
              <div className="kh-opts">
                <Switch title="Aplicar cambios sin preguntar" desc="Si lo activás, lo que el asistente proponga se aplica al instante (siempre podés deshacerlo)." checked={auto} onChange={setAuto} />
              </div>
            )}
            <div className="kh-body" ref={bodyRef}>
              {!shown.length && (
                <div className="kh-welcome">
                  <h3>Hola, {user.username}</h3>
                  <p>Puedo explicarte cualquier opción del panel, llevarte a la página que necesitás{admin ? ' y dejar configuraciones listas por vos' : ''}. También podés <strong>señalar</strong> una opción de la pantalla y preguntarme por ella.</p>
                  <div className="kh-suggest">
                    {SUGGEST.map((s) => <button key={s} className="kh-chip" onClick={() => send(s)}>{s}</button>)}
                  </div>
                </div>
              )}
              {shown.map((m) => (
                <div key={m.id} className={`kh-msg ${m.role} ${m.error ? 'error' : ''}`}>
                  {m.role === 'user' && m.refs?.length > 0 && <div className="kh-refs">{m.refs.map((r) => <span key={r.label} className="kh-ref"><Icon name="pointer" size={11} />{r.label}</span>)}</div>}
                  <div className="kh-bubble">{m.role === 'assistant' && !m.error ? <MessageMarkdown text={m.text} /> : m.text}</div>
                  {m.actions?.map((a, i) => (
                    <ChangeCard key={i} a={a} admin={admin} onApply={() => applyAction(m.id, i, a)} onDiscard={() => patch(m.id, i, { status: 'discarded' })} onUndo={() => undoAction(m.id, i, a)} />
                  ))}
                </div>
              ))}
              {busy && <div className="kh-msg assistant"><div className="kh-bubble kh-typing" aria-label="Escribiendo"><i /><i /><i /></div></div>}
            </div>
            {marks.length > 0 && (
              <button className="kh-clear-marks" onClick={() => setMarks([])}><Icon name="close" size={12} /> Quitar resaltado ({marks.length})</button>
            )}
            <footer className="kh-compose">
              {refs.length > 0 && (
                <div className="kh-refs">
                  {refs.map((r) => (
                    <span key={r.label} className="kh-ref">
                      <Icon name="pointer" size={11} />{r.label}
                      <button aria-label="Quitar referencia" onClick={() => setRefs(refs.filter((x) => x !== r))}><Icon name="close" size={11} /></button>
                    </span>
                  ))}
                </div>
              )}
              <div className="kh-input">
                <textarea ref={taRef} rows={1} value={input} placeholder={refs.length ? 'Preguntá sobre lo que señalaste…' : 'Escribí tu pregunta…'} onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } }} />
                <button className="kh-send" onClick={() => send()} disabled={busy || !input.trim()} aria-label="Enviar"><Icon name="send" size={16} /></button>
              </div>
              <div className="kh-tools">
                <Button variant="ghost" icon="pointer" onClick={() => { setPicking(true); setOpen(false); }}>Señalar una opción</Button>
              </div>
            </footer>
          </section>
        )}
        <button className={`kh-fab ${open ? 'open' : ''}`} onClick={() => setOpen(!open)} aria-label={open ? 'Cerrar asistente' : 'Abrir asistente'} aria-expanded={open}>
          <Icon name={open ? 'close' : 'spark'} size={22} />
        </button>
      </div>
    </>
  );
}
