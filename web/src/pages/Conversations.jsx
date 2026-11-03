import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import {
  Badge,
  Button,
  Combo,
  Drawer,
  Empty,
  Icon,
  InlineConfirm,
  PageHead,
  Skeleton,
  contactName,
  fmtTime,
  parseUTC,
  phone,
  relative,
  useToast,
} from '../components/ui.jsx';
import {
  conversationPreview,
  mediaTitleIsLabel,
  parseMessage,
  previewMessage,
  quotedPreview,
} from '../components/message.js';
import MessageMarkdown from '../components/MessageMarkdown.jsx';
const mediaIcons = { audio: 'audio', image: 'image', file: 'file', video: 'video', location: 'pin', contact: 'user' };
const sysIcons = {
  persona: 'persona',
  task: 'tasks',
  done: 'check',
  failed: 'alert',
  cancelled: 'close',
  info: 'info',
};
function senderHue(name) {
  let hash = 0;
  for (const character of name) hash = (hash * 31 + character.codePointAt(0)) | 0;
  return Math.abs(hash) % 360;
}
function FileChips({ files }) {
  return files?.length ? (
    <div className="file-chips">
      {files.map((f, i) => (
        <span className="file-chip" key={i}>
          <Icon name="file" size={15} />
          {typeof f === 'string' ? f : f.fileName}
        </span>
      ))}
    </div>
  ) : null;
}
function Message({ m, grouped, original, contact, group, onQuoteClick, messageRef, highlighted }) {
  const p = parseMessage(m);
  if (p.type === 'system')
    return (
      <div className="system-event">
        <Icon name={sysIcons[p.kind]} size={14} />
        {p.text}
      </div>
    );
  return (
    <div
      ref={messageRef}
      className={`message ${m.role} ${grouped ? 'grouped' : ''} ${highlighted ? 'message-highlighted' : ''}`}
      tabIndex={-1}
    >
      {group && m.role === 'user' && m.sender && (
        <strong className="message-sender" style={{ '--sender-hue': senderHue(m.sender) }}>
          {m.sender}
        </strong>
      )}
      {m.quoted &&
        (original ? (
          <button
            type="button"
            className="message-quote message-quote-button"
            title="Ir al mensaje original"
            onClick={() => onQuoteClick(original.id)}
          >
            <span className="message-quote-author">
              {original.role === 'assistant' ? 'Kiri' : group ? original.sender || 'Participante' : contact}
            </span>
            <span className="message-quote-text">{quotedPreview(m.quoted, original.role)}</span>
          </button>
        ) : (
          <div className="message-quote">
            <span className="message-quote-text">{quotedPreview(m.quoted)}</span>
            <span className="message-quote-missing">Original fuera del historial</span>
          </div>
        ))}
      {p.media ? (
        <div className="media-card">
          <span className="media-title">
            <Icon name={mediaIcons[p.media]} size={17} />
            {
              {
                audio: 'Nota de voz',
                image: 'Imagen',
                file: 'Archivo',
                video: 'Video',
                location: 'Ubicación',
                contact: 'Contacto',
              }[p.media]
            }
          </span>
          {p.title && !mediaTitleIsLabel(p.media, p.title) && <span>{p.title}</span>}
          {p.text && (
            <div className="muted">
              <MessageMarkdown text={p.text} />
            </div>
          )}
        </div>
      ) : (
        p.text && <MessageMarkdown text={p.text} />
      )}
      <FileChips files={p.files} />
      <span className="message-meta">
        {fmtTime(m.created_at)}
        {m.role === 'assistant' && m.duration_ms ? ` · ${(m.duration_ms / 1000).toFixed(1)} s` : ''}
      </span>
    </div>
  );
}
const dayLabel = (s) => {
  const d = parseUTC(s),
    today = new Date(),
    yesterday = new Date(Date.now() - 86400000);
  if (d?.toDateString() === today.toDateString()) return 'Hoy';
  if (d?.toDateString() === yesterday.toDateString()) return 'Ayer';
  return d?.toLocaleDateString('es-PY', { day: 'numeric', month: 'long', year: 'numeric' }) || '';
};
export default function Conversations({ user }) {
  const admin = user.role === 'admin';
  const [list, setList] = useState([]),
    [lastRoles, setLastRoles] = useState({}),
    [quotedSearch, setQuotedSearch] = useState({}),
    [tasks, setTasks] = useState([]),
    [personas, setPersonas] = useState([]),
    [jid, setJid] = useState(null),
    [msgs, setMsgs] = useState([]),
    [contactMemory, setContactMemory] = useState(null),
    [memoryLoading, setMemoryLoading] = useState(false),
    [memoryError, setMemoryError] = useState(''),
    [loading, setLoading] = useState(true),
    [error, setError] = useState(''),
    [threadError, setThreadError] = useState(''),
    [query, setQuery] = useState(''),
    [filter, setFilter] = useState('all'),
    [drawer, setDrawer] = useState(false),
    [deleteOpen, setDeleteOpen] = useState(false),
    [deleteBusy, setDeleteBusy] = useState(false),
    [deleteError, setDeleteError] = useState(''),
    [detailVisible, setDetailVisible] = useState(true),
    [newCount, setNewCount] = useState(0),
    [highlightedId, setHighlightedId] = useState(null),
    [toast, toastNode] = useToast();
  const scroll = useRef(),
    messageRefs = useRef(new Map()),
    highlightTimer = useRef(null),
    bottom = useRef(true),
    lastId = useRef(null),
    selected = useRef(null),
    initThread = useRef(false),
    pollBusy = useRef(false),
    refreshGeneration = useRef(0),
    deleteConfirmRef = useRef(null),
    deleteTriggerRef = useRef(null),
    listWidth = useRef(310),
    detailWidth = useRef(300),
    [widths, setWidths] = useState({ list: 310, detail: 300 });
  selected.current = jid;
  useEffect(() => {
    if (deleteOpen) deleteConfirmRef.current?.focus();
  }, [deleteOpen, drawer]);
  useEffect(() => {
    setDeleteOpen(false);
    setDeleteError('');
  }, [jid]);
  useEffect(() => {
    if (!jid) {
      setContactMemory(null);
      return;
    }
    let current = true;
    setMemoryLoading(true);
    api(`/memory/contact/${encodeURIComponent(jid)}`)
      .then((memory) => {
        if (current) {
          setContactMemory(memory);
          setMemoryError('');
        }
      })
      .catch((cause) => {
        if (current) setMemoryError(cause.message);
      })
      .finally(() => {
        if (current) setMemoryLoading(false);
      });
    return () => {
      current = false;
    };
  }, [jid]);
  const roleCache = useRef(new Map());
  const refresh = useCallback(async () => {
    if (pollBusy.current) return;
    pollBusy.current = true;
    const generation = refreshGeneration.current;
    try {
      const [l, t] = await Promise.all([api('/conversations'), api('/tasks?limit=200')]);
      if (generation !== refreshGeneration.current) return;
      setList(l);
      setTasks(t);
      setError('');
      const changed = l.filter((c) => roleCache.current.get(c.jid)?.stamp !== c.last_message_at);
      for (const c of changed) {
        api(`/conversations/${encodeURIComponent(c.jid)}`)
          .then((m) => {
            if (generation !== refreshGeneration.current) return;
            roleCache.current.set(c.jid, { stamp: c.last_message_at, role: m.at(-1)?.role });
            setLastRoles((o) => ({ ...o, [c.jid]: m.at(-1)?.role }));
            setQuotedSearch((current) => ({ ...current, [c.jid]: m.map((message) => message.quoted || '').join(' ') }));
          })
          .catch(() => {});
      }
      const active = selected.current;
      if (active) {
        try {
          const m = await api(`/conversations/${encodeURIComponent(active)}`);
          if (generation !== refreshGeneration.current) return;
          setMsgs(m);
          setThreadError('');
        } catch (e) {
          if (generation === refreshGeneration.current) setThreadError(e.message);
        }
      }
    } catch (e) {
      if (generation === refreshGeneration.current) setError(e.message);
    } finally {
      setLoading(false);
      pollBusy.current = false;
    }
  }, []);
  useEffect(() => {
    api('/personas')
      .then(setPersonas)
      .catch(() => {});
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => clearInterval(timer);
  }, [refresh]);
  useEffect(() => {
    clearTimeout(highlightTimer.current);
    setHighlightedId(null);
    if (!jid) {
      setMsgs([]);
      lastId.current = null;
      messageRefs.current.clear();
      setHighlightedId(null);
      return;
    }
    let current = true;
    setMsgs([]);
    initThread.current = true;
    api(`/conversations/${encodeURIComponent(jid)}`)
      .then((m) => {
        if (!current) return;
        setMsgs(m);
        setThreadError('');
      })
      .catch((e) => {
        if (current) setThreadError(e.message);
      });
    api('/personas')
      .then(setPersonas)
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [jid]);
  useEffect(() => () => clearTimeout(highlightTimer.current), []);
  useLayoutEffect(() => {
    const newest = msgs.at(-1)?.id;
    if (initThread.current && msgs.length) {
      scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
      initThread.current = false;
      lastId.current = newest;
      return;
    }
    if (newest && newest !== lastId.current) {
      const added = msgs.filter((m) => m.id > (lastId.current || 0)).length;
      if (bottom.current) scroll.current?.scrollTo({ top: scroll.current.scrollHeight });
      else setNewCount((n) => n + added);
      lastId.current = newest;
    }
  }, [msgs]);
  const taskByJid = useMemo(() => {
    const map = new Map();
    for (const t of tasks) {
      if (!map.has(t.jid)) map.set(t.jid, []);
      map.get(t.jid).push(t);
    }
    return map;
  }, [tasks]);
  const sel = list.find((c) => c.jid === jid) || null;
  const messagesById = useMemo(() => new Map(msgs.map((message) => [String(message.id), message])), [msgs]);
  const ownTasks = taskByJid.get(jid) || [];
  const running = ownTasks.filter((t) => t.status === 'running');
  const completedReplies = msgs.filter((message) => message.duration_ms);
  const averageSeconds = completedReplies.length
    ? completedReplies.reduce((total, message) => total + message.duration_ms, 0) / completedReplies.length / 1000
    : null;
  const defaultPersona = personas.find((p) => p.is_default);
  const personaName = (id) => personas.find((p) => p.id === id)?.name;
  const visible = list.filter((c) => {
    if (filter === 'running' && !taskByJid.get(c.jid)?.some((t) => t.status === 'running')) return false;
    if (filter === 'paused' && !c.paused) return false;
    if (filter.startsWith('persona:') && String(c.persona_id || '') !== filter.slice(8)) return false;
    const q = query.toLocaleLowerCase();
    return (
      !q || `${c.name || ''} ${c.jid} ${c.instanceLabel || ''} ${c.last || ''} ${quotedSearch[c.jid] || ''}`.toLocaleLowerCase().includes(q)
    );
  });
  function jumpToMessage(id) {
    const target = messageRefs.current.get(String(id));
    const container = scroll.current;
    if (!target || !container) return;
    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const top =
      container.scrollTop +
      target.getBoundingClientRect().top -
      container.getBoundingClientRect().top -
      (container.clientHeight - target.clientHeight) / 2;
    bottom.current = false;
    container.scrollTo({ top, behavior: reduceMotion ? 'auto' : 'smooth' });
    target.focus({ preventScroll: true });
    setHighlightedId(String(id));
    clearTimeout(highlightTimer.current);
    highlightTimer.current = setTimeout(() => setHighlightedId(null), 3000);
  }
  async function changePersona(id) {
    try {
      await api(`/contacts/${encodeURIComponent(jid)}/persona`, {
        method: 'PUT',
        body: { personaId: id ? Number(id) : null },
      });
      setList((l) => l.map((c) => (c.jid === jid ? { ...c, persona_id: id ? Number(id) : null } : c)));
      toast('Personalidad asignada');
      refresh();
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  async function pause() {
    try {
      await api(`/conversations/${encodeURIComponent(jid)}/pause`, { method: 'POST', body: { paused: !sel.paused } });
      setList((l) => l.map((c) => (c.jid === jid ? { ...c, paused: !c.paused } : c)));
      toast(sel.paused ? 'Agente reanudado' : 'Agente pausado');
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  async function reset() {
    try {
      await api(`/conversations/${encodeURIComponent(jid)}/reset`, { method: 'POST' });
      toast('Memoria reiniciada · El historial visible se conserva');
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  async function deleteChat() {
    const targetJid = jid;
    setDeleteBusy(true);
    setDeleteError('');
    try {
      const result = await api(`/conversations/${encodeURIComponent(targetJid)}`, { method: 'DELETE' });
      // Invalidate any poll started before deletion so it cannot restore the removed chat.
      refreshGeneration.current += 1;
      selected.current = null;
      roleCache.current.delete(targetJid);
      setLastRoles((roles) => {
        const next = { ...roles };
        delete next[targetJid];
        return next;
      });
      setJid(null);
      setMsgs([]);
      setThreadError('');
      setNewCount(0);
      setDrawer(false);
      setDeleteOpen(false);
      setList((conversations) => conversations.filter((conversation) => conversation.jid !== targetJid));
      setTasks((currentTasks) => currentTasks.filter((task) => task.jid !== targetJid));
      toast(`Chat eliminado · ${result.messages} mensajes, ${result.tasks} tareas`);
      try {
        const [conversations, currentTasks] = await Promise.all([api('/conversations'), api('/tasks?limit=200')]);
        setList(conversations);
        setTasks(currentTasks);
        setError('');
      } catch (e) {
        setError(e.message);
      }
    } catch (e) {
      setDeleteError(e.message);
    } finally {
      setDeleteBusy(false);
    }
  }
  async function cancel(id) {
    try {
      await api(`/tasks/${id}/cancel`, { method: 'POST' });
      toast('Tarea cancelada');
      refresh();
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  function resize(which, e) {
    e.preventDefault();
    const start = e.clientX,
      origin = which === 'list' ? listWidth.current : detailWidth.current;
    const move = (ev) => {
      const v = Math.max(
        which === 'list' ? 250 : 250,
        Math.min(which === 'list' ? 460 : 420, origin + (ev.clientX - start) * (which === 'list' ? 1 : -1)),
      );
      if (which === 'list') listWidth.current = v;
      else detailWidth.current = v;
      setWidths({ list: listWidth.current, detail: detailWidth.current });
    };
    const end = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
  }
  const detail = sel && (
    <>
      <div className="detail-head">
        <strong>Detalle</strong>
        <button
          className="icon-btn"
          aria-label="Cerrar detalle"
          onClick={() => {
            setDrawer(false);
            setDetailVisible(false);
          }}
        >
          <Icon name="close" size={17} />
        </button>
      </div>
      <section className="detail-section">
        <div className="detail-identity">
          <span className="avatar">
            {sel.jid.endsWith('@g.us') ? <Icon name="group" size={18} /> : contactName(sel).slice(0, 2).toUpperCase()}
          </span>
          <div>
            <strong>{contactName(sel)}</strong>
            <small className="mono">{phone(sel.jid)}</small>
          </div>
        </div>
        {sel.jid.endsWith('@g.us') && <Badge>Grupo</Badge>}
      </section>
      <section className="detail-section">
        <h3>Personalidad</h3>
        <Combo
          label="Asignada"
          value={sel.persona_id || ''}
          disabled={!admin}
          onChange={changePersona}
          options={[
            { value: '', label: `Predeterminada (${defaultPersona?.name || 'Kiri'})` },
            ...personas.filter((p) => !p.is_default).map((p) => ({ value: p.id, label: p.name })),
          ]}
        />
        <p className="help">El contacto la nota en su próximo mensaje. No se le escribe ahora.</p>
      </section>
      <section className="detail-section">
        <h3>Tareas</h3>
        {ownTasks.length ? (
          ownTasks.map((t) => (
            <div className="task-item" key={t.id}>
              <header>
                <strong>{t.title}</strong>
                <Badge
                  tone={
                    t.status === 'done'
                      ? 'ok'
                      : t.status === 'failed'
                        ? 'bad'
                        : t.status === 'running'
                          ? 'warn'
                          : 'neutral'
                  }
                >
                  {{ running: 'En curso', done: 'Terminada', failed: 'Fallida', cancelled: 'Cancelada' }[t.status]}
                </Badge>
              </header>
              {t.result && <p>{previewMessage(t.result, 'assistant')}</p>}
              {t.error && <p className="alert">{previewMessage(t.error, 'system')}</p>}
              <FileChips files={t.files} />
              {admin && t.status === 'running' && (
                <InlineConfirm
                  label="Cancelar tarea"
                  confirmLabel="Sí, cancelar"
                  message="¿Cancelar esta tarea?"
                  onConfirm={() => cancel(t.id)}
                />
              )}
            </div>
          ))
        ) : (
          <p className="muted">Sin tareas para este contacto.</p>
        )}
      </section>
      <section className="detail-section">
        <h3>Actividad</h3>
        <div className="detail-stats">
          <div>
            <strong>{sel.total || 0}</strong>
            <small>mensajes</small>
          </div>
          <div>
            <strong>{averageSeconds === null ? '—' : `${averageSeconds.toFixed(1)} s`}</strong>
            <small>respuesta media</small>
          </div>
        </div>
      </section>
      <details className="detail-section contact-memory">
        <summary>
          Memoria de esta conversación
          <span className="tag">{(contactMemory?.content.match(/^- /gm) || []).length} datos</span>
        </summary>
        {memoryLoading ? (
          <p className="muted">Cargando memoria…</p>
        ) : memoryError ? (
          <p className="alert">No se pudo consultar esta memoria.</p>
        ) : contactMemory?.content ? (
          <div className="contact-memory-content">
            <MessageMarkdown text={contactMemory.content} />
          </div>
        ) : (
          <p className="muted">Todavía no hay datos guardados.</p>
        )}
        <Link to={`/memoria?jid=${encodeURIComponent(sel.jid)}`} className="link">
          Editar en Memoria
        </Link>
      </details>
      {admin && (
        <section className="detail-section">
          <h3>Acciones</h3>
          <Button variant="secondary" onClick={pause}>
            {sel.paused ? 'Reanudar agente' : 'Pausar agente'}
          </Button>
          <InlineConfirm
            label="Reiniciar memoria"
            message="El agente olvida esta conversación; el historial que ves acá se conserva."
            confirmLabel="Sí, reiniciar"
            onConfirm={reset}
          />
          <div className="delete-chat-zone">
            {deleteOpen ? (
              <div className="inline-confirm delete-chat-confirm" aria-live="polite">
                <p>
                  Se borra el chat completo: mensajes, tareas, archivos y lo que el agente recuerda de esta persona. No
                  se puede deshacer. No toca el chat de WhatsApp de tu celular.
                </p>
                {deleteError && (
                  <p className="alert" role="alert">
                    {deleteError}
                  </p>
                )}
                <div className="row">
                  <Button
                    variant="ghost"
                    disabled={deleteBusy}
                    onClick={() => {
                      setDeleteOpen(false);
                      setDeleteError('');
                      requestAnimationFrame(() => deleteTriggerRef.current?.focus());
                    }}
                  >
                    Cancelar
                  </Button>
                  <Button ref={deleteConfirmRef} variant="danger-solid" disabled={deleteBusy} onClick={deleteChat}>
                    {deleteBusy ? 'Eliminando…' : 'Eliminar definitivamente'}
                  </Button>
                </div>
              </div>
            ) : (
              <Button ref={deleteTriggerRef} variant="danger" onClick={() => setDeleteOpen(true)}>
                Eliminar chat
              </Button>
            )}
          </div>
        </section>
      )}
    </>
  );
  return (
    <>
      <PageHead title="Conversaciones">
        <Badge tone="ok">{list.length} contactos</Badge>
      </PageHead>
      <div
        className={`inbox ${jid ? 'mobile-thread' : ''} ${detailVisible ? '' : 'detail-hidden'}`}
        style={{ '--list-width': `${widths.list}px`, '--detail-width': `${widths.detail}px` }}
      >
        <section className="inbox-list" aria-label="Bandeja de conversaciones">
          <div className="inbox-list-head">
            <div className="search-field">
              <Icon name="search" size={17} />
              <input
                aria-label="Buscar conversaciones"
                placeholder="Buscar nombre, número o mensaje"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            <div className="filter-row" aria-label="Filtrar conversaciones">
              {[
                ['all', 'Todas'],
                ['running', 'Con tarea'],
                ['paused', 'Pausadas'],
                ['persona:', 'Por defecto'],
                ...personas.filter((p) => !p.is_default).map((p) => [`persona:${p.id}`, p.name]),
              ].map(([v, l]) => (
                <button
                  key={v}
                  className={filter === v ? 'active' : ''}
                  aria-pressed={filter === v}
                  onClick={() => setFilter(v)}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="conv-scroll">
            {loading ? (
              <Skeleton rows={7} />
            ) : error ? (
              <div className="error-block">
                No se pudo cargar la bandeja.{' '}
                <Button variant="secondary" onClick={refresh}>
                  Reintentar
                </Button>
              </div>
            ) : !visible.length ? (
              <Empty title="Sin conversaciones">Probá otra búsqueda o filtro.</Empty>
            ) : (
              visible.map((c) => {
                const active = taskByJid.get(c.jid)?.some((t) => t.status === 'running');
                return (
                  <button
                    className={`conv-row ${jid === c.jid ? 'selected' : ''}`}
                    key={c.jid}
                    onClick={() => {
                      setJid(c.jid);
                      setNewCount(0);
                    }}
                  >
                    <span className="avatar">
                      {c.jid.endsWith('@g.us') ? (
                        <Icon name="group" size={18} />
                      ) : (
                        contactName(c).slice(0, 2).toUpperCase()
                      )}
                    </span>
                    <span className="conv-body">
                      <span className="conv-top">
                        <strong>{contactName(c)}</strong>
                        {c.instanceLabel && <span className="chip">{c.instanceLabel}</span>}
                        <time>{relative(c.last_message_at)}</time>
                      </span>
                      <span className="conv-preview">{conversationPreview(c.last, lastRoles[c.jid])}</span>
                      <span className="conv-indicators">
                        {active && <Badge tone="warn">Tarea en curso</Badge>}
                        {Boolean(c.paused) && <Badge tone="bad">Pausado</Badge>}
                        {Boolean(c.persona_id) && <span className="tag">{personaName(c.persona_id)}</span>}
                        {c.jid.endsWith('@g.us') && <span>Grupo</span>}
                      </span>
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </section>
        <div
          className="resize-handle"
          role="separator"
          aria-label="Cambiar ancho de la lista"
          onPointerDown={(e) => resize('list', e)}
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              listWidth.current = Math.max(250, Math.min(460, listWidth.current + (e.key === 'ArrowRight' ? 16 : -16)));
              setWidths({ list: listWidth.current, detail: detailWidth.current });
            }
          }}
        />
        <section className="thread" aria-label="Hilo de conversación">
          {!sel ? (
            <Empty title="Elegí una conversación">Seleccioná un contacto para leer el historial.</Empty>
          ) : (
            <>
              <header className="thread-head">
                <button
                  className="icon-btn mobile-back"
                  aria-label="Volver a conversaciones"
                  onClick={() => setJid(null)}
                >
                  <Icon name="back" />
                </button>
                <span className="avatar">
                  {sel.jid.endsWith('@g.us') ? (
                    <Icon name="group" size={18} />
                  ) : (
                    contactName(sel).slice(0, 2).toUpperCase()
                  )}
                </span>
                <div>
                  <strong>{contactName(sel)}</strong>
                  <small className="mono">{phone(sel.jid)}</small>
                </div>
                <button
                  className="icon-btn"
                  aria-label="Ver detalle del contacto"
                  onClick={() => {
                    if (window.matchMedia('(min-width: 1200px)').matches) setDetailVisible(true);
                    else setDrawer(true);
                  }}
                >
                  <Icon name="panel" />
                </button>
              </header>
              {threadError && (
                <div className="error-block">
                  No se pudo cargar el hilo.{' '}
                  <Button variant="secondary" onClick={refresh}>
                    Reintentar
                  </Button>
                </div>
              )}
              <div
                className="thread-messages"
                ref={scroll}
                onScroll={(e) => {
                  const el = e.currentTarget;
                  bottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
                  if (bottom.current) setNewCount(0);
                }}
              >
                {msgs.map((m, i) => {
                  const prev = msgs[i - 1],
                    sameDay =
                      prev && parseUTC(prev.created_at)?.toDateString() === parseUTC(m.created_at)?.toDateString();
                  const grouped =
                    prev?.role === m.role &&
                    m.role !== 'system' &&
                    sameDay &&
                    parseUTC(m.created_at) - parseUTC(prev.created_at) < 120000;
                  return (
                    <React.Fragment key={m.id}>
                      {!sameDay && <div className="day-separator">{dayLabel(m.created_at)}</div>}
                      <Message
                        m={m}
                        grouped={grouped}
                        original={m.quoted_id ? messagesById.get(String(m.quoted_id)) : null}
                        contact={contactName(sel)}
                        group={sel.jid.endsWith('@g.us')}
                        onQuoteClick={jumpToMessage}
                        messageRef={(element) => {
                          if (element) messageRefs.current.set(String(m.id), element);
                          else messageRefs.current.delete(String(m.id));
                        }}
                        highlighted={highlightedId === String(m.id)}
                      />
                    </React.Fragment>
                  );
                })}
                {!msgs.length && !threadError && <Empty title="Sin mensajes">Los mensajes van a aparecer acá.</Empty>}
              </div>
              {newCount > 0 && (
                <Button
                  className="new-messages"
                  onClick={() => {
                    scroll.current?.scrollTo({ top: scroll.current.scrollHeight, behavior: 'smooth' });
                    setNewCount(0);
                  }}
                >
                  ↓ {newCount} mensaje{newCount === 1 ? '' : 's'} nuevo{newCount === 1 ? '' : 's'}
                </Button>
              )}
              {running.length > 0 && (
                <div className="working">
                  <Icon name="tasks" size={14} /> El agente está trabajando en {running.length} tarea
                  {running.length === 1 ? '' : 's'}…
                </div>
              )}
              <footer className="thread-status">
                <Badge tone={sel.paused ? 'warn' : 'ok'}>{sel.paused ? 'Agente pausado' : 'Agente activo'}</Badge>
                {admin && (
                  <Button variant="secondary" onClick={pause}>
                    {sel.paused ? 'Reanudar' : 'Pausar'}
                  </Button>
                )}
              </footer>
            </>
          )}
        </section>
        {detailVisible && (
          <>
            <div
              className="resize-handle detail-divider"
              role="separator"
              aria-label="Cambiar ancho del detalle"
              onPointerDown={(e) => resize('detail', e)}
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                  e.preventDefault();
                  detailWidth.current = Math.max(
                    250,
                    Math.min(420, detailWidth.current + (e.key === 'ArrowLeft' ? 16 : -16)),
                  );
                  setWidths({ list: listWidth.current, detail: detailWidth.current });
                }
              }}
            />
            <aside className="contact-detail" aria-label="Detalle del contacto">
              {detail || <Empty title="Sin contacto" />}
            </aside>
          </>
        )}
      </div>
      {drawer && sel && (
        <div className="detail-drawer">
          <Drawer title="Detalle del contacto" onClose={() => setDrawer(false)}>
            {detail}
          </Drawer>
        </div>
      )}
      {toastNode}
    </>
  );
}
