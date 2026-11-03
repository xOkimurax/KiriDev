import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { Badge, Button, Card, Combo, InlineConfirm, Segmented, Skeleton, Switch, useToast } from './ui.jsx';
import NumberList, { clean } from './NumberList.jsx';
import PersonaScope from './PersonaScope.jsx';

const APPROVAL = {
  ask: 'Pedir aprobación por WhatsApp (recomendado)',
  notify: 'Enviar y avisarme',
  direct: 'Enviar directo, sin aprobación',
};
const REPORT = { each: 'Reenviarme lo que responda', off: 'No avisarme' };
const YESNO = [{ value: 'yes', label: 'Sí' }, { value: 'no', label: 'No' }];
const STATUS = {
  pending: ['warn', 'Pendiente'], sent: ['ok', 'Enviado'], rejected: ['neutral', 'Descartado'], expired: ['neutral', 'Venció'],
  failed: ['bad', 'Falló'], blocked: ['bad', 'Bloqueado'], cancelled: ['neutral', 'Cancelado'],
};
const when = (s) => new Date(`${String(s).replace(' ', 'T')}Z`).toLocaleString('es', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });

/** Campos de envío. Con `inherit` cada campo puede quedar «como el general» (solo se guarda lo que se cambia). */
function ConfigFields({ value, onChange, base, inherit = false, disabled }) {
  const v = value || {};
  const set = (k, x) => { const n = { ...v }; if (x === undefined) delete n[k]; else n[k] = x; onChange(n); };
  const gen = (label) => ({ value: '', label: `Como el general (${label})` });
  const hours = v.hours;
  return (
    <div className="stack">
      <Combo label="Aprobación antes de enviar" disabled={disabled} value={v.approval || (inherit ? '' : base.approval)} onChange={(x) => set('approval', x || undefined)}
        options={[...(inherit ? [gen(APPROVAL[base.approval].split(' (')[0])] : []), ...Object.entries(APPROVAL).map(([value, label]) => ({ value, label }))]} />
      {inherit ? (
        <Combo label="Aprobar también sus respuestas" disabled={disabled} value={v.approvalReplies === undefined ? '' : v.approvalReplies ? 'yes' : 'no'} onChange={(x) => set('approvalReplies', x ? x === 'yes' : undefined)}
          options={[gen(base.approvalReplies ? 'Sí' : 'No'), ...YESNO]} />
      ) : (
        <Switch title="Aprobar también sus respuestas" desc="Cuando la persona contesta, lo que el agente le responda también espera tu «sí» por WhatsApp." checked={v.approvalReplies !== false} disabled={disabled} onChange={(x) => set('approvalReplies', x)} />
      )}
      <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
        <label>Máximo de mensajes iniciados por día
          <input type="number" min="1" max="50" disabled={disabled} value={v.maxPerDay ?? (inherit ? '' : base.maxPerDay)} placeholder={inherit ? `General: ${base.maxPerDay}` : ''}
            onChange={(e) => set('maxPerDay', e.target.value === '' ? undefined : Number(e.target.value))} /></label>
        <label>Tiempo de charla abierta (horas)
          <input type="number" min="1" max="168" disabled={disabled} value={v.windowHours ?? (inherit ? '' : base.windowHours)} placeholder={inherit ? `General: ${base.windowHours}` : ''}
            onChange={(e) => set('windowHours', e.target.value === '' ? undefined : Number(e.target.value))} /></label>
      </div>
      <p className="help">«Charla abierta»: después de escribirle, el agente sigue atendiendo sus respuestas durante este tiempo aunque las reglas normales no lo hicieran. Se renueva con cada mensaje suyo.</p>
      <Combo label="Cuando responde" disabled={disabled} value={v.report || (inherit ? '' : base.report)} onChange={(x) => set('report', x || undefined)}
        options={[...(inherit ? [gen(REPORT[base.report])] : []), ...Object.entries(REPORT).map(([value, label]) => ({ value, label }))]} />
      {inherit ? (
        <Combo label="Horario permitido para escribirle" disabled={disabled} value={!hours ? '' : hours.enabled ? 'on' : 'off'}
          onChange={(x) => set('hours', x === '' ? undefined : x === 'off' ? { enabled: false, from: '08:00', to: '21:00' } : { enabled: true, from: hours?.from || '08:00', to: hours?.to || '21:00' })}
          options={[gen(base.hours.enabled ? `${base.hours.from} a ${base.hours.to}` : 'sin límite'), { value: 'off', label: 'Sin límite horario' }, { value: 'on', label: 'Solo en una franja…' }]} />
      ) : (
        <Switch title="Limitar el horario" desc="Fuera de esta franja (hora local del agente) no inicia mensajes." checked={!!hours?.enabled} disabled={disabled} onChange={(x) => set('hours', { enabled: x, from: hours?.from || '08:00', to: hours?.to || '21:00' })} />
      )}
      {hours?.enabled && (
        <div className="row" style={{ gap: 12 }}>
          <label>Desde<input type="time" disabled={disabled} value={hours.from} onChange={(e) => set('hours', { ...hours, from: e.target.value })} /></label>
          <label>Hasta<input type="time" disabled={disabled} value={hours.to} onChange={(e) => set('hours', { ...hours, to: e.target.value })} /></label>
        </div>
      )}
    </div>
  );
}

function Destinatario({ t, base, accounts, personas, contacts, admin, onSaved, onDelete, toast }) {
  const [open, setOpen] = useState(false), [d, setD] = useState(t);
  useEffect(() => setD(t), [t]);
  const dirty = JSON.stringify(d) !== JSON.stringify(t), cfg = d.config || {};
  const setCfg = (config) => setD({ ...d, config });
  async function save() {
    try { await api('/outreach/targets', { method: 'PUT', body: d }); toast('Destinatario guardado'); onSaved(); } catch (e) { toast(e.message, 'err'); }
  }
  return (
    <div className="provider-row">
      <div className="row provider-head">
        <strong>{t.alias || `+${t.number}`}</strong>
        {t.alias && <span className="muted">+{t.number}</span>}
        {t.blocked && <Badge tone="bad">No contactar</Badge>}
        {t.config.initiate === false && <Badge tone="neutral">Solo supervisión</Badge>}
        {t.config.approval && <span className="chip">{APPROVAL[t.config.approval].split(' (')[0]}</span>}
        {admin && (
          <div className="row" style={{ marginLeft: 'auto' }}>
            <Button variant="secondary" onClick={() => setOpen(!open)}>{open ? 'Cerrar' : 'Configurar'}</Button>
            <InlineConfirm label="Quitar" message="Vuelve a usar los valores generales." confirmLabel="Sí, quitar" onConfirm={onDelete} />
          </div>
        )}
      </div>
      {open && (
        <div className="stack" style={{ marginTop: 8 }}>
          <label>Nombre para reconocerlo<input disabled={!admin} value={d.alias || ''} onChange={(e) => setD({ ...d, alias: e.target.value })} placeholder="Ej. Alba" /></label>
          <Switch title="El agente puede iniciarle conversaciones" desc="Apagado: solo se supervisan sus respuestas (según la aprobación de abajo)." checked={cfg.initiate !== false} disabled={!admin} onChange={(x) => setCfg({ ...cfg, initiate: x })} />
          <Switch title="No contactar" desc="Bloquea que el agente le inicie mensajes. Se activa solo si pide que no le escriban más." checked={!!d.blocked} disabled={!admin} onChange={(x) => setD({ ...d, blocked: x })} />
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            {accounts.length > 1 && (
              <Combo label="Escribirle desde el número" disabled={!admin} value={cfg.instance || ''} onChange={(x) => setCfg({ ...cfg, instance: x || undefined })}
                options={[{ value: '', label: 'El de quien lo pide' }, ...accounts.map((a) => ({ value: a.instance, label: a.label || a.instance }))]} />
            )}
            {personas.length > 1 && (
              <Combo label="Personalidad con la que le habla" disabled={!admin} value={String(cfg.personaId || '')} onChange={(x) => setCfg({ ...cfg, personaId: x ? Number(x) : undefined })}
                options={[{ value: '', label: 'La que le corresponde' }, ...personas.map((p) => ({ value: String(p.id), label: p.name }))]} />
            )}
          </div>
          <ConfigFields value={cfg} onChange={setCfg} base={base} inherit disabled={!admin} />
          <NumberList bare title="Aprobadores de este destinatario" items={cfg.approvers || []} disabled={!admin} contacts={contacts}
            onChange={(a) => setCfg({ ...cfg, approvers: a.length ? a : undefined })} empty="Sin lista propia: aprueban los generales." hint="Opcional. Si agregás números, solo ellos aprueban lo de este destinatario." />
          {admin && <div className="row"><Button icon="save" disabled={!dirty} onClick={save}>Guardar destinatario</Button></div>}
        </div>
      )}
    </div>
  );
}

function Historial({ admin, toast }) {
  const [f, setF] = useState(''), [rows, setRows] = useState(null);
  const load = useCallback(() => api(`/outreach/log?limit=60${f ? `&status=${f}` : ''}`).then(setRows).catch(() => setRows([])), [f]);
  useEffect(() => { load(); const t = setInterval(load, 15000); return () => clearInterval(t); }, [load]);
  async function act(id, what) { try { await api(`/outreach/log/${id}/${what}`, { method: 'POST' }); toast(what === 'approve' ? 'Enviado' : 'Descartado'); load(); } catch (e) { toast(e.message, 'err'); } }
  return (
    <Card title="Historial de mensajes iniciados y aprobaciones">
      <Segmented label="Ver" value={f} onChange={setF} options={[{ value: '', label: 'Todo' }, { value: 'pending', label: 'Pendientes' }, { value: 'sent', label: 'Enviados' }, { value: 'blocked', label: 'Bloqueados' }]} />
      {!rows ? <Skeleton rows={3} /> : !rows.length ? <p className="muted">Todavía no hay nada acá.</p> : (
        <ul className="list">
          {rows.map((r) => {
            const [tone, label] = STATUS[r.status] || ['neutral', r.status];
            return (
              <li key={r.id}>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong>#{r.id} · {r.kind === 'reply' ? 'Respuesta a' : 'Mensaje para'} {r.name || `+${r.number}`}</strong>{' '}<Badge tone={tone}>{label}</Badge>
                  <small>{when(r.created_at)}{r.requester_name ? ` · pidió ${r.requester_name}` : ''}{r.mode === 'agent' ? ' · redactado por el agente' : ''}{r.decided_by ? ` · decidió ${r.decided_by === 'panel' ? 'el panel' : `+${r.decided_by}`}` : ''}</small>
                  {r.context && <small>Escribió: «{r.context}»</small>}
                  {r.text && <p style={{ margin: '4px 0 0', whiteSpace: 'pre-wrap' }}>{r.text}</p>}
                  {r.objective && <small>Objetivo: {r.objective}</small>}
                  {r.reason && <small className="alert-text">{r.reason}</small>}
                </div>
                {admin && r.status === 'pending' && (
                  <div className="row"><Button onClick={() => act(r.id, 'approve')}>Aprobar y enviar</Button><Button variant="secondary" onClick={() => act(r.id, 'reject')}>Descartar</Button></div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

export default function Outreach({ admin }) {
  const [s, setS] = useState(null), [saved, setSaved] = useState(''), [targets, setTargets] = useState([]), [accounts, setAccounts] = useState([]), [personas, setPersonas] = useState([]),
    [contacts, setContacts] = useState([]), [pick, setPick] = useState(''), [num, setNum] = useState(''), [check, setCheck] = useState(null), [toast, toastNode] = useToast();
  const load = useCallback(() => {
    api('/outreach/settings').then((x) => { setS(x); setSaved(JSON.stringify(x)); }).catch(() => {});
    api('/outreach/targets').then(setTargets).catch(() => {});
  }, []);
  useEffect(() => {
    load();
    api('/whatsapp/accounts').then(setAccounts).catch(() => {});
    api('/personas').then(setPersonas).catch(() => {});
    api('/contacts').then((r) => setContacts(r.contacts.map((c) => ({ jid: `${c.number}@s.whatsapp.net`, wa_jid: `${c.number}@s.whatsapp.net`, name: c.name })))).catch(() => {});
  }, [load]);
  const options = useMemo(() => [...new Map(contacts.map((c) => [clean(c.wa_jid), c])).values()].filter((c) => !targets.some((t) => t.number === clean(c.wa_jid)))
    .map((c) => ({ value: clean(c.wa_jid), label: c.name || `+${clean(c.wa_jid)}`, description: `+${clean(c.wa_jid)}` })), [contacts, targets]);
  if (!s) return <Card title="Conversaciones que inicia el agente"><Skeleton rows={4} /></Card>;
  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  const dirty = JSON.stringify(s) !== saved, ov = s.overview || {};
  async function save() {
    try { const x = await api('/outreach/settings', { method: 'PUT', body: s }); setS(x); setSaved(JSON.stringify(x)); toast('Guardado'); } catch (e) { toast(e.message, 'err'); }
  }
  async function verify(n) {
    setCheck({ loading: true });
    try { const r = await api('/outreach/check', { method: 'POST', body: { number: n } }); setCheck(r.exists === null ? { note: r.note } : r.exists ? { ok: true } : { bad: true }); } catch (e) { setCheck({ error: e.message }); }
  }
  async function add(number, alias) {
    try { await api('/outreach/targets', { method: 'PUT', body: { number, alias: alias || null, config: {} } }); setPick(''); setNum(''); setCheck(null); toast('Destinatario agregado'); load(); } catch (e) { toast(e.message, 'err'); }
  }
  const pickedLabel = options.find((o) => o.value === pick)?.label;
  return (
    <>
      <Card title="Conversaciones que inicia el agente">
        <p className="help">Opcional. Le pedís al agente por WhatsApp «escribile a Alba…» o «hablale por privado a Beto, el del grupo» y él inicia la conversación. Cada mensaje puede pasar por tu aprobación por WhatsApp antes de salir.</p>
        <Switch title="Permitir que el agente inicie conversaciones" desc={s.enabled ? `${ov.pending || 0} pendiente(s) de aprobar · ${ov.sent24 || 0} enviado(s) en 24 h · ${ov.threads || 0} charla(s) abierta(s)` : 'Apagado: el agente nunca le escribe primero a nadie.'} checked={s.enabled} disabled={!admin} onChange={(v) => set('enabled', v)} />
        {s.enabled && (
          <>
            <PersonaScope value={s.personas} disabled={!admin} onChange={(v) => set('personas', v)} />
            <h3 style={{ margin: '12px 0 0', fontSize: 15 }}>Quién puede pedírselo</h3>
            <NumberList bare title="Quienes pueden pedirle que escriba" items={s.orderers} disabled={!admin} contacts={contacts} onChange={(v) => set('orderers', v)}
              empty="Sin números: nadie puede pedírselo todavía." hint="Solo estos números, hablándole por privado, pueden ordenarle escribir a otros. Se verifica por el número del chat." />
            <h3 style={{ margin: '12px 0 0', fontSize: 15 }}>A quién puede escribirle</h3>
            <Switch title="Contactos que ya conoce" desc="Gente que ya le escribió o que está en su libreta." checked={s.allowKnown} disabled={!admin} onChange={(v) => set('allowKnown', v)} />
            <Switch title="Números nuevos que le pase quien se lo pide" desc="Antes de escribir se verifica que el número tenga WhatsApp; si no tiene, no se envía." checked={s.allowNew} disabled={!admin} onChange={(v) => set('allowNew', v)} />
            <p className="help">También puede escribirle a alguien de un grupo, por privado, si quien lo pide lo nombra. Lo que figure en «Destinatarios con ajustes propios» o en la lista bloqueada de las reglas manda sobre estas opciones.</p>
            <h3 style={{ margin: '12px 0 0', fontSize: 15 }}>Cómo se envía (valores generales)</h3>
            <ConfigFields value={s.defaults} onChange={(v) => set('defaults', v)} base={s.defaults} disabled={!admin} />
            <h3 style={{ margin: '12px 0 0', fontSize: 15 }}>Aprobaciones por WhatsApp</h3>
            <NumberList bare title="Quién aprueba" items={s.approvers} disabled={!admin} contacts={contacts} onChange={(v) => set('approvers', v)}
              empty="Sin lista: aprueba quien lo pidió." hint="Si agregás números, aprueban ellos (cualquiera de los listados). Reciben el borrador y responden «sí» o «no», o piden cambiarlo." />
            {accounts.length > 1 && (
              <Combo label="Enviar las solicitudes por el número" disabled={!admin} value={s.notifyInstance} onChange={(v) => set('notifyInstance', v)}
                options={[{ value: '', label: 'El de quien lo pidió' }, ...accounts.map((a) => ({ value: a.instance, label: a.label || a.instance }))]} />
            )}
            <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
              <label>Una aprobación vence en (minutos)<input type="number" min="5" max="2880" disabled={!admin} value={s.approvalTtlMin} onChange={(e) => set('approvalTtlMin', Number(e.target.value))} /></label>
              <label>Tope diario entre todos los destinatarios<input type="number" min="1" max="500" disabled={!admin} value={s.maxPerDayTotal} onChange={(e) => set('maxPerDayTotal', Number(e.target.value))} /></label>
            </div>
            <p className="help">Escribirle a gente que no te escribió primero puede hacer que WhatsApp bloquee el número: por eso conviene mantener topes bajos y la aprobación activada.</p>
          </>
        )}
        {admin && <div className="row"><Button icon="save" disabled={!dirty} onClick={save}>Guardar</Button></div>}
      </Card>
      {s.enabled && (
        <Card title="Destinatarios con ajustes propios">
          <p className="help">Opcional. Para un contacto concreto podés cambiar la aprobación, los topes, el horario, el número desde el que se le escribe o la personalidad. También sirve para <strong>supervisar</strong> a alguien: apagás «iniciarle conversaciones» y cada respuesta del agente a esa persona espera tu «sí».</p>
          {!targets.length && <p className="muted">Todavía no agregaste ninguno: se usan los valores generales.</p>}
          {targets.map((t) => <Destinatario key={t.number} t={t} base={s.defaults} accounts={accounts} personas={personas} contacts={contacts} admin={admin} toast={toast} onSaved={load}
            onDelete={async () => { await api(`/outreach/targets/${t.number}`, { method: 'DELETE' }); toast('Destinatario quitado'); load(); }} />)}
          {admin && (
            <div className="stack">
              <h3 style={{ margin: '12px 0 0', fontSize: 15 }}>Agregar destinatario</h3>
              <div className="row panel-addrow">
                <div style={{ minWidth: 240, flex: 1 }}><Combo label="Contacto conocido" value={pick} onChange={setPick} searchable options={options} placeholder="Elegir…" /></div>
                <Button variant="secondary" disabled={!pick} onClick={() => add(pick, pickedLabel && !pickedLabel.startsWith('+') ? pickedLabel : '')}>Agregar</Button>
              </div>
              <div className="row panel-addrow">
                <label style={{ flex: 1, minWidth: 240 }}>Número nuevo<input value={num} onChange={(e) => { setNum(e.target.value); setCheck(null); }} placeholder="595981123456" /></label>
                <Button variant="secondary" disabled={clean(num).length < 8} onClick={() => verify(clean(num))}>Verificar WhatsApp</Button>
                <Button disabled={clean(num).length < 8 || check?.bad} onClick={() => add(clean(num), '')}>Agregar</Button>
              </div>
              {check && <p className={check.ok || check.loading || check.note ? 'help' : 'alert'} role="status">{check.loading ? 'Verificando…' : check.ok ? '✔ Tiene WhatsApp' : check.bad ? '✖ Ese número no tiene WhatsApp' : check.note || check.error}</p>}
            </div>
          )}
        </Card>
      )}
      {s.enabled && <Historial admin={admin} toast={toast} />}
      {toastNode}
    </>
  );
}
