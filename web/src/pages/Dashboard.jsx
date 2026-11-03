import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { Badge, Button, Card, Empty, PageHead, Skeleton, contactName, relative } from '../components/ui.jsx';
import { conversationPreview } from '../components/message.js';

const sections = [
  { key: 'whatsapp', path: '/whatsapp/status' },
  { key: 'stats', path: '/stats' },
  { key: 'conversations', path: '/conversations' },
  { key: 'tasks', path: '/tasks?limit=100' },
];

async function fetchSection(section) {
  if (section.key !== 'conversations') return api(section.path);

  const conversations = (await api(section.path)).slice(0, 6);
  // La lista no trae el emisor del último mensaje; lo leemos antes de interpretar prefijos de medios.
  const threads = await Promise.allSettled(
    conversations.map((conversation) => api(`/conversations/${encodeURIComponent(conversation.jid)}`)),
  );
  return conversations.map((conversation, index) => ({
    ...conversation,
    lastRole: threads[index].status === 'fulfilled' ? threads[index].value.at(-1)?.role : null,
  }));
}

function SectionError({ message, error, onRetry }) {
  return (
    <div className="section-error" role="status">
      <span>{message}</span>
      <Button variant="ghost" onClick={onRetry}>
        Reintentar
      </Button>
      <details>
        <summary>Detalle técnico</summary>
        <code>{error.message}</code>
      </details>
    </div>
  );
}

export default function Dashboard() {
  const [wa, setWa] = useState(null);
  const [stats, setStats] = useState(null);
  const [convs, setConvs] = useState([]);
  const [tasks, setTasks] = useState([]);
  const [errors, setErrors] = useState({});
  const [loading, setLoading] = useState({ whatsapp: true, stats: true, conversations: true, tasks: true });

  const applyResult = useCallback((key, result) => {
    if (result.status === 'rejected') {
      setErrors((current) => ({ ...current, [key]: result.reason }));
    } else {
      const value = result.value;
      if (key === 'whatsapp') setWa(value);
      if (key === 'stats') setStats(value);
      if (key === 'conversations') setConvs(value);
      if (key === 'tasks') setTasks(value.filter((task) => task.status === 'running'));
      setErrors((current) => ({ ...current, [key]: null }));
    }
    setLoading((current) => ({ ...current, [key]: false }));
  }, []);

  const loadAll = useCallback(async () => {
    // Un servicio caído no debe bloquear los demás datos del tablero.
    const results = await Promise.allSettled(sections.map(fetchSection));
    results.forEach((result, index) => applyResult(sections[index].key, result));
  }, [applyResult]);

  const retry = useCallback(
    async (key) => {
      const section = sections.find((item) => item.key === key);
      setLoading((current) => ({ ...current, [key]: true }));
      const [result] = await Promise.allSettled([fetchSection(section)]);
      applyResult(key, result);
    },
    [applyResult],
  );

  useEffect(() => {
    loadAll();
    const timer = setInterval(async () => {
      const keys = ['conversations', 'tasks'];
      const results = await Promise.allSettled(
        keys.map((key) => fetchSection(sections.find((item) => item.key === key))),
      );
      results.forEach((result, index) => applyResult(keys[index], result));
    }, 10000);
    return () => clearInterval(timer);
  }, [applyResult, loadAll]);

  return (
    <>
      <PageHead title="Inicio" />
      <div className="metric-strip">
        {[
          ['Contactos', stats?.contacts],
          ['Mensajes 24 h', stats?.messages24h],
          ['Respuestas', stats?.replies],
          ['Tiempo medio', stats ? `${(stats.avgMs / 1000).toFixed(1)} s` : null],
        ].map(([label, value]) => (
          <div key={label}>
            <small>{label}</small>
            <strong>{value ?? '—'}</strong>
          </div>
        ))}
        {errors.stats && (
          <SectionError
            message="No se pudieron cargar las métricas."
            error={errors.stats}
            onRetry={() => retry('stats')}
          />
        )}
      </div>
      <div className="stack">
        <Card
          title="Línea de WhatsApp"
          action={
            <Link className="link" to="/whatsapp">
              Abrir conexión →
            </Link>
          }
        >
          {errors.whatsapp && (
            <SectionError
              message="No se pudo consultar la línea de WhatsApp."
              error={errors.whatsapp}
              onRetry={() => retry('whatsapp')}
            />
          )}
          {loading.whatsapp && !wa ? (
            <Skeleton rows={2} />
          ) : wa && !errors.whatsapp ? (
            <div className="operation-row">
              <div>
                <Badge tone={wa.state === 'open' ? 'ok' : wa.state === 'connecting' ? 'warn' : 'bad'}>
                  {wa.state === 'open' ? 'Conectada' : wa.state === 'connecting' ? 'Esperando QR' : 'Desconectada'}
                </Badge>
                <span className="muted">{wa.profileName || wa.number || 'Sin número vinculado'}</span>
              </div>
              {wa.state !== 'open' && (
                <Link className="btn btn-secondary" to="/whatsapp">
                  Vincular número
                </Link>
              )}
            </div>
          ) : null}
        </Card>
        <div className="grid-2">
          <Card
            title="Tareas en curso"
            action={
              <Link className="link" to="/tareas">
                Ver todas →
              </Link>
            }
          >
            {errors.tasks && (
              <SectionError
                message="No se pudieron consultar las tareas."
                error={errors.tasks}
                onRetry={() => retry('tasks')}
              />
            )}
            {loading.tasks && !tasks.length ? (
              <Skeleton rows={3} />
            ) : tasks.length ? (
              <div className="task-list">
                {tasks.map((task) => (
                  <div className="task-item" key={task.id}>
                    <strong>{task.title}</strong>
                    <small className="muted">
                      {convs.find((conversation) => conversation.jid === task.jid)?.name || task.jid} ·{' '}
                      {relative(task.created_at)}
                    </small>
                  </div>
                ))}
              </div>
            ) : !errors.tasks ? (
              <Empty title="Sin tareas en curso">El agente no está ejecutando trabajos delegados.</Empty>
            ) : null}
          </Card>
          <Card
            title="Actividad reciente"
            action={
              <Link className="link" to="/conversaciones">
                Abrir bandeja →
              </Link>
            }
          >
            {errors.conversations && (
              <SectionError
                message="No se pudo consultar la actividad."
                error={errors.conversations}
                onRetry={() => retry('conversations')}
              />
            )}
            {loading.conversations && !convs.length ? (
              <Skeleton rows={5} />
            ) : convs.length ? (
              <ul className="list">
                {convs.map((conversation) => (
                  <li key={conversation.jid}>
                    <div>
                      <strong>{contactName(conversation)}</strong>
                      <small>{conversationPreview(conversation.last, conversation.lastRole)}</small>
                    </div>
                    <small>{relative(conversation.last_message_at)}</small>
                  </li>
                ))}
              </ul>
            ) : !errors.conversations ? (
              <Empty title="Sin actividad reciente">Las conversaciones van a aparecer acá.</Empty>
            ) : null}
          </Card>
        </div>
      </div>
    </>
  );
}
