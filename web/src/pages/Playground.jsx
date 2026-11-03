import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import { Badge, Button, Card, Combo, Empty, Icon, PageHead, Segmented, fmtTime } from '../components/ui.jsx';
import { parseMessage } from '../components/message.js';
import MessageMarkdown from '../components/MessageMarkdown.jsx';
const ENG = [{ value: 'claude', label: 'Claude Code' }, { value: 'opencode', label: 'OpenCode' }];
const engName = (e) => (e === 'opencode' ? 'OpenCode' : 'Claude Code');
/** Elige motor y modelo para esta prueba (sin cambiar la configuración de la personalidad). */
function EnginePick({ title, eng, model, onChange, cats, allowDefault }) {
  const list = eng ? cats[eng] || [] : [];
  return (
    <div className="engine-pick">
      <Combo label={title} value={eng} options={[...(allowDefault ? [{ value: '', label: 'El de la personalidad', description: 'Sin cambios' }] : []), ...ENG]} onChange={(v) => onChange({ eng: v, model: '' })} />
      {eng && <Combo label="Modelo" value={model || ''} searchable placeholder="Predeterminado del motor" options={[{ value: '', label: 'Predeterminado del motor' }, ...list]} onChange={(v) => onChange({ eng, model: v })} />}
    </div>
  );
}
/** Mismo mensaje, dos motores/modelos a la vez: respuesta, tiempo y costo lado a lado. */
function CompareView({ cats }) {
  const [a, setA] = useState({ eng: 'claude', model: '' }), [b, setB] = useState({ eng: 'opencode', model: '' }), [text, setText] = useState(''), [rounds, setRounds] = useState([]), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  async function send(e) {
    e.preventDefault();
    const q = text.trim(); if (!q || busy) return;
    setText(''); setBusy(true); setErr('');
    try {
      const lanes = [a, b].map((x) => ({ engine: x.eng, model: x.model || undefined }));
      const r = await api('/playground/compare', { method: 'POST', body: { message: q, lanes } });
      setRounds((x) => [{ q, lanes: r }, ...x]);
    } catch (x) { setErr(x.message); } finally { setBusy(false); }
  }
  return (
    <>
      <Card title="Qué comparar">
        <div className="compare-picks"><EnginePick title="Motor A" eng={a.eng} model={a.model} onChange={setA} cats={cats} /><EnginePick title="Motor B" eng={b.eng} model={b.model} onChange={setB} cats={cats} /></div>
        <p className="help">Cada lado tiene su propia charla de prueba, con la personalidad predeterminada. Las respuestas con herramientas (delegar, paneles…) también se ejecutan de verdad.</p>
        <form className="composer" onSubmit={send}>
          <input aria-label="Mensaje a comparar" value={text} onChange={(e) => setText(e.target.value)} placeholder="Escribí un mensaje para los dos…" />
          <Button icon="send" disabled={busy || !text.trim()}>{busy ? 'Comparando…' : 'Comparar'}</Button>
        </form>
        {err && <p className="alert">{err}</p>}
      </Card>
      {rounds.map((r, i) => (
        <Card key={i} title={`«${r.q.slice(0, 80)}»`}>
          <div className="compare-lanes">
            {r.lanes.map((l) => (
              <div key={l.lane} className="compare-lane">
                <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}><Badge tone={l.error ? 'bad' : 'ok'}>{l.lane}</Badge><strong>{engName(l.engine)}</strong><span className="muted">{l.model || 'predeterminado'}</span></div>
                {l.error ? <p className="alert">{l.error}</p> : <div className="message assistant">{l.reply ? <MessageMarkdown text={l.reply} /> : <span className="muted">Sin texto (delegó o respondió con archivos).</span>}</div>}
                {l.attachments?.length > 0 && <p className="help">Archivos: {l.attachments.join(', ')}</p>}
                <small className="muted">{Math.round((l.ms || 0) / 100) / 10} s{l.cost ? ` · US$ ${Number(l.cost).toFixed(4)}` : l.engine === 'opencode' ? ' · gratis' : ''}</small>
              </div>
            ))}
          </div>
        </Card>
      ))}
    </>
  );
}

export default function Playground({ user }) {
  const [msgs, setMsgs] = useState([]),
    [text, setText] = useState(''),
    [busy, setBusy] = useState(false),
    [running, setRunning] = useState(false),
    [error, setError] = useState(''),
    [pollError, setPollError] = useState('');
  const [mode, setMode] = useState('single'), [pick, setPick] = useState({ eng: '', model: '' }), [cats, setCats] = useState({ claude: [], opencode: [] });
  const box = useRef();
  useEffect(() => {
    api('/models').then((c) => setCats((x) => ({ ...x, claude: c.models || [] }))).catch(() => {});
    api('/models?engine=opencode').then((c) => setCats((x) => ({ ...x, opencode: c.models || [] }))).catch(() => {});
  }, []);
  const jid = `playground:${user.username}`;
  useEffect(() => {
    Promise.all([api(`/conversations/${encodeURIComponent(jid)}`), api(`/tasks?jid=${encodeURIComponent(jid)}`)])
      .then(([m, t]) => {
        setMsgs(m);
        setRunning(t.some((x) => x.status === 'running'));
      })
      .catch(() => {});
  }, [jid]);
  useEffect(() => {
    if (!running) return;
    let alive = true;
    const poll = async () => {
      try {
        const [m, t] = await Promise.all([
          api(`/conversations/${encodeURIComponent(jid)}`),
          api(`/tasks?jid=${encodeURIComponent(jid)}`),
        ]);
        if (alive) {
          setMsgs(m);
          setRunning(t.some((x) => x.status === 'running'));
          setPollError('');
        }
      } catch (e) {
        if (alive) setPollError(e.message);
      }
    };
    poll();
    const id = setInterval(poll, 3000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [running, jid]);
  useEffect(() => {
    box.current?.scrollTo({ top: box.current.scrollHeight });
  }, [msgs, busy]);
  async function send(e) {
    e.preventDefault();
    const value = text.trim();
    if (!value || busy) return;
    setText('');
    setBusy(true);
    setError('');
    setMsgs((m) => [
      ...m,
      { id: `temp-${Date.now()}`, role: 'user', content: value, created_at: new Date().toISOString() },
    ]);
    try {
      const r = await api('/playground', { method: 'POST', body: { message: value, override: pick.eng ? { engine: pick.eng, model: pick.model || undefined } : undefined } });
      const hist = await api(`/conversations/${encodeURIComponent(jid)}`);
      setMsgs(
        hist.length
          ? hist.map((m, i) =>
              i === hist.length - 1 && m.role === 'assistant' ? { ...m, attachments: r.attachments || [] } : m,
            )
          : [
              ...msgs,
              {
                id: `reply-${Date.now()}`,
                role: 'assistant',
                content: r.reply,
                attachments: r.attachments || [],
                created_at: new Date().toISOString(),
              },
            ],
      );
      const tasks = await api(`/tasks?jid=${encodeURIComponent(jid)}`);
      setRunning(tasks.some((t) => t.status === 'running'));
    } catch (x) {
      setError(x.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <PageHead title="Probar agente" />
      <Card title="Motor de esta prueba">
        <Segmented label="Modo" value={mode} onChange={setMode} options={[{ value: 'single', label: 'Una respuesta' }, { value: 'compare', label: 'Comparar dos motores' }]} />
        {mode === 'single' && <EnginePick title="Motor" eng={pick.eng} model={pick.model} onChange={setPick} cats={cats} allowDefault />}
        {mode === 'single' && pick.eng && <p className="help">Solo para esta prueba: no cambia la configuración de la personalidad.</p>}
      </Card>
      {mode === 'compare' && <CompareView cats={cats} />}
      {mode === 'single' && <Card className="chatbox">
        <div className="thread-messages" ref={box}>
          {!msgs.length && <Empty title="Probá una conversación">Escribí un mensaje para empezar.</Empty>}
          {msgs.map((m, i) => {
            const p = parseMessage(m);
            return p.type === 'system' ? (
              <div className="system-event" key={m.id || i}>
                <Icon name="tasks" size={14} />
                {p.text}
              </div>
            ) : (
              <div key={m.id || i} className={`message ${m.role}`}>
                {p.text && <MessageMarkdown text={p.text} />}
                {p.media && (
                  <span className="file-chip">
                    <Icon name="file" size={14} />
                    {p.title}
                  </span>
                )}
                {m.attachments?.length > 0 && (
                  <div className="file-chips">
                    {m.attachments.map((a, k) => (
                      <a className="file-chip" key={k} href={a.path} download={a.fileName}>
                        <Icon name="download" size={14} />
                        {a.fileName}
                      </a>
                    ))}
                  </div>
                )}
                {p.files?.length > 0 && (
                  <div className="file-chips">
                    {p.files.map((f, k) => (
                      <span className="file-chip" key={k}>
                        <Icon name="file" size={14} />
                        {f}
                      </span>
                    ))}
                  </div>
                )}
                <span className="message-meta">{fmtTime(m.created_at)}</span>
              </div>
            );
          })}
          {busy && <div className="working">El agente está respondiendo…</div>}
          {running && <div className="working">Hay una tarea delegada en curso. El resultado va a llegar acá.</div>}
          {pollError && <div className="alert">No se pudo actualizar la tarea: {pollError}</div>}
        </div>
        <form className="composer" onSubmit={send}>
          <input
            aria-label="Mensaje de prueba"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Escribí un mensaje…"
            disabled={user.role !== 'admin'}
          />
          <Button icon="send" disabled={user.role !== 'admin' || busy || !text.trim()}>
            Enviar
          </Button>
        </form>
        {error && (
          <p className="alert" style={{ padding: '0 12px 12px' }}>
            {error}
          </p>
        )}
      </Card>}
    </>
  );
}
