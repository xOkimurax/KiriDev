import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import PersonaScope from '../components/PersonaScope.jsx';
import { Badge, Button, Card, Combo, Empty, InlineConfirm, Skeleton, Switch, fmtDate, contactName, useToast } from '../components/ui.jsx';

const urgencyTone = { alta: 'bad', normal: 'warn', baja: 'neutral' };

function AttentionSettings({ admin, accounts }) {
  const [s, setS] = useState(null),
    [owners, setOwners] = useState(''),
    [saved, setSaved] = useState(''),
    [toast, toastNode] = useToast();
  useEffect(() => {
    api('/attention-settings').then((x) => { setS(x); setOwners(x.owners.join(', ')); setSaved(JSON.stringify(x)); }).catch(() => {});
  }, []);
  if (!s) return <Skeleton rows={3} />;
  const draft = { ...s, owners };
  const dirty = JSON.stringify({ ...s, owners: s.owners }) !== saved || owners !== s.owners.join(', ');
  async function save() {
    try {
      const x = await api('/attention-settings', { method: 'PUT', body: draft });
      setS(x); setOwners(x.owners.join(', ')); setSaved(JSON.stringify(x)); toast('Configuración guardada');
    } catch (e) { toast(e.message, 'err'); }
  }
  const set = (k, v) => setS({ ...s, [k]: v });
  return (
    <Card title="Configuración de avisos">
      <p className="help">Opcional. Si lo activás, el agente puede pasar una conversación a una persona cuando no sabe algo, hay un reclamo o la persona lo pide.</p>
      <PersonaScope value={s.personas} disabled={!admin} onChange={(v) => set('personas', v)} />
      <Switch title="El agente puede pedir ayuda humana" disabled={!admin} checked={s.enabled} onChange={(v) => set('enabled', v)} />
      <Switch title="Pausar al agente en ese chat hasta que yo lo resuelva" disabled={!admin} checked={s.pause} onChange={(v) => set('pause', v)} />
      <Switch title="Avisarme también cuando falla una tarea delegada" disabled={!admin} checked={s.notifyFailedTasks} onChange={(v) => set('notifyFailedTasks', v)} />
      <label>
        Números a los que se avisa por WhatsApp (con código de país, separados por coma)
        <input disabled={!admin} value={owners} onChange={(e) => setOwners(e.target.value)} placeholder="595981123456" />
      </label>
      {accounts.length > 1 && (
        <Combo
          label="Avisar por el número"
          disabled={!admin}
          value={s.notifyInstance}
          onChange={(v) => set('notifyInstance', v)}
          options={[{ value: '', label: 'El mismo por el que escribió la persona' }, ...accounts.map((a) => ({ value: a.instance, label: a.label || a.instance }))]}
        />
      )}
      <label>
        No repetir el aviso del mismo chat antes de (minutos)
        <input type="number" min="1" max="1440" disabled={!admin} value={s.notifyCooldownMin} onChange={(e) => set('notifyCooldownMin', Number(e.target.value))} />
      </label>
      {admin && <div className="row"><Button icon="save" disabled={!dirty} onClick={save}>Guardar</Button></div>}
      {toastNode}
    </Card>
  );
}

export default function Attention({ admin }) {
  const [items, setItems] = useState(null),
    [accounts, setAccounts] = useState([]),
    [showAll, setShowAll] = useState(false),
    [error, setError] = useState(''),
    [toast, toastNode] = useToast();
  const load = useCallback(() => api('/attention' + (showAll ? '' : '?status=open')).then((r) => { setItems(r.items); setError(''); }).catch((e) => setError(e.message)), [showAll]);
  useEffect(() => { load(); const id = setInterval(load, 8000); return () => clearInterval(id); }, [load]);
  useEffect(() => { api('/whatsapp/accounts').then(setAccounts).catch(() => {}); }, []);
  async function resolve(id, resume) {
    try { await api(`/attention/${id}/resolve`, { method: 'POST', body: { resume } }); toast(resume ? 'Resuelto: el agente retoma el chat' : 'Resuelto'); load(); }
    catch (e) { toast(e.message, 'err'); }
  }
  return (
    <>
      <div className="row" style={{ margin: '8px 0' }}>
        <Button variant={showAll ? 'secondary' : 'primary'} onClick={() => setShowAll(false)}>Pendientes</Button>
        <Button variant={showAll ? 'primary' : 'secondary'} onClick={() => setShowAll(true)}>Todas</Button>
      </div>
      {error && <div className="error-block">{error}</div>}
      {!items ? <Skeleton rows={4} /> : !items.length ? (
        <Empty title="Nada pendiente">Cuando el agente necesite a una persona, aparece acá y te llega un aviso por WhatsApp.</Empty>
      ) : (
        <div className="stack">
          {items.map((a) => (
            <Card key={a.id} title={`${contactName({ name: a.contact_name, jid: a.jid, wa_jid: a.wa_jid })}${a.instanceLabel ? ` · ${a.instanceLabel}` : ''}`}>
              <div className="row" style={{ gap: 8 }}>
                <Badge tone={a.status === 'open' ? urgencyTone[a.urgency] || 'warn' : 'ok'}>{a.status === 'open' ? `Pendiente · ${a.urgency}` : 'Resuelta'}</Badge>
                {a.kind === 'tarea' && <Badge tone="bad">Tarea fallida</Badge>}
                {a.status === 'open' && a.paused ? <Badge tone="warn">Agente en pausa</Badge> : null}
                <span className="muted">{fmtDate(a.created_at)}</span>
              </div>
              <p><strong>{a.reason}</strong></p>
              {a.summary && <p style={{ whiteSpace: 'pre-wrap' }}>{a.summary}</p>}
              {admin && a.status === 'open' && (
                <div className="row">
                  <InlineConfirm label="Resolver y reactivar al agente" message="El agente vuelve a responder en este chat." confirmLabel="Sí, reactivar" onConfirm={() => resolve(a.id, true)} />
                  <Button variant="secondary" onClick={() => resolve(a.id, false)}>Resolver (dejar pausado)</Button>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}
      <AttentionSettings admin={admin} accounts={accounts} />
      {toastNode}
    </>
  );
}
