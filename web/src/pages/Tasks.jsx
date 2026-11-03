import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { parseMessage, previewMessage } from '../components/message.js';
import MessageMarkdown from '../components/MessageMarkdown.jsx';
import Attention from './Attention.jsx';
import {
  Badge,
  Button,
  Combo,
  Empty,
  Icon,
  InlineConfirm,
  PageHead,
  Segmented,
  Skeleton,
  contactName,
  parseUTC,
  useToast,
} from '../components/ui.jsx';
const labels = { running: 'En curso', done: 'Terminada', failed: 'Fallida', cancelled: 'Cancelada' };
const scheduleLabels = { active: 'Activa', paused: 'Pausada', done: 'Terminada', cancelled: 'Cancelada' };
const weekdays = [
  { value: '1', label: 'Lunes' },
  { value: '2', label: 'Martes' },
  { value: '3', label: 'Miércoles' },
  { value: '4', label: 'Jueves' },
  { value: '5', label: 'Viernes' },
  { value: '6', label: 'Sábado' },
  { value: '0', label: 'Domingo' },
];
const initialForm = {
  jid: '',
  title: '',
  instructions: '',
  kind: 'once',
  date: '',
  time: '09:00',
  repeat: 'daily',
  weekday: '1',
  cron: '',
};
function shortDate(value) {
  if (!value) return '—';
  const date = typeof value === 'number' ? new Date(value) : parseUTC(value);
  if (!date || Number.isNaN(date.getTime())) return '—';
  const day = new Intl.DateTimeFormat('es-PY', { day: 'numeric', month: 'short' }).format(date).replace(/\.$/, '');
  const time = new Intl.DateTimeFormat('es-PY', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  return `${day}, ${time}`;
}
function taskTone(status) {
  return status === 'done' ? 'ok' : status === 'failed' ? 'bad' : status === 'running' ? 'warn' : 'neutral';
}
function scheduleTone(status) {
  return status === 'active' ? 'ok' : status === 'paused' ? 'warn' : 'neutral';
}
function cronFor(form) {
  const [hour, minute] = form.time.split(':').map(Number);
  if (form.repeat === 'advanced') return form.cron.trim();
  if (form.repeat === 'hourly') return '0 * * * *';
  if (form.repeat === 'weekdays') return `${minute} ${hour} * * 1-5`;
  if (form.repeat === 'weekly') return `${minute} ${hour} * * ${form.weekday}`;
  return `${minute} ${hour} * * *`;
}
function schedulePreview(form) {
  if (form.kind === 'once')
    return form.date ? `Una vez, el ${form.date} a las ${form.time}.` : 'Elegí una fecha y hora.';
  if (form.repeat === 'hourly') return 'Cada hora, en punto.';
  if (form.repeat === 'advanced')
    return form.cron.trim() ? `Cron: ${form.cron.trim()}.` : 'Escribí una expresión cron.';
  if (form.repeat === 'weekdays') return `De lunes a viernes a las ${form.time}.`;
  if (form.repeat === 'weekly') {
    return `Cada ${weekdays.find((day) => day.value === form.weekday)?.label.toLowerCase()} a las ${form.time}.`;
  }
  return `Todos los días a las ${form.time}.`;
}
function TaskResult({ task, expanded, onToggle }) {
  const text = task.result || task.error;
  const parsed = parseMessage({ role: task.result ? 'assistant' : 'system', content: text });
  const files = [
    ...new Set([
      ...(task.files || []).map((file) => (typeof file === 'string' ? file : file.fileName)),
      ...(parsed.files || []),
    ]),
  ].filter(Boolean);
  if (!text && !files.length) return <span className="muted">—</span>;
  return (
    <div className="task-result">
      {text &&
        (expanded ? (
          <div className="task-result-full">
            <MessageMarkdown text={parsed.text} />
          </div>
        ) : (
          <p className="task-result-preview">{previewMessage(text, task.result ? 'assistant' : 'system')}</p>
        ))}
      {expanded && files.length > 0 && (
        <div className="file-chips">
          {files.map((file) => (
            <span className="file-chip" key={file}>
              <Icon name="file" size={14} />
              {file}
            </span>
          ))}
        </div>
      )}
      {!expanded && !text && files.length > 0 && (
        <span className="muted">
          {files.length} archivo{files.length === 1 ? '' : 's'} adjunto{files.length === 1 ? '' : 's'}
        </span>
      )}
      {(text || files.length > 0) && (
        <button
          className="link task-result-toggle"
          type="button"
          aria-label={`${expanded ? 'Ver menos' : 'Ver más'} del resultado de la tarea ${task.id}`}
          aria-expanded={expanded}
          onClick={onToggle}
        >
          {expanded ? 'Ver menos' : 'Ver más'}
        </button>
      )}
    </div>
  );
}
export default function Tasks({ user }) {
  const [tasks, setTasks] = useState([]),
    [convs, setConvs] = useState([]),
    [convsError, setConvsError] = useState(''),
    [filter, setFilter] = useState('all'),
    [view, setView] = useState('delegated'),
    [expandedTasks, setExpandedTasks] = useState({}),
    [selecting, setSelecting] = useState(false),
    [picked, setPicked] = useState({}),
    [cleanAge, setCleanAge] = useState('7'),
    [schedules, setSchedules] = useState([]),
    [scheduleLoading, setScheduleLoading] = useState(false),
    [scheduleError, setScheduleError] = useState(''),
    [timezone, setTimezone] = useState('America/Asuncion'),
    [newOpen, setNewOpen] = useState(false),
    [form, setForm] = useState(initialForm),
    [formError, setFormError] = useState(''),
    [savingSchedule, setSavingSchedule] = useState(false),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [toast, toastNode] = useToast();
  const admin = user.role === 'admin';
  const load = () => {
    Promise.allSettled([api('/tasks?limit=200'), api('/conversations')]).then(([taskResult, convResult]) => {
      if (taskResult.status === 'fulfilled') {
        setTasks(taskResult.value);
        setError('');
      } else setError(taskResult.reason.message);
      if (convResult.status === 'fulfilled') {
        setConvs(convResult.value);
        setConvsError('');
      } else setConvsError(convResult.reason.message);
      setLoading(false);
    });
  };
  function loadSchedules() {
    setScheduleLoading(true);
    api('/schedules')
      .then((items) => {
        setSchedules(items);
        setScheduleError('');
      })
      .catch((cause) => setScheduleError(cause.message))
      .finally(() => setScheduleLoading(false));
  }
  useEffect(() => {
    load();
    const id = setInterval(load, 3000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (view === 'scheduled') loadSchedules();
  }, [view]);
  useEffect(() => {
    api('/persona')
      .then(({ settings }) => setTimezone(settings.timezone || 'America/Asuncion'))
      .catch(() => {});
  }, []);
  async function cancel(id) {
    try {
      await api(`/tasks/${id}/cancel`, { method: 'POST' });
      toast('Tarea cancelada');
      load();
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  async function scheduleAction(id, action) {
    try {
      await api(`/schedules/${id}/${action}`, { method: 'POST' });
      toast(
        { pause: 'Programación pausada', resume: 'Programación reanudada', cancel: 'Programación cancelada' }[action],
      );
      loadSchedules();
    } catch (cause) {
      toast(cause.message, 'err');
    }
  }
  async function deleteSchedule(id) {
    try {
      await api(`/schedules/${id}`, { method: 'DELETE' });
      toast('Programación eliminada');
      loadSchedules();
    } catch (cause) {
      toast(cause.message, 'err');
    }
  }
  async function createSchedule() {
    setFormError('');
    if (!form.jid || !form.title.trim() || !form.instructions.trim()) {
      setFormError('Elegí un contacto y completá el título y las instrucciones.');
      return;
    }
    const body = { jid: form.jid, title: form.title.trim(), instructions: form.instructions.trim() };
    if (form.kind === 'once') body.at = `${form.date} ${form.time}`;
    else body.cron = cronFor(form);
    setSavingSchedule(true);
    try {
      await api('/schedules', { method: 'POST', body });
      toast('Tarea programada creada');
      setForm(initialForm);
      setNewOpen(false);
      loadSchedules();
    } catch (cause) {
      setFormError(cause.message);
    } finally {
      setSavingSchedule(false);
    }
  }
  const shown = filter === 'all' ? tasks : tasks.filter((t) => t.status === filter);
  const byJid = new Map(convs.map((conversation) => [conversation.jid, conversation]));
  const personFor = (jid) => (byJid.has(jid) ? contactName(byJid.get(jid)) : jid);
  const taskDuration = (task) => {
    const start = parseUTC(task.created_at);
    if (!start) return '—';
    const duration = (parseUTC(task.finished_at) || new Date()) - start;
    return `${Math.max(0, Math.round(duration / 60000))} min`;
  };
  const cleanable = shown.filter((t) => t.status !== 'running');
  const pickedIds = cleanable.filter((t) => picked[t.id]).map((t) => t.id);
  const ageDays = Number(cleanAge);
  const cutoff = Date.now() - ageDays * 864e5;
  const oldCount = cleanable.filter((t) => ageDays === 0 || (parseUTC(t.finished_at || t.created_at) || 0) < cutoff).length;
  const ageLabel = ageDays === 0 ? 'todas las terminadas' : `las de más de ${ageDays} día${ageDays === 1 ? '' : 's'}`;
  async function removeTasks(body, okText) {
    try {
      const r = await api('/tasks/delete', { method: 'POST', body });
      toast(`${okText}: ${r.deleted}`);
      setPicked({});
      load();
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  const pick = (id) => setPicked((cur) => ({ ...cur, [id]: !cur[id] }));
  const Check = ({ task }) =>
    task.status === 'running' ? null : (
      <button
        type="button"
        role="checkbox"
        aria-checked={!!picked[task.id]}
        aria-label={`Seleccionar la tarea ${task.id}`}
        className={`task-check${picked[task.id] ? ' on' : ''}`}
        onClick={() => pick(task.id)}
      >
        {picked[task.id] && <Icon name="check" size={14} />}
      </button>
    );
  const toggleResult = (id) => setExpandedTasks((current) => ({ ...current, [id]: !current[id] }));
  return (
    <>
      <PageHead title="Tareas">
        {view === 'delegated' ? (
          <Badge tone="warn">{tasks.filter((task) => task.status === 'running').length} en curso</Badge>
        ) : (
          view === 'scheduled' && admin && (
            <Button icon="plus" onClick={() => setNewOpen((open) => !open)}>
              Nueva programada
            </Button>
          )
        )}
      </PageHead>
      <div className="tasks-toolbar">
        <Segmented
          label="Vista de tareas"
          value={view}
          onChange={setView}
          options={[
            { value: 'delegated', label: 'Delegadas' },
            { value: 'scheduled', label: 'Programadas' },
            { value: 'attention', label: 'Necesita atención' },
          ]}
        />
        {view === 'delegated' && (
          <div className="filter-row">
            {[['all', 'Todas'], ...Object.entries(labels)].map(([value, label]) => (
              <button
                key={value}
                className={filter === value ? 'active' : ''}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        )}
      </div>
      {view === 'delegated' && admin && !loading && tasks.some((t) => t.status !== 'running') && (
        <div className="card task-clean">
          <p className="help">
            Limpiar solo quita las tareas terminadas de esta lista. El chat, la memoria y lo que el agente ya sabe no cambian.
          </p>
          <div className="row task-clean-row">
            <Button variant={selecting ? 'primary' : 'secondary'} icon="check" onClick={() => { setSelecting(!selecting); setPicked({}); }}>
              {selecting ? 'Salir de selección' : 'Seleccionar'}
            </Button>
            <Combo
              label="Limpiar"
              value={cleanAge}
              onChange={setCleanAge}
              options={[
                { value: '0', label: 'Todas las terminadas' },
                { value: '1', label: 'De más de 1 día' },
                { value: '7', label: 'De más de 7 días' },
                { value: '30', label: 'De más de 30 días' },
                { value: '90', label: 'De más de 90 días' },
              ]}
            />
            <InlineConfirm
              label="Limpiar"
              disabled={!oldCount}
              message={`¿Quitar ${ageLabel}${['done', 'failed', 'cancelled'].includes(filter) ? ` (${labels[filter].toLowerCase()}s)` : ''} de la lista?`}
              confirmLabel="Sí, limpiar"
              onConfirm={() => removeTasks({ olderThanDays: ageDays, ...(['done', 'failed', 'cancelled'].includes(filter) ? { status: filter } : {}) }, 'Quitadas de la lista')}
            />
          </div>
          {selecting && (
            <div className="row task-clean-row">
              <span className="muted">{pickedIds.length} seleccionada{pickedIds.length === 1 ? '' : 's'}</span>
              <Button
                variant="ghost"
                onClick={() => setPicked(pickedIds.length === cleanable.length ? {} : Object.fromEntries(cleanable.map((t) => [t.id, true])))}
              >
                {pickedIds.length === cleanable.length ? 'Quitar selección' : 'Seleccionar todas las que se ven'}
              </Button>
              <InlineConfirm
                label="Quitar seleccionadas"
                disabled={!pickedIds.length}
                message={`¿Quitar ${pickedIds.length} de la lista?`}
                confirmLabel="Sí, quitar"
                onConfirm={() => removeTasks({ ids: pickedIds }, 'Quitadas de la lista')}
              />
            </div>
          )}
        </div>
      )}
      {view === 'attention' && <Attention admin={admin} />}
      {view === 'delegated' && error && (
        <div className="error-block">
          No se pudieron cargar las tareas.{' '}
          <Button variant="secondary" onClick={load}>
            Reintentar
          </Button>
        </div>
      )}
      {view === 'delegated' &&
        (loading ? (
          <Skeleton rows={6} />
        ) : !shown.length ? (
          <Empty title="Sin tareas">No hay tareas en este estado.</Empty>
        ) : (
          <>
            <div className="card tasks-table-wrap">
              <table className="data-table tasks-table">
                <colgroup>
                  {selecting && <col className="task-col-check" />}
                  <col className="task-col-title" />
                  <col className="task-col-contact" />
                  <col className="task-col-status" />
                  <col className="task-col-date" />
                  <col className="task-col-result" />
                  <col className="task-col-action" />
                </colgroup>
                <thead>
                  <tr>
                    {selecting && <th aria-label="Seleccionar" />}
                    <th>Tarea</th>
                    <th>Contacto</th>
                    <th>Estado</th>
                    <th>Inicio / duración</th>
                    <th>Resultado</th>
                    <th aria-label="Acciones" />
                  </tr>
                </thead>
                <tbody>
                  {shown.map((task) => (
                    <tr key={task.id}>
                      {selecting && <td><Check task={task} /></td>}
                      <td>
                        <strong className="task-title">
                          #{task.id} {task.title}
                        </strong>
                      </td>
                      <td>
                        <span className="task-contact">
                          <span className="avatar small">{personFor(task.jid).slice(0, 2).toUpperCase()}</span>
                          <span>{personFor(task.jid)}{byJid.get(task.jid)?.instanceLabel && <span className="chip">{byJid.get(task.jid).instanceLabel}</span>}</span>
                        </span>
                      </td>
                      <td>
                        <Badge tone={taskTone(task.status)}>{labels[task.status]}</Badge>
                      </td>
                      <td>
                        <span className="task-date">{shortDate(task.created_at)}</span>
                        <small className="muted task-duration">{taskDuration(task)}</small>
                      </td>
                      <td>
                        <TaskResult
                          task={task}
                          expanded={!!expandedTasks[task.id]}
                          onToggle={() => toggleResult(task.id)}
                        />
                      </td>
                      <td>
                        {admin && task.status === 'running' && (
                          <InlineConfirm
                            label="Cancelar"
                            message="¿Cancelar la tarea?"
                            confirmLabel="Sí"
                            onConfirm={() => cancel(task.id)}
                          />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="tasks-mobile-list">
              {shown.map((task) => (
                <article className="card task-mobile-card" key={task.id}>
                  <div className="task-mobile-head">
                    {selecting && <Check task={task} />}
                    <strong>
                      #{task.id} {task.title}
                    </strong>
                    <Badge tone={taskTone(task.status)}>{labels[task.status]}</Badge>
                  </div>
                  <div className="task-mobile-meta">
                    <span className="task-contact">
                      <span className="avatar small">{personFor(task.jid).slice(0, 2).toUpperCase()}</span>
                      <span>{personFor(task.jid)}{byJid.get(task.jid)?.instanceLabel && <span className="chip">{byJid.get(task.jid).instanceLabel}</span>}</span>
                    </span>
                    <span className="task-date">
                      {shortDate(task.created_at)} · {taskDuration(task)}
                    </span>
                  </div>
                  <TaskResult task={task} expanded={!!expandedTasks[task.id]} onToggle={() => toggleResult(task.id)} />
                  {admin && task.status === 'running' && (
                    <InlineConfirm
                      label="Cancelar"
                      message="¿Cancelar la tarea?"
                      confirmLabel="Sí"
                      onConfirm={() => cancel(task.id)}
                    />
                  )}
                </article>
              ))}
            </div>
          </>
        ))}
      {view === 'scheduled' && (
        <div className="scheduled-layout">
          {newOpen && admin && (
            <div className="card schedule-form">
              <div className="schedule-form-head">
                <div>
                  <h2>Nueva programada</h2>
                  <p className="help">El agente escribirá al contacto a la hora indicada.</p>
                </div>
                <button
                  className="icon-btn"
                  type="button"
                  aria-label="Cerrar formulario"
                  onClick={() => setNewOpen(false)}
                >
                  <Icon name="close" size={18} />
                </button>
              </div>
              <div className="schedule-form-grid">
                <Combo
                  label="Contacto"
                  value={form.jid}
                  onChange={(jid) => setForm({ ...form, jid })}
                  searchable
                  options={convs.map((contact) => ({ value: contact.jid, label: contactName(contact) }))}
                />
                {convsError && (
                  <p className="alert schedule-form-wide" role="alert">
                    No se pudieron cargar los contactos.{' '}
                    <button className="link" onClick={load}>
                      Reintentar
                    </button>
                  </p>
                )}
                <label>
                  Título
                  <input
                    maxLength={80}
                    value={form.title}
                    onChange={(event) => setForm({ ...form, title: event.target.value })}
                    placeholder="Ej. Recordar la reunión"
                  />
                </label>
                <label className="schedule-form-wide">
                  Qué decirle o hacer
                  <textarea
                    value={form.instructions}
                    onChange={(event) => setForm({ ...form, instructions: event.target.value })}
                    rows={4}
                    maxLength={2000}
                    placeholder="Contale qué quedó acordado y qué debe hacer el agente."
                  />
                </label>
              </div>
              <Segmented
                label="Frecuencia"
                value={form.kind}
                onChange={(kind) => setForm({ ...form, kind })}
                options={[
                  { value: 'once', label: 'Una vez' },
                  { value: 'cron', label: 'Repetir' },
                ]}
              />
              {form.kind === 'once' ? (
                <div className="schedule-time-fields">
                  <label>
                    Fecha
                    <input
                      type="date"
                      value={form.date}
                      onChange={(event) => setForm({ ...form, date: event.target.value })}
                    />
                  </label>
                  <label>
                    Hora
                    <input
                      type="time"
                      value={form.time}
                      onChange={(event) => setForm({ ...form, time: event.target.value })}
                    />
                  </label>
                </div>
              ) : (
                <div className="schedule-repeat-fields">
                  <Combo
                    label="Repetir"
                    value={form.repeat}
                    onChange={(repeat) => setForm({ ...form, repeat })}
                    options={[
                      { value: 'daily', label: 'Todos los días' },
                      { value: 'weekdays', label: 'Lunes a viernes' },
                      { value: 'weekly', label: 'Cada semana' },
                      { value: 'hourly', label: 'Cada hora' },
                      { value: 'advanced', label: 'Avanzado: cron' },
                    ]}
                  />
                  {form.repeat === 'weekly' && (
                    <Combo
                      label="Día"
                      value={form.weekday}
                      onChange={(weekday) => setForm({ ...form, weekday })}
                      options={weekdays}
                    />
                  )}
                  {!['hourly', 'advanced'].includes(form.repeat) && (
                    <label>
                      Hora
                      <input
                        type="time"
                        value={form.time}
                        onChange={(event) => setForm({ ...form, time: event.target.value })}
                      />
                    </label>
                  )}
                  {form.repeat === 'advanced' && (
                    <label className="schedule-form-wide">
                      Expresión cron
                      <input
                        className="mono"
                        value={form.cron}
                        onChange={(event) => setForm({ ...form, cron: event.target.value })}
                        placeholder="0 9 * * 1-5"
                      />
                      <small className="help">
                        Cinco campos: minuto, hora, día, mes y día de la semana. Mínimo cada 15 min.
                      </small>
                    </label>
                  )}
                </div>
              )}
              <p className="schedule-preview" aria-live="polite">
                {schedulePreview(form)} Hora local del agente ({timezone}).
              </p>
              {formError && (
                <p className="alert" role="alert">
                  {formError}
                </p>
              )}
              <div className="row end">
                <Button variant="ghost" onClick={() => setNewOpen(false)}>
                  Cancelar
                </Button>
                <Button disabled={savingSchedule} onClick={createSchedule}>
                  {savingSchedule ? 'Guardando…' : 'Crear programada'}
                </Button>
              </div>
            </div>
          )}
          {scheduleError && (
            <div className="error-block">
              No se pudieron cargar las programadas.{' '}
              <Button variant="secondary" onClick={loadSchedules}>
                Reintentar
              </Button>
            </div>
          )}
          {scheduleLoading ? (
            <Skeleton rows={4} />
          ) : !scheduleError && !schedules.length ? (
            <Empty title="Sin tareas programadas">
              Los recordatorios y tareas repetidas aparecerán acá cuando el agente o vos los creen.
            </Empty>
          ) : (
            <div className="scheduled-list">
              {schedules.map((item) => (
                <article className="card scheduled-card" key={item.id}>
                  <div className="scheduled-card-head">
                    <div>
                      <h2>
                        #{item.id} {item.title}
                      </h2>
                      <p className="help">{personFor(item.jid)}</p>
                    </div>
                    <Badge tone={scheduleTone(item.status)}>{scheduleLabels[item.status]}</Badge>
                  </div>
                  <p className="scheduled-when">
                    <Icon name="clock" size={17} /> {item.description}
                  </p>
                  <div className="scheduled-meta">
                    <span>{item.kind === 'cron' ? 'Repetida' : 'Una vez'}</span>
                    <span>Creada por {item.created_by === 'agente' ? 'el agente' : 'el panel'}</span>
                    <span>
                      Última ejecución: {shortDate(item.last_run)} · {item.runs || 0} veces
                    </span>
                  </div>
                  {item.last_error && (
                    <p className="scheduled-error" role="status">
                      Último error: {item.last_error}
                    </p>
                  )}
                  {admin && (
                    <div className="scheduled-actions">
                      {item.status === 'active' && (
                        <Button variant="secondary" onClick={() => scheduleAction(item.id, 'pause')}>
                          Pausar
                        </Button>
                      )}
                      {item.status === 'paused' && (
                        <Button variant="secondary" onClick={() => scheduleAction(item.id, 'resume')}>
                          Reanudar
                        </Button>
                      )}
                      {['active', 'paused'].includes(item.status) && (
                        <InlineConfirm
                          label="Cancelar"
                          message="Esta programación dejará de ejecutarse. ¿Cancelarla?"
                          onConfirm={() => scheduleAction(item.id, 'cancel')}
                        />
                      )}
                      <InlineConfirm
                        label="Eliminar"
                        message="Se eliminará esta programación de la lista. ¿Continuar?"
                        onConfirm={() => deleteSchedule(item.id)}
                      />
                    </div>
                  )}
                </article>
              ))}
            </div>
          )}
        </div>
      )}
      {toastNode}
    </>
  );
}
