import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Badge, Button, Card, Combo, Icon, InlineConfirm, PageHead, Segmented, Skeleton, Switch, useToast } from '../components/ui.jsx';

const when = (ms) => new Date(ms).toLocaleString('es', { weekday: 'short', hour: '2-digit', minute: '2-digit' });

// ---------- versión de OpenCode y prueba de los motores ----------
function Mantenimiento({ admin, toast }) {
  const [v, setV] = useState(null), [busy, setBusy] = useState(''), [h, setH] = useState(null), [err, setErr] = useState('');
  const load = useCallback(() => api('/engines/opencode/version').then(setV).catch(() => {}), []);
  useEffect(() => { load(); }, [load]);
  async function update() { setBusy('update'); setErr(''); try { const r = await api('/engines/opencode/update', { method: 'POST', body: {} }); toast(`OpenCode actualizado: ${r.before} → ${r.after}`); load(); } catch (e) { setErr(e.message); } finally { setBusy(''); } }
  async function revert() { setBusy('revert'); try { await api('/engines/opencode/revert', { method: 'POST' }); toast('Volvió a la versión incluida'); load(); } finally { setBusy(''); } }
  async function health() { setBusy('health'); setErr(''); try { setH(await api('/engines/health', { method: 'POST' })); } catch (e) { setErr(e.message); } finally { setBusy(''); } }
  const res = (name, r) => r && <p key={name} className={r.ok ? 'help' : 'alert'} role="status">{r.ok ? '✔' : '✖'} {name}: {r.ok ? `responde (${Math.round(r.ms / 100) / 10} s)` : r.error}</p>;
  return (
    <Card title="Mantenimiento">
      {v && (
        <div className="engine-row">
          <strong>OpenCode</strong>
          <span className="muted">{v.version ? `versión ${v.version}${v.updated ? ' (actualizada desde el panel)' : ''}` : 'no instalado'}</span>
          {v.canUpdate && <Badge tone="warn">Disponible {v.latest}</Badge>}
          {admin && v.canUpdate && <Button variant="secondary" icon="refresh" disabled={!!busy} onClick={update}>{busy === 'update' ? 'Actualizando… (puede tardar un minuto)' : `Actualizar a ${v.latest}`}</Button>}
          {admin && v.updated && <InlineConfirm label="Volver a la versión incluida" variant="secondary" message="Usa de nuevo la versión que trae el servidor." confirmLabel="Sí, volver" onConfirm={revert} />}
          {!v.canUpdate && v.version && <Badge tone="ok">Al día</Badge>}
        </div>
      )}
      <p className="help">Al actualizar, la versión nueva se prueba con un pedido real; si falla, el panel vuelve solo a la anterior.</p>
      {admin && <div className="row"><Button variant="secondary" disabled={!!busy} onClick={health}>{busy === 'health' ? 'Probando…' : 'Probar los dos motores'}</Button></div>}
      {h && <>{res('Claude Code', h.claude)}{res('OpenCode', h.opencode)}</>}
      {err && <div className="error-block">{err}</div>}
    </Card>
  );
}

// ---------- consumo ----------
const num = (n) => Number(n || 0).toLocaleString('es-PY');
function Consumo() {
  const [days, setDays] = useState('30'), [d, setD] = useState(null);
  useEffect(() => { setD(null); api(`/usage?days=${days}`).then(setD).catch(() => setD({ rows: [], events: [], perDay: [] })); }, [days]);
  const label = { claude: 'Claude Code', opencode: 'OpenCode' }, evLabel = { pausa: 'Llegó al límite', acceso: 'Problema de acceso', cambio: 'Cambio de motor', reanuda: 'Volvió a estar disponible' };
  const tot = (d?.rows || []).reduce((a, r) => ({ turnos: a.turnos + r.turnos, tokens: a.tokens + r.tokens, cost: a.cost + r.cost }), { turnos: 0, tokens: 0, cost: 0 });
  return (
    <Card title="Consumo por motor y modelo">
      <Segmented label="Período" value={days} onChange={setDays} options={[{ value: '7', label: '7 días' }, { value: '30', label: '30 días' }, { value: '90', label: '90 días' }]} />
      {!d ? <Skeleton rows={3} /> : !d.rows.length ? <p className="muted">Todavía no hay uso registrado en este período.</p> : (
        <>
          <p className="help">En total: {num(tot.turnos)} respuestas · {num(tot.tokens)} tokens procesados · {tot.cost ? `US$ ${tot.cost.toFixed(2)}` : 'sin costo registrado'}.</p>
          <div className="panel-table-wrap">
            <table className="data-table">
              <thead><tr><th>Motor</th><th>Modelo</th><th className="num">Charla</th><th className="num">Tareas</th><th className="num">Como respaldo</th><th className="num">Tokens</th><th className="num">Costo</th><th className="num">Tiempo medio</th></tr></thead>
              <tbody>{d.rows.map((r, i) => (
                <tr key={i}><td>{label[r.engine] || r.engine}</td><td>{r.model || '—'}</td><td className="num">{num(r.chats)}</td><td className="num">{num(r.tareas)}</td><td className="num">{num(r.respaldo)}</td><td className="num">{num(r.tokens)}</td><td className="num">{r.cost ? `US$ ${r.cost.toFixed(2)}` : r.engine === 'opencode' ? 'Gratis' : '—'}</td><td className="num">{r.ms ? `${Math.round(r.ms / 100) / 10} s` : '—'}</td></tr>
              ))}</tbody>
            </table>
          </div>
        </>
      )}
      {d?.events?.length > 0 && (
        <>
          <h3 style={{ margin: '12px 0 0', fontSize: 15 }}>Pausas y cambios recientes</h3>
          <ul className="list">{d.events.map((e, i) => <li key={i}><div><strong>{evLabel[e.kind] || e.kind} · {label[e.engine] || e.engine}</strong><small>{new Date(`${e.at.replace(' ', 'T')}Z`).toLocaleString('es')}{e.detail ? ` · ${e.detail}` : ''}</small></div></li>)}</ul>
        </>
      )}
    </Card>
  );
}

// ---------- estado y cambio automático ----------
function Estado({ admin, toast }) {
  const [st, setSt] = useState(null);
  const load = useCallback(() => api('/engines').then(setSt).catch(() => {}), []);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  if (!st) return <Card title="Estado de los motores"><Skeleton rows={3} /></Card>;
  const row = (key, name, info) => (
    <div className="engine-row" key={key}>
      <strong>{name}</strong>
      {st[key].paused ? <Badge tone="warn">En pausa hasta {when(st[key].paused.until)}</Badge> : <Badge tone="ok">Disponible</Badge>}
      <span className="muted">{info}</span>
      {st[key].paused && admin && <Button variant="secondary" icon="refresh" onClick={async () => { await api(`/engines/${key}/resume`, { method: 'POST' }); toast('Pausa quitada'); load(); }}>Reintentar ahora</Button>}
      {st[key].paused && <small className="help engine-reason">{st[key].paused.kind === 'auth' ? 'Problema de acceso: ' : 'Límite de uso: '}{String(st[key].paused.reason).slice(0, 140)}</small>}
    </div>
  );
  return (
    <Card title="Estado de los motores">
      <p className="help">Cada personalidad elige su motor en Personalidades → Configuración. Si activa el cambio automático, cuando uno llega a su límite el mismo mensaje sigue con el otro, y vuelve solo cuando el cupo se renueva.</p>
      {row('claude', 'Claude Code', 'Modelos de Anthropic')}
      {row('opencode', 'OpenCode', st.opencode.installed ? `${st.opencode.models} modelos disponibles · ${st.opencode.free} gratuitos` : 'No está instalado en este servidor')}
      <Switch title="Avisarme por WhatsApp cuando se cambie de motor" desc="Usa los números de «Necesita atención» (Tareas)" checked={st.settings.notifySwitch} disabled={!admin} onChange={async (v) => { setSt({ ...st, settings: await api('/engines/settings', { method: 'PUT', body: { notifySwitch: v } }) }); }} />
    </Card>
  );
}

// ---------- Claude Code ----------
function Claude({ admin, toast }) {
  const [s, setS] = useState(null), [mode, setMode] = useState('claudeai'), [login, setLogin] = useState(null), [code, setCode] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  const load = useCallback(() => api('/engines/claude/auth').then(setS).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  async function start() {
    setBusy(true); setErr('');
    try { setLogin(await api('/engines/claude/login', { method: 'POST', body: { mode } })); setCode(''); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function send() {
    setBusy(true); setErr('');
    try { const r = await api('/engines/claude/login/code', { method: 'POST', body: { id: login.id, code } }); setS(r.status); setLogin(null); toast('Sesión iniciada'); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  if (!s) return <Card title="Claude Code · Cuenta"><Skeleton rows={3} /></Card>;
  return (
    <Card title="Claude Code · Cuenta">
      {s.loggedIn ? (
        <>
          <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <Badge tone="ok">Sesión iniciada</Badge>
            <strong>{s.email || s.org || 'Cuenta de Anthropic'}</strong>
            {s.plan && <span className="chip">Plan {s.plan}</span>}
            <span className="muted">{s.method === 'claude.ai' ? 'Suscripción de Claude' : s.method === 'console' ? 'Consola (API)' : s.method}</span>
          </div>
          <p className="help">La sesión queda guardada en el servidor: no hace falta volver a iniciarla ni al reiniciar o actualizar.</p>
          {s.tokenInEnv && <Switch title="Usar esta sesión en lugar de la clave del servidor" desc="El servidor también tiene una clave de acceso en su configuración; así se elige cuál se usa." checked={s.usePanelLogin} disabled={!admin} onChange={async (v) => setS(await api('/engines/claude/use-login', { method: 'PUT', body: { on: v } }))} />}
          {admin && <div className="row"><InlineConfirm label="Cerrar sesión" message="Claude Code deja de usar esta cuenta." confirmLabel="Sí, cerrar" onConfirm={async () => { setS(await api('/engines/claude/logout', { method: 'POST' })); toast('Sesión cerrada'); }} /></div>}
        </>
      ) : (
        <>
          <div className="row" style={{ gap: 10, alignItems: 'center' }}><Badge tone="warn">Sin sesión del panel</Badge>{s.tokenInEnv && <span className="muted">Hoy el servidor usa la clave de acceso de su configuración.</span>}</div>
          {!login && admin && (
            <>
              <Segmented label="Tipo de cuenta" value={mode} onChange={setMode} options={[{ value: 'claudeai', label: 'Suscripción de Claude' }, { value: 'console', label: 'Consola de Anthropic (API)' }]} />
              <p className="help">{mode === 'claudeai' ? 'Usa tu plan de Claude (Pro, Max…).' : 'Se factura por uso en tu cuenta de la Consola de Anthropic.'} Vas a abrir un enlace de Anthropic, autorizar y copiar el código que te muestran.</p>
              <div className="row"><Button icon="key" disabled={busy} onClick={start}>Iniciar sesión</Button></div>
            </>
          )}
          {login && (
            <div className="stack engine-steps">
              <p><strong>1.</strong> Abrí el enlace, iniciá sesión en Anthropic y autorizá el acceso (vale unos minutos).</p>
              <div className="row"><a className="btn btn-primary" href={login.url} target="_blank" rel="noreferrer"><span>Abrir enlace de Anthropic</span></a><Button variant="ghost" onClick={() => navigator.clipboard?.writeText(login.url).then(() => toast('Enlace copiado'))}>Copiar enlace</Button></div>
              <p><strong>2.</strong> Copiá el código que te muestra Anthropic y pegalo acá.</p>
              <div className="row"><input style={{ flex: 1, minWidth: 220 }} value={code} onChange={(e) => setCode(e.target.value)} placeholder="Pegá el código completo" autoComplete="off" spellCheck={false} onKeyDown={(e) => e.key === 'Enter' && code.trim() && send()} /><Button disabled={busy || code.trim().length < 10} onClick={send}>Confirmar</Button><Button variant="ghost" onClick={() => { setLogin(null); setErr(''); }}>Cancelar</Button></div>
            </div>
          )}
        </>
      )}
      {err && <div className="error-block">{err}</div>}
    </Card>
  );
}

// ---------- OpenCode ----------
function Modelos({ provider, toast, onDone }) {
  const [models, setModels] = useState(null), [sel, setSel] = useState(null), [q, setQ] = useState('');
  useEffect(() => { api(`/engines/opencode/providers/${encodeURIComponent(provider.id)}/models`).then((m) => { setModels(m); setSel(new Set(provider.whitelist || m.map((x) => x.id))); }).catch(() => setModels([])); }, [provider.id]);
  if (!models) return <Skeleton rows={2} />;
  const shown = models.filter((m) => `${m.id} ${m.label}`.toLowerCase().includes(q.toLowerCase())).slice(0, 80);
  const save = async (all) => { await api(`/engines/opencode/providers/${encodeURIComponent(provider.id)}/whitelist`, { method: 'PUT', body: { models: all ? null : [...sel] } }); toast('Modelos guardados'); onDone(); };
  return (
    <div className="stack">
      <p className="help">Elegí qué modelos de este proveedor se ofrecen en las personalidades. {models.length} disponibles.</p>
      <label className="panel-search"><Icon name="search" size={15} /><input type="search" placeholder="Buscar modelo…" value={q} onChange={(e) => setQ(e.target.value)} /></label>
      <div className="provider-models">{shown.map((m) => <Switch key={m.id} title={m.label} desc={m.description} checked={sel.has(m.id)} onChange={(v) => setSel((x) => { const n = new Set(x); v ? n.add(m.id) : n.delete(m.id); return n; })} />)}</div>
      <div className="row"><Button icon="save" disabled={!sel.size} onClick={() => save(false)}>Guardar selección</Button><Button variant="secondary" onClick={() => save(true)}>Mostrar todos</Button></div>
    </div>
  );
}
function OpenCode({ admin, toast }) {
  const [d, setD] = useState(null), [pick, setPick] = useState(''), [key, setKey] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState(''), [tests, setTests] = useState({}), [open, setOpen] = useState(null);
  const [custom, setCustom] = useState({ id: '', name: '', baseURL: '', apiKey: '', models: '' }), [showCustom, setShowCustom] = useState(false);
  const load = useCallback(() => api('/engines/opencode/providers').then(setD).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const opts = useMemo(() => (d?.catalog || []).filter((p) => !d.connected.some((c) => c.id === p.id)).map((p) => ({ value: p.id, label: p.name, description: `${p.models} modelos · ${p.env[0] || ''}` })), [d]);
  async function connect() {
    setBusy(true); setErr('');
    try { await api('/engines/opencode/providers', { method: 'POST', body: { id: pick, key } }); setPick(''); setKey(''); toast('Proveedor conectado'); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function addCustom() {
    setBusy(true); setErr('');
    try { await api('/engines/opencode/custom', { method: 'POST', body: custom }); setCustom({ id: '', name: '', baseURL: '', apiKey: '', models: '' }); setShowCustom(false); toast('Proveedor agregado'); await load(); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  async function test(id) { setTests((t) => ({ ...t, [id]: { loading: true } })); const r = await api(`/engines/opencode/providers/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} }).catch((e) => ({ ok: false, error: e.message })); setTests((t) => ({ ...t, [id]: r })); }
  if (!d) return <Card title="OpenCode · Proveedores y modelos"><Skeleton rows={4} /></Card>;
  const sel = d.catalog.find((p) => p.id === pick);
  return (
    <Card title="OpenCode · Proveedores y modelos">
      <p className="help">Los modelos <strong>gratuitos</strong> de OpenCode funcionan sin cuenta ni clave. Si querés usar otros (OpenAI, Anthropic por API, Google, OpenRouter, Groq, DeepSeek…), conectá el proveedor con su clave: los modelos aparecen solos en el selector de cada personalidad.</p>
      {d.connected.length === 0 && <p className="muted">Todavía no conectaste ningún proveedor propio.</p>}
      {d.connected.map((c) => (
        <div key={c.id} className="provider-row">
          <div className="row provider-head">
            <strong>{c.name}</strong><span className="chip">{c.kind}</span><span className="muted">{c.models} modelo{c.models === 1 ? '' : 's'}{c.whitelist ? ` (de ${c.whitelist.length} elegidos)` : ''}</span>
            {admin && (
              <div className="row" style={{ marginLeft: 'auto' }}>
                <Button variant="secondary" onClick={() => test(c.id)}>Probar</Button>
                <Button variant="secondary" onClick={() => setOpen(open === c.id ? null : c.id)}>Modelos</Button>
                <InlineConfirm label="Quitar" message="Se borra la clave de este proveedor." confirmLabel="Sí, quitar" onConfirm={async () => { await api(`/engines/opencode/providers/${encodeURIComponent(c.id)}`, { method: 'DELETE' }); toast('Proveedor quitado'); load(); }} />
              </div>
            )}
          </div>
          {c.baseURL && <small className="help mono">{c.baseURL}</small>}
          {tests[c.id] && <p className={tests[c.id].loading || tests[c.id].ok ? 'help' : 'alert'} role="status">{tests[c.id].loading ? 'Probando…' : tests[c.id].ok ? `✔ Funciona (${tests[c.id].model}, ${Math.round(tests[c.id].ms / 100) / 10} s)` : `✖ ${tests[c.id].error}`}</p>}
          {open === c.id && <Modelos provider={c} toast={toast} onDone={() => { setOpen(null); load(); }} />}
        </div>
      ))}
      {admin && (
        <div className="stack">
          <h3 style={{ margin: '12px 0 0', fontSize: 15 }}>Conectar un proveedor</h3>
          <div className="row panel-addrow">
            <div style={{ minWidth: 240, flex: 1 }}><Combo label="Proveedor" value={pick} onChange={setPick} searchable options={opts} placeholder="Buscá: OpenAI, Groq, OpenRouter…" /></div>
            <label style={{ flex: 1, minWidth: 220 }}>Clave (API key)<input type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder={sel?.env[0] || 'sk-…'} /></label>
            <Button disabled={busy || !pick || key.trim().length < 8} onClick={connect}>Conectar</Button>
          </div>
          {sel?.doc && <small className="help">Dónde conseguir la clave: <a href={sel.doc} target="_blank" rel="noreferrer">{sel.doc}</a></small>}
          <div className="row"><Button variant="ghost" onClick={() => setShowCustom((v) => !v)}>{showCustom ? 'Ocultar' : 'Proveedor propio (compatible con OpenAI)…'}</Button></div>
          {showCustom && (
            <div className="stack">
              <p className="help">Para un servidor propio o local (LM Studio, Ollama, vLLM…) o cualquier servicio con API compatible con OpenAI.</p>
              <div className="row panel-addrow">
                <label>Nombre<input value={custom.name} onChange={(e) => setCustom({ ...custom, name: e.target.value })} placeholder="Mi servidor" /></label>
                <label>Identificador<input value={custom.id} onChange={(e) => setCustom({ ...custom, id: e.target.value.toLowerCase().replace(/[^a-z0-9._-]/g, '') })} placeholder="mi-servidor" /></label>
              </div>
              <label>Dirección (URL base)<input value={custom.baseURL} onChange={(e) => setCustom({ ...custom, baseURL: e.target.value })} placeholder="http://127.0.0.1:1234/v1" /></label>
              <label>Clave (opcional)<input type="password" autoComplete="new-password" value={custom.apiKey} onChange={(e) => setCustom({ ...custom, apiKey: e.target.value })} /></label>
              <label>Modelos (uno por línea o separados por coma)<textarea rows={3} value={custom.models} onChange={(e) => setCustom({ ...custom, models: e.target.value })} placeholder={'qwen2.5-7b\nllama-3.2-3b'} /></label>
              <div className="row"><Button disabled={busy || !custom.id || !custom.baseURL || !custom.models.trim()} onClick={addCustom}>Agregar proveedor</Button></div>
            </div>
          )}
        </div>
      )}
      {err && <div className="error-block">{err}</div>}
    </Card>
  );
}

// ---------- transcripción de audios (Groq) ----------
function Audio({ admin, toast }) {
  const [s, setS] = useState(null), [key, setKey] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState(''), [t, setT] = useState(null);
  const load = useCallback(() => api('/engines/transcription').then(setS).catch((e) => setErr(e.message)), []);
  useEffect(() => { load(); }, [load]);
  async function save() { setBusy(true); setErr(''); try { setS(await api('/engines/transcription', { method: 'PUT', body: { key } })); setKey(''); setT(null); toast('Clave de Groq guardada'); } catch (e) { setErr(e.message); } finally { setBusy(false); } }
  async function test(candidate) { setT({ loading: true }); setT(await api('/engines/transcription/test', { method: 'POST', body: { key: candidate || '' } }).catch((e) => ({ ok: false, error: e.message }))); }
  if (!s) return <Card title="Audios · Transcripción (Groq)"><Skeleton rows={2} /></Card>;
  return (
    <Card title="Audios · Transcripción (Groq)">
      <p className="help">Las notas de voz y el audio de los videos se pasan a texto con Whisper en Groq, para que el agente entienda lo que le mandan. Sin clave, el agente le pide a la persona que lo escriba.</p>
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {s.configured ? <Badge tone="ok">Clave cargada</Badge> : <Badge tone="warn">Sin clave</Badge>}
        {s.configured && <span className="muted">{s.hint} · {s.source === 'panel' ? 'cargada desde el panel' : 'viene de la configuración del servidor'}</span>}
        {admin && s.configured && <Button variant="secondary" onClick={() => test('')}>Probar</Button>}
        {admin && s.source === 'panel' && <InlineConfirm label="Quitar" message={s.serverKeyAlso ? 'Se borra la clave del panel y se usa la del servidor.' : 'Se borra la clave: el agente dejará de entender audios.'} confirmLabel="Sí, quitar" onConfirm={async () => { setS(await api('/engines/transcription', { method: 'DELETE' })); setT(null); toast('Clave quitada'); }} />}
      </div>
      {t && <p className={t.loading || t.ok ? 'help' : 'alert'} role="status">{t.loading ? 'Probando…' : t.ok ? `✔ Groq responde (${t.ms < 1000 ? `${t.ms} ms` : `${Math.round(t.ms / 100) / 10} s`})${t.whisper ? '' : ' · pero no lista modelos Whisper para esta clave'}` : `✖ ${t.error}`}</p>}
      {s.source === 'servidor' && <p className="help">Hoy se usa la clave de la configuración del servidor. Si cargás una acá, esta pasa a usarse en su lugar.</p>}
      {admin && (
        <div className="row panel-addrow">
          <label style={{ flex: 1, minWidth: 240 }}>{s.configured ? 'Reemplazar la clave' : 'Clave de Groq (API key)'}<input type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="gsk_…" /></label>
          <Button variant="secondary" disabled={busy || key.trim().length < 20} onClick={() => test(key)}>Probar antes de guardar</Button>
          <Button disabled={busy || key.trim().length < 20} onClick={save}>Guardar</Button>
        </div>
      )}
      <small className="help">La clave se consigue gratis en <a href="https://console.groq.com/keys" target="_blank" rel="noreferrer">console.groq.com/keys</a>. Queda guardada en el servidor y nunca se vuelve a mostrar completa.</small>
      {err && <div className="error-block">{err}</div>}
    </Card>
  );
}

export default function Motores({ user }) {
  const admin = user.role === 'admin';
  const [toast, toastNode] = useToast();
  return (
    <>
      <PageHead title="Cuentas y motores" />
      <div className="stack">
        <Estado admin={admin} toast={toast} />
        <Mantenimiento admin={admin} toast={toast} />
        <Consumo />
        {admin ? <Claude admin={admin} toast={toast} /> : null}
        <OpenCode admin={admin} toast={toast} />
        {admin ? <Audio admin={admin} toast={toast} /> : null}
      </div>
      {toastNode}
    </>
  );
}
