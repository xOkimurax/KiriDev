import React, { useEffect, useId, useRef, useState } from 'react';

const paths = {
  home: 'M3 10 12 3l9 7v10H3V10Zm6 10v-7h6v7',
  whatsapp:
    'M4 20l1.3-4A8.5 8.5 0 1 1 8 18.7L4 20Zm5-11c0 3 3 6 6 6l1-1.5-2-1-1 .7c-1-.5-1.7-1.2-2.2-2.2l.7-1-1-2L9 9Z',
  persona: 'M12 3 4 7v10l8 4 8-4V7l-8-4Zm-8 4 8 4 8-4m-8 4v10',
  memory: 'M6 4h12a2 2 0 0 1 2 2v15l-8-3-8 3V6a2 2 0 0 1 2-2Zm2 4h8m-8 4h6',
  mcp: 'M5 5h5v5H5V5Zm9 0h5v5h-5V5ZM5 14h5v5H5v-5Zm7-6h2m-6 2v4m2 2h4m2-6v4m-2 2h5',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Zm10-3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  eyeOff:
    'M3 3 21 21M10.6 6.1A11 11 0 0 1 12 6c6.5 0 10 6 10 6a15 15 0 0 1-3.2 3.6M7 7C4 8.5 2 12 2 12s3.5 6 10 6a10 10 0 0 0 3.2-.5M10 10a3 3 0 0 0 4 4',
  chat: 'M4 5h16v12H9l-5 3V5Z',
  play: 'm8 5 11 7-11 7V5Z',
  users:
    'M16 20v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m11-15a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm4 8a4 4 0 0 1 4 4v3h-4m-1-15a4 4 0 0 1 0 8',
  logout: 'M9 4H5v16h4m6-4 4-4-4-4m4 4H9',
  save: 'M5 4h12l3 3v13H5V4Zm3 0v6h8V4m-8 16v-7h9v7',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16m-10 4v6m4-6v6M6 7l1 13h10l1-13M9 7V4h6v3',
  refresh: 'M20 12a8 8 0 1 1-2-5.5M20 4v5h-5',
  send: 'M4 12 20 4l-6 16-3-7-7-1Z',
  pause: 'M8 5v14m8-14v14',
  clock: 'M12 7v5l4 2m5-2a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  check: 'm5 12 5 5 9-10',
  rules: 'M4 6h16M4 12h16M4 18h16M9 4v4m6 2v4m-6 2v4',
  menu: 'M4 7h16M4 12h16M4 17h16',
  close: 'M5 5l14 14M19 5 5 19',
  back: 'm15 5-7 7 7 7',
  next: 'm9 5 7 7-7 7',
  globe: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18Zm-9 9h18M12 3c-5 5-5 13 0 18m0-18c5 5 5 13 0 18',
  search: 'm20 20-4-4m2-5a7 7 0 1 1-14 0 7 7 0 0 1 14 0Z',
  chevron: 'm6 9 6 6 6-6',
  info: 'M12 11v5m0-8h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z',
  group:
    'M16 19v-1a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v1m12-10a4 4 0 1 1-8 0 4 4 0 0 1 8 0Zm4 5a4 4 0 0 1 4 4v1h-4m0-14a4 4 0 0 1 0 8',
  audio: 'M5 9v6m4-9v12m4-15v18m4-14v10m4-8v6',
  file: 'M6 3h8l5 5v13H6V3Zm8 0v5h5',
  image: 'M4 4h16v16H4V4Zm0 12 5-5 4 4 3-3 4 4',
  video: 'M4 6h12v12H4V6Zm12 4 5-3v10l-5-3',
  pin: 'M12 21s7-7 7-12a7 7 0 1 0-14 0c0 5 7 12 7 12Zm0-9a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-7 9v-2a7 7 0 0 1 14 0v2',
  tasks: 'M7 5h14M7 12h14M7 19h14M3 5h.01M3 12h.01M3 19h.01',
  alert: 'M12 3 2 21h20L12 3Zm0 7v4m0 3h.01',
  download: 'M12 3v12m-4-4 4 4 4-4M4 19h16',
  panel: 'M4 4h16v16H4V4Zm10 0v16',
  spark: 'M12 3l1.9 5.3L19 10l-5.1 1.7L12 17l-1.9-5.3L5 10l5.1-1.7L12 3Zm7 12 .8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8L19 15Z',
  pointer: 'M5 3l14 7.5-6.2 2.1L10.5 19 5 3Z',
  key: 'M15 7a4 4 0 1 1-3.4 6.1H9v2.4H6.6V18H3v-3.2l6.8-6.9A4 4 0 0 1 15 7Zm1.2 1.1h.01',
};
export const Icon = ({ name, size = 18 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d={paths[name] || paths.info} />
  </svg>
);
export const Button = React.forwardRef(function Button(
  { variant = 'primary', icon, children, className = '', ...props },
  ref,
) {
  return (
    <button ref={ref} className={`btn btn-${variant} ${className}`} {...props}>
      {icon && <Icon name={icon} size={16} />}
      <span>{children}</span>
    </button>
  );
});
export const Card = ({ title, action, children, className = '' }) => (
  <section className={`card ${className}`}>
    {(title || action) && (
      <header className="card-head">
        <h2>{title}</h2>
        {action}
      </header>
    )}
    {children}
  </section>
);
export const Badge = ({ tone = 'neutral', children }) => (
  <span className={`status status-${tone}`}>
    <i />
    {children}
  </span>
);
export const PageHead = ({ title, children }) => (
  <div className="page-head">
    <h1>{title}</h1>
    <div className="page-actions">{children}</div>
  </div>
);
export const Empty = ({ title, children, action }) => (
  <div className="empty">
    <strong>{title}</strong>
    {children && <span>{children}</span>}
    {action}
  </div>
);
export const Skeleton = ({ rows = 4 }) => (
  <div className="skeletons" aria-label="Cargando">
    {Array.from({ length: rows }, (_, i) => (
      <div key={i} className="skeleton" />
    ))}
  </div>
);
export const parseUTC = (s) => (s ? new Date(/Z$|[+-]\d\d:\d\d$/.test(s) ? s : s.replace(' ', 'T') + 'Z') : null);
export const fmtDate = (s) =>
  s ? parseUTC(s).toLocaleString('es-PY', { dateStyle: 'short', timeStyle: 'short' }) : '—';
export const fmtTime = (s) =>
  s ? parseUTC(s).toLocaleTimeString('es-PY', { hour: '2-digit', minute: '2-digit' }) : '—';
export const relative = (s) => {
  if (!s) return '—';
  const d = Math.max(0, Date.now() - parseUTC(s));
  if (d < 60000) return 'ahora';
  if (d < 3600000) return `${Math.floor(d / 60000)} min`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} h`;
  return parseUTC(s).toLocaleDateString('es-PY', { day: 'numeric', month: 'short' });
};
export const phone = (jid) => (jid?.includes('@') ? '+' + jid.split('@')[0] : jid || '—');
export const contactName = (c) => c?.name || phone(c?.wa_jid || String(c?.jid || '').replace(/^.*::/, ''));
export function useToast() {
  const [item, set] = useState(null);
  useEffect(() => {
    if (!item) return;
    const id = setTimeout(() => set(null), 3500);
    return () => clearTimeout(id);
  }, [item]);
  return [
    (message, type = 'ok') => set({ message, type }),
    item && (
      <div role="status" className={`toast toast-${item.type}`}>
        {item.message}
      </div>
    ),
  ];
}
export function InlineConfirm({
  label = 'Eliminar',
  message,
  confirmLabel = 'Sí, eliminar',
  onConfirm,
  variant = 'danger',
  disabled = false,
}) {
  const [open, set] = useState(false),
    [busy, setBusy] = useState(false);
  const ref = useRef();
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  async function yes() {
    setBusy(true);
    try {
      await onConfirm();
      set(false);
    } finally {
      setBusy(false);
    }
  }
  return open ? (
    <div className="inline-confirm">
      <span>{message || '¿Seguro?'}</span>
      <div className="row">
        <Button ref={ref} variant={variant} disabled={busy} onClick={yes}>
          {confirmLabel}
        </Button>
        <Button variant="ghost" disabled={busy} onClick={() => set(false)}>
          No
        </Button>
      </div>
    </div>
  ) : (
    <Button variant={variant} disabled={disabled} onClick={() => set(true)}>
      {label}
    </Button>
  );
}
export function Drawer({ title, onClose, children, footer }) {
  const closeRef = useRef();
  useEffect(() => {
    closeRef.current?.focus();
    const key = (e) => {
      if (e.key === 'Escape') onClose();
      if (e.key === 'Tab') {
        const focusable = [
          ...document.querySelectorAll(
            '.drawer button:not(:disabled),.drawer input:not(:disabled),.drawer textarea:not(:disabled),.drawer [tabindex="0"]',
          ),
        ];
        if (e.shiftKey && document.activeElement === focusable[0]) {
          e.preventDefault();
          focusable.at(-1)?.focus();
        } else if (!e.shiftKey && document.activeElement === focusable.at(-1)) {
          e.preventDefault();
          focusable[0]?.focus();
        }
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [onClose]);
  return (
    <div className="drawer-layer">
      <div className="drawer-scrim" onClick={onClose} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label={title}>
        <header>
          <h2>{title}</h2>
          <button ref={closeRef} className="icon-btn" onClick={onClose} aria-label="Cerrar">
            <Icon name="close" />
          </button>
        </header>
        <div className="drawer-body">{children}</div>
        {footer && <footer>{footer}</footer>}
      </aside>
    </div>
  );
}
export function Combo({
  label,
  value,
  onChange,
  options = [],
  placeholder = 'Elegir…',
  disabled = false,
  searchable = false,
  className = '',
  autoOpen = false,
  onClose,
}) {
  const [open, setOpen] = useState(autoOpen),
    [q, setQ] = useState(''),
    [active, setActive] = useState(0);
  const id = useId(),
    root = useRef(),
    trigger = useRef(),
    optionRefs = useRef([]);
  const filtered = options.filter(
    (o) => !q || `${o.label} ${o.description || ''} ${o.value}`.toLocaleLowerCase().includes(q.toLocaleLowerCase()),
  );
  const selected = options.find((o) => String(o.value) === String(value));
  const firstRun = useRef(true);
  useEffect(() => {
    if (firstRun.current) { firstRun.current = false; return; }
    if (!open) onClose?.();
  }, [open]);
  useEffect(() => {
    if (open) optionRefs.current[active]?.scrollIntoView({ block: 'nearest' });
  }, [open, active, q]);
  useEffect(() => {
    const outside = (e) => {
      if (!root.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, []);
  function choose(o) {
    onChange(o.value);
    setOpen(false);
    setQ('');
    trigger.current?.focus();
  }
  function key(e) {
    if (e.key === 'Escape') {
      setOpen(false);
      trigger.current?.focus();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(Math.max(0, filtered.length - 1), a + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(0, a - 1));
    } else if (e.key === 'Enter' && open && filtered[active]) {
      e.preventDefault();
      choose(filtered[active]);
    } else if (e.key === 'Home') {
      if (open) e.preventDefault();
      setActive(0);
    } else if (e.key === 'End') {
      if (open) e.preventDefault();
      setActive(Math.max(0, filtered.length - 1));
    }
  }
  return (
    <div className={`field combo ${className}`} ref={root}>
      <span className="field-label" id={`${id}-label`}>
        {label}
      </span>
      <button
        ref={trigger}
        type="button"
        className="combo-trigger"
        aria-labelledby={`${id}-label ${id}-value`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={`${id}-list`}
        disabled={disabled}
        onClick={() => {
          setOpen((v) => !v);
          setActive(
            Math.max(
              0,
              options.findIndex((o) => String(o.value) === String(value)),
            ),
          );
        }}
        onKeyDown={key}
      >
        <span id={`${id}-value`}>{selected?.label || placeholder}</span>
        <Icon name="chevron" size={16} />
      </button>
      {open && (
        <div className="combo-menu">
          {(searchable || options.length > 6) && (
            <input
              autoFocus
              aria-label={`Buscar ${label.toLowerCase()}`}
              placeholder="Buscar…"
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setActive(0);
              }}
              onKeyDown={key}
            />
          )}
          <div role="listbox" id={`${id}-list`} aria-labelledby={`${id}-label`} tabIndex={-1} onKeyDown={key}>
            {filtered.map((o, i) => (
              <React.Fragment key={String(o.value)}>
                {o.group && o.group !== filtered[i - 1]?.group && (
                  <div className="combo-group" role="presentation">
                    {o.group}
                  </div>
                )}
                <button
                  ref={(element) => {
                    optionRefs.current[i] = element;
                  }}
                  type="button"
                  role="option"
                  aria-selected={String(o.value) === String(value)}
                  className={i === active ? 'active' : ''}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => choose(o)}
                >
                  <span>
                    {o.label}
                    {o.description && <small className={o.monoDescription ? 'mono' : ''}>{o.description}</small>}
                  </span>
                  {String(o.value) === String(value) && <Icon name="check" size={16} />}
                </button>
              </React.Fragment>
            ))}
            {!filtered.length && <p className="muted pad">Sin resultados</p>}
          </div>
        </div>
      )}
    </div>
  );
}
export function Segmented({ label, value, onChange, options, disabled, hideLabel }) {
  return (
    <div className={`field ${hideLabel ? 'field-inline' : ''}`}>
      {!hideLabel && <span className="field-label">{label}</span>}
      <div className="segmented" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            disabled={disabled}
            className={value === o.value ? 'selected' : ''}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => {
              if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) {
                e.preventDefault();
                const i = options.findIndex((x) => x.value === value),
                  next =
                    options[
                      (i + (e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : options.length - 1)) % options.length
                    ];
                onChange(next.value);
                e.currentTarget.parentElement
                  .querySelectorAll('button')
                  [options.findIndex((x) => x.value === next.value)]?.focus();
              }
            }}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
export function Switch({ checked, onChange, disabled, title, desc }) {
  return (
    <label className="switch-row">
      <span>
        <strong>{title}</strong>
        {desc && <small>{desc}</small>}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={!!checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <i className="switch-track" />
    </label>
  );
}
export class ErrorBoundary extends React.Component {
  state = { error: null };
  static getDerivedStateFromError(error) {
    return { error };
  }
  componentDidCatch(error, info) {
    console.error(error, info?.componentStack);
    // se avisa al servidor para que el fallo quede en su log (antes se perdía)
    try {
      navigator.sendBeacon?.(
        '/api/client-error',
        new Blob(
          [
            JSON.stringify({
              message: String(error?.message),
              stack: String(error?.stack || '').slice(0, 1500),
              component: String(info?.componentStack || '').slice(0, 600),
              url: location.href,
            }),
          ],
          { type: 'application/json' },
        ),
      );
    } catch {
      /* sin reporte */
    }
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <h1>La pantalla tuvo un error</h1>
        <p>Recargá para volver a intentar.</p>
        <Button onClick={() => location.reload()}>Recargar</Button>
      </div>
    ) : (
      this.props.children
    );
  }
}
