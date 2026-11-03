import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import { Badge, Button, Card, Combo, Switch, InlineConfirm, PageHead, Skeleton, phone, useToast } from '../components/ui.jsx';
const DAYS = [['1', 'Lunes'], ['2', 'Martes'], ['3', 'Miércoles'], ['4', 'Jueves'], ['5', 'Viernes'], ['6', 'Sábado'], ['0', 'Domingo']];

function OfficeHours({ instance, admin }) {
  const [o, setO] = useState(null),
    [saved, setSaved] = useState(''),
    [personas, setPersonas] = useState([]),
    [msg, setMsg] = useState('');
  useEffect(() => {
    api(`/whatsapp/accounts/${encodeURIComponent(instance)}/office`).then((x) => { setO(x); setSaved(JSON.stringify(x)); }).catch(() => {});
    api('/personas').then(setPersonas).catch(() => {});
  }, [instance]);
  if (!o) return null;
  const set = (k, v) => setO({ ...o, [k]: v });
  const span = (d) => o.days?.[d]?.[0] || null;
  const setDay = (d, v) => setO({ ...o, days: { ...o.days, [d]: v } });
  async function save() {
    try {
      const x = await api(`/whatsapp/accounts/${encodeURIComponent(instance)}/office`, { method: 'PUT', body: o });
      setO(x); setSaved(JSON.stringify(x)); setMsg('Horario guardado');
    } catch (e) { setMsg(e.message); }
  }
  return (
    <Card title="Horario de atención">
      <Switch title="Usar horario de atención en este número" desc="Opcional" disabled={!admin} checked={o.enabled} onChange={(v) => set('enabled', v)} />
      {o.enabled && (
        <>
          {DAYS.map(([d, label]) => (
            <div className="row" key={d} style={{ gap: 8, alignItems: 'center' }}>
              <label style={{ minWidth: 110 }}>
                <input type="checkbox" disabled={!admin} checked={!!span(d)} onChange={(e) => setDay(d, e.target.checked ? [['09:00', '18:00']] : [])} /> {label}
              </label>
              {span(d) ? (
                <>
                  <input type="time" disabled={!admin} value={span(d)[0]} onChange={(e) => setDay(d, [[e.target.value, span(d)[1]]])} />
                  <span>a</span>
                  <input type="time" disabled={!admin} value={span(d)[1]} onChange={(e) => setDay(d, [[span(d)[0], e.target.value]])} />
                </>
              ) : <span className="muted">cerrado</span>}
            </div>
          ))}
          <Combo
            label="Fuera de horario"
            disabled={!admin}
            value={o.mode}
            onChange={(v) => set('mode', v)}
            options={[
              { value: 'message', label: 'Responder un mensaje fijo' },
              { value: 'persona', label: 'Responder con otra personalidad' },
              { value: 'silent', label: 'No responder (el mensaje queda guardado)' },
            ]}
          />
          {o.mode === 'message' && (
            <>
              <label>
                Mensaje
                <textarea disabled={!admin} rows={3} value={o.message} maxLength={1000} onChange={(e) => set('message', e.target.value)} />
              </label>
              <label>
                Repetirlo como máximo cada (horas, por persona)
                <input type="number" min="0" max="168" disabled={!admin} value={o.cooldownHours} onChange={(e) => set('cooldownHours', Number(e.target.value))} />
              </label>
            </>
          )}
          {o.mode === 'persona' && (
            <Combo
              label="Personalidad fuera de horario"
              disabled={!admin}
              value={o.personaId || ''}
              onChange={(v) => set('personaId', v ? Number(v) : null)}
              placeholder="Elegí una…"
              options={personas.map((p) => ({ value: p.id, label: p.name }))}
            />
          )}
          <Switch title="Aplicar también en grupos" disabled={!admin} checked={o.groups} onChange={(v) => set('groups', v)} />
          <p className="muted">Usa la zona horaria general ({o.tz || 'la de Configuración'}).</p>
        </>
      )}
      {admin && <div className="row"><Button icon="save" disabled={JSON.stringify(o) === saved} onClick={save}>Guardar horario</Button>{msg && <span className="muted">{msg}</span>}</div>}
    </Card>
  );
}

function AccountPanel({ user, acc, onChanged, many }) {
  const q = `?instance=${encodeURIComponent(acc.instance)}`;
  const [st, setSt] = useState(null),
    [qr, setQr] = useState(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [toast, toastNode] = useToast();
  const admin = user.role === 'admin';
  const load = useCallback(
    () =>
      api('/whatsapp/status' + q)
        .then((s) => {
          setSt(s);
          setError('');
          if (s.state === 'open') setQr(null);
        })
        .catch((e) => setError(e.message)),
    [],
  );
  useEffect(() => {
    load();
    const id = setInterval(load, 4000);
    return () => clearInterval(id);
  }, [load]);
  async function act(fn, success) {
    setBusy(true);
    try {
      await fn();
      toast(success);
      await load();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }
  async function connect() {
    setBusy(true);
    try {
      const r = await api('/whatsapp/connect' + q, { method: 'POST' });
      setQr(r.base64 || null);
      if (!r.base64) toast('QR todavía no disponible. Reintentá en unos segundos.', 'err');
      await load();
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }
  const hookOk = st?.webhook && st.webhook === st.expectedWebhook;
  return (
    <>
      <div className="operation-row" style={{ marginBottom: 8 }}>
        <h2 style={{ margin: 0, fontSize: 18 }}>{acc.label || acc.instance}{acc.primary ? ' · principal' : ''}</h2>
        <Badge tone={st?.state === 'open' ? 'ok' : st?.state === 'connecting' ? 'warn' : 'bad'}>
          {st?.state === 'open' ? 'Conectada' : st?.state === 'connecting' ? 'Esperando QR' : 'Desconectada'}
        </Badge>
        {admin && !acc.primary && (
          <InlineConfirm
            label="Quitar número"
            variant="secondary"
            message="Se deja de atender esta línea (los chats quedan guardados). ¿Quitarla?"
            confirmLabel="Sí, quitar"
            onConfirm={async () => {
              try { await api(`/whatsapp/accounts/${encodeURIComponent(acc.instance)}?deleteInstance=1`, { method: 'DELETE' }); onChanged(); } catch (e) { toast(e.message, 'err'); }
            }}
          />
        )}
      </div>
      {error && (
        <div className="error-block">
          No se pudo consultar la conexión: {error}
          <Button variant="secondary" onClick={load}>
            Reintentar
          </Button>
        </div>
      )}
      <div className="stack">
        <Card title="Vincular dispositivo">
          {!st ? (
            <Skeleton rows={3} />
          ) : st.state === 'open' ? (
            <div className="connected">
              {st.profilePicUrl && <img src={st.profilePicUrl} alt="" />}
              <div>
                <strong>{st.profileName || 'Cuenta conectada'}</strong>
                <span className="mono muted">{phone(st.number)}</span>
              </div>
            </div>
          ) : (
            <div className="qr-layout">
              {qr ? (
                <img src={qr} alt="Código QR para vincular WhatsApp" />
              ) : (
                <div className="empty" style={{ width: 240, height: 240, border: '1px solid var(--line)' }}>
                  <strong>QR pendiente</strong>
                  <span>Generalo para vincular la línea.</span>
                </div>
              )}
              <ol>
                <li>Abrí WhatsApp en tu celular.</li>
                <li>Entrá en Dispositivos vinculados.</li>
                <li>Tocá Vincular dispositivo y escaneá el código.</li>
              </ol>
            </div>
          )}
          {admin && (
            <div className="row">
              {st?.state !== 'open' && (
                <Button disabled={busy} onClick={connect} icon="refresh">
                  {qr ? 'Regenerar QR' : 'Generar QR'}
                </Button>
              )}
              {st?.state === 'open' && (
                <InlineConfirm
                  disabled={busy}
                  label="Desvincular"
                  message="El agente dejará de responder hasta volver a vincular."
                  confirmLabel="Sí, desvincular"
                  onConfirm={() => act(() => api('/whatsapp/logout' + q, { method: 'POST' }), 'Número desvinculado')}
                />
              )}
              <InlineConfirm
                disabled={busy}
                label="Reiniciar instancia"
                variant="secondary"
                message="¿Reiniciar la conexión?"
                confirmLabel="Sí, reiniciar"
                onConfirm={() => act(() => api('/whatsapp/restart' + q, { method: 'POST' }), 'Instancia reiniciada')}
              />
            </div>
          )}
        </Card>
        <Card title="Webhook">
          <div className="operation-row">
            <Badge tone={hookOk ? 'ok' : 'warn'}>{hookOk ? 'Sincronizado' : 'Desincronizado'}</Badge>
            {admin && st?.exists && !hookOk && (
              <Button
                variant="secondary"
                disabled={busy}
                onClick={() => act(() => api('/whatsapp/webhook' + q, { method: 'POST' }), 'Webhook sincronizado')}
              >
                Sincronizar
              </Button>
            )}
          </div>
          <dl className="kv">
            <dt>Instancia</dt>
            <dd className="mono">{st?.instance || '—'}</dd>
            <dt>Webhook actual</dt>
            <dd className="mono">{st?.webhook || 'Ninguno'}</dd>
            <dt>Webhook esperado</dt>
            <dd className="mono">{st?.expectedWebhook || 'No configurado'}</dd>
          </dl>
        </Card>
      </div>
      <div style={{ marginTop: 16 }}><OfficeHours instance={acc.instance} admin={admin} /></div>
      {toastNode}
    </>
  );
}

export default function WhatsApp({ user }) {
  const [accounts, setAccounts] = useState(null),
    [adding, setAdding] = useState(false),
    [form, setForm] = useState({ instance: '', label: '' }),
    [err, setErr] = useState(''),
    [toast, toastNode] = useToast();
  const admin = user.role === 'admin';
  const load = useCallback(() => api('/whatsapp/accounts').then(setAccounts).catch((e) => setErr(e.message)), []);
  useEffect(() => {
    load();
  }, [load]);
  async function add() {
    setErr('');
    try {
      await api('/whatsapp/accounts', { method: 'POST', body: { instance: form.instance.trim(), label: form.label.trim() || form.instance.trim() } });
      setForm({ instance: '', label: '' });
      setAdding(false);
      toast('Número agregado: generá su QR para vincularlo');
      load();
    } catch (e) {
      setErr(e.message);
    }
  }
  return (
    <>
      <PageHead title="WhatsApp">
        {admin && (
          <Button variant="secondary" icon="plus" onClick={() => setAdding((v) => !v)}>
            Agregar número
          </Button>
        )}
      </PageHead>
      {adding && (
        <Card title="Nuevo número de WhatsApp">
          <p className="muted">Cada número es una línea distinta del agente. Después de agregarlo, generá su QR y escanealo desde ese celular.</p>
          <div className="row">
            <input placeholder="Nombre técnico (ej. ventas)" value={form.instance} onChange={(e) => setForm({ ...form, instance: e.target.value.replace(/[^a-z0-9_-]/gi, '') })} maxLength={40} />
            <input placeholder="Etiqueta visible (ej. Ventas)" value={form.label} onChange={(e) => setForm({ ...form, label: e.target.value })} maxLength={40} />
            <Button onClick={add} disabled={!form.instance.trim()}>Crear</Button>
          </div>
          {err && <div className="error-block">{err}</div>}
        </Card>
      )}
      {!accounts ? <Skeleton rows={4} /> : accounts.map((a) => (
        <div key={a.instance} style={{ marginBottom: 28 }}>
          <AccountPanel user={user} acc={a} many={accounts.length > 1} onChanged={load} />
        </div>
      ))}
      {toastNode}
    </>
  );
}
