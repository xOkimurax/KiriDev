import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api.js';
import PersonaScope from '../components/PersonaScope.jsx';
import { Badge, Button, Card, Combo, Empty, InlineConfirm, PageHead, Skeleton, Switch, fmtDate, useToast } from '../components/ui.jsx';

const STATUS = { active: ['ok', 'Publicada'], pending: ['warn', 'Esperando aprobación'], rejected: ['bad', 'Descartada'], expired: ['neutral', 'Venció'], removed: ['neutral', 'Despublicada'], cancelled: ['neutral', 'Cancelada'] };
const ACCESS = { public: 'Pública', login: 'Con login del panel' };

function DockerCard({ docker, admin, onPrune }) {
  if (!docker?.configured) return null;
  return (
    <Card title="Docker del agente" action={<Badge tone={docker.reachable ? 'ok' : 'bad'}>{docker.reachable ? 'Conectado' : 'Sin conexión'}</Badge>}>
      {docker.reachable ? (
        <>
          <p className="help">Es un espacio aparte, sin acceso al resto del servidor. Ahora hay <strong>{docker.running}</strong> contenedor{docker.running === 1 ? '' : 'es'} corriendo.</p>
          {docker.df?.length > 0 && (
            <div className="stack">
              {docker.df.map((d) => (
                <div key={d.type} className="row" style={{ justifyContent: 'space-between' }}>
                  <span>{{ Images: 'Imágenes', Containers: 'Contenedores', 'Local Volumes': 'Volúmenes', 'Build Cache': 'Caché de construcción' }[d.type] || d.type}</span>
                  <span className="muted">{d.active}/{d.total} en uso · {d.size}{d.reclaimable ? ` · liberable ${d.reclaimable}` : ''}</span>
                </div>
              ))}
            </div>
          )}
          {admin && (
            <div className="row">
              <InlineConfirm label="Limpiar lo viejo" message="Borra contenedores parados, imágenes y caché sin uso de hace más de 3 días. Las apps que están corriendo no se tocan." confirmLabel="Sí, limpiar" variant="secondary" onConfirm={onPrune} />
            </div>
          )}
        </>
      ) : <div className="error-block">No se pudo conectar con el Docker del agente{docker.error ? `: ${docker.error}` : ''}.</div>}
    </Card>
  );
}

function Settings({ data, accounts, admin, onSaved }) {
  const [s, setS] = useState(data.settings), [approvers, setApprovers] = useState(data.settings.approvers.join(', ')), [saved, setSaved] = useState(JSON.stringify(data.settings)), [toast, toastNode] = useToast();
  const set = (k, v) => setS({ ...s, [k]: v });
  const draft = { ...s, approvers };
  const dirty = JSON.stringify({ ...s, approvers: s.approvers }) !== saved || approvers !== s.approvers.join(', ');
  async function save() {
    try {
      const x = await api('/apps/settings', { method: 'PUT', body: draft });
      setS(x); setApprovers(x.approvers.join(', ')); setSaved(JSON.stringify(x)); toast('Configuración guardada'); onSaved();
    } catch (e) { toast(e.message, 'err'); }
  }
  return (
    <Card title="Configuración">
      <p className="help">Opcional. Si lo activás, el agente puede crear y usar contenedores en su Docker aislado para probar código o armar apps, y pedir que las publiquen con una dirección de internet.</p>
      {!data.available && <div className="error-block">Esta función todavía no está disponible en este despliegue: falta conectar el Docker aislado (variables DOCKER_HOST y APPS_HOST_SUFFIX).</div>}
      {data.available && !data.bashEnabled && <div className="error-block">Para usar Docker el agente necesita la herramienta «Bash». Habilitala en Personalidades → Herramientas.</div>}
      <PersonaScope value={s.personas} disabled={!admin} onChange={(v) => set('personas', v)} />
      <Switch title="El agente puede usar su Docker y publicar apps" disabled={!admin} checked={s.enabled} onChange={(v) => set('enabled', v)} />
      <Combo
        label="Cómo se publica una app"
        disabled={!admin}
        value={s.approval}
        onChange={(v) => set('approval', v)}
        options={[{ value: 'ask', label: 'Cada publicación se aprueba por WhatsApp (recomendado)' }, { value: 'direct', label: 'Se publica sin preguntar' }]}
      />
      {s.approval === 'ask' && (
        <>
          <label>
            Números que aprueban por WhatsApp (con código de país, separados por coma). Vacío = aprueba quien lo pidió.
            <input disabled={!admin} value={approvers} onChange={(e) => setApprovers(e.target.value)} placeholder="595981123456" />
          </label>
          {accounts.length > 1 && (
            <Combo label="Pedir la aprobación por el número" disabled={!admin} value={s.notifyInstance} onChange={(v) => set('notifyInstance', v)}
              options={[{ value: '', label: 'El mismo por el que escribió la persona' }, ...accounts.map((a) => ({ value: a.instance, label: a.label || a.instance }))]} />
          )}
          <label>
            Minutos que espera una aprobación antes de vencer
            <input type="number" min="5" max="2880" disabled={!admin} value={s.approvalTtlMin} onChange={(e) => set('approvalTtlMin', Number(e.target.value))} />
          </label>
        </>
      )}
      <Combo
        label="Acceso por defecto a las apps"
        disabled={!admin}
        value={s.defaultAccess}
        onChange={(v) => set('defaultAccess', v)}
        options={[{ value: 'public', label: 'Pública: cualquiera con el enlace' }, { value: 'login', label: 'Con usuario y contraseña de este panel' }]}
      />
      <small className="help">El agente puede elegir el acceso de cada app si la persona se lo pide.</small>
      <div className="row panel-addrow">
        <label>Apps publicadas a la vez (todas)<input type="number" min="1" max="50" disabled={!admin} value={s.maxApps} onChange={(e) => set('maxApps', Number(e.target.value))} /></label>
        <label>Apps por chat<input type="number" min="1" max="20" disabled={!admin} value={s.maxPerOwner} onChange={(e) => set('maxPerOwner', Number(e.target.value))} /></label>
      </div>
      {admin && <div className="row"><Button icon="save" disabled={!dirty} onClick={save}>Guardar</Button></div>}
      {toastNode}
    </Card>
  );
}

export default function Apps({ user }) {
  const admin = user?.role === 'admin';
  const [data, setData] = useState(null), [accounts, setAccounts] = useState([]), [error, setError] = useState(''), [all, setAll] = useState(false), [toast, toastNode] = useToast();
  const load = useCallback(() => api('/apps').then((d) => { setData(d); setError(''); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); const id = setInterval(load, 8000); return () => clearInterval(id); }, [load]);
  useEffect(() => { api('/whatsapp/accounts').then(setAccounts).catch(() => {}); }, []);
  async function act(path, ok) {
    try { await api(path, { method: 'POST' }); toast(ok); load(); } catch (e) { toast(e.message, 'err'); }
  }
  async function prune() {
    try { const r = await api('/apps/prune', { method: 'POST', body: { hours: 72 } }); toast(`Listo. ${r.detail || ''}`.trim()); load(); } catch (e) { toast(e.message, 'err'); }
  }
  const items = (data?.items || []).filter((a) => all || a.status === 'active' || a.status === 'pending');
  return (
    <>
      <PageHead title="Apps">
        <Button variant={all ? 'secondary' : 'primary'} onClick={() => setAll(false)}>Activas</Button>
        <Button variant={all ? 'primary' : 'secondary'} onClick={() => setAll(true)}>Historial</Button>
      </PageHead>
      {error && <div className="error-block">{error}</div>}
      {!data ? <Skeleton rows={4} /> : (
        <>
          {!items.length ? (
            <Empty title="Todavía no hay apps">Cuando el agente levante una app y pida publicarla, aparece acá (y te llega el pedido de aprobación por WhatsApp).</Empty>
          ) : (
            <div className="stack">
              {items.map((a) => {
                const [tone, label] = STATUS[a.status] || ['neutral', a.status];
                return (
                  <Card key={a.id} title={a.name}>
                    <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                      <Badge tone={tone}>{label}</Badge>
                      <Badge tone="neutral">{ACCESS[a.access]}</Badge>
                      {a.status === 'active' && a.running === false && <Badge tone="bad">Contenedor apagado</Badge>}
                      <span className="muted">{fmtDate(a.created_at)}</span>
                    </div>
                    {a.url && <p><a href={a.url} target="_blank" rel="noreferrer">{a.url}</a></p>}
                    {a.description && <p>{a.description}</p>}
                    <p className="muted">Pedida por {a.owner_name} · contenedor {a.container}:{a.port}{a.status === 'active' ? ` · ${a.hits} visita${a.hits === 1 ? '' : 's'}${a.last_hit ? `, última ${fmtDate(a.last_hit)}` : ''}` : ''}</p>
                    {admin && a.status === 'pending' && (
                      <div className="row">
                        <Button icon="check" onClick={() => act(`/apps/${a.id}/approve`, 'Publicada')}>Aprobar y publicar</Button>
                        <Button variant="secondary" onClick={() => act(`/apps/${a.id}/reject`, 'Descartada')}>Descartar</Button>
                      </div>
                    )}
                    {admin && a.status === 'active' && (
                      <div className="row"><InlineConfirm label="Despublicar" message="La dirección deja de funcionar. El contenedor sigue en el Docker del agente." confirmLabel="Sí, despublicar" onConfirm={() => act(`/apps/${a.id}/unpublish`, 'Despublicada')} /></div>
                    )}
                  </Card>
                );
              })}
            </div>
          )}
          <DockerCard docker={data.docker} admin={admin} onPrune={prune} />
          <Settings key={JSON.stringify(data.settings)} data={data} accounts={accounts} admin={admin} onSaved={load} />
        </>
      )}
      {toastNode}
    </>
  );
}
