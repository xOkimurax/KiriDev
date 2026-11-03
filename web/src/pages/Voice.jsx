import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import PersonaScope from '../components/PersonaScope.jsx';
import { Badge, Button, Card, Combo, InlineConfirm, PageHead, Skeleton, Switch, useToast } from '../components/ui.jsx';

const MODES = [
  { value: 'asked', label: 'Solo cuando la persona lo pide' },
  { value: 'mirror', label: 'Cuando lo pide o cuando ella escribe con una nota de voz' },
  { value: 'always', label: 'Siempre que convenga (datos para copiar van por texto)' },
];
const toForm = (s) => ({ ...s, stability: s.stability ?? '', distance: s.distance ?? '' });
const num = (v) => (v === '' || v == null ? null : Number(v));

function play(b64) {
  const a = new Audio(`data:audio/mpeg;base64,${b64}`);
  return a.play();
}

function UsageCard({ ready }) {
  const [u, setU] = useState(null), [busy, setBusy] = useState(false);
  const load = useCallback(async () => { setBusy(true); setU(await api('/voice/usage').catch((e) => ({ ok: false, error: e.message }))); setBusy(false); }, []);
  useEffect(() => { if (ready) load(); }, [ready, load]);
  if (!ready) return null;
  const pct = u?.percent ?? 0, tone = pct >= 90 ? 'var(--danger)' : pct >= 70 ? 'var(--warn)' : 'var(--accent)';
  const when = u?.resetAt ? new Date(u.resetAt).toLocaleDateString('es', { day: 'numeric', month: 'long' }) : null;
  return (
    <Card title="Créditos de ElevenLabs" action={<Button variant="ghost" disabled={busy} onClick={load}>{busy ? 'Consultando…' : 'Actualizar'}</Button>}>
      {!u ? <Skeleton rows={1} /> : !u.ok ? <div className="error-block">{u.error}</div> : (
        <>
          <div role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} style={{ height: 10, borderRadius: 6, background: 'var(--line)', overflow: 'hidden' }}>
            <div style={{ width: `${pct}%`, height: '100%', background: tone }} />
          </div>
          <p><strong>{pct}%</strong> usado · {u.used.toLocaleString('es')} de {u.limit.toLocaleString('es')} créditos · plan {u.tier}</p>
          <small className="help">{when ? `Se reinician el ${when}.` : 'ElevenLabs no informó la fecha de reinicio.'} Los créditos de ElevenLabs se cuentan por caracter de texto (según el modelo puede variar).</small>
        </>
      )}
    </Card>
  );
}

function KeyCard({ admin, status, onChange, toast }) {
  const [key, setKey] = useState(''), [busy, setBusy] = useState(false), [err, setErr] = useState('');
  async function save() {
    setBusy(true); setErr('');
    try { onChange(await api('/voice/key', { method: 'PUT', body: { key } })); setKey(''); toast('Clave de ElevenLabs guardada'); } catch (e) { setErr(e.message); } finally { setBusy(false); }
  }
  return (
    <Card title="Clave de ElevenLabs">
      <div className="row" style={{ gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
        {status.configured ? <Badge tone="ok">Clave cargada</Badge> : <Badge tone="warn">Sin clave</Badge>}
        {status.configured && <span className="muted">{status.hint} · {status.source === 'panel' ? 'cargada desde el panel' : 'viene de la configuración del servidor'}</span>}
        {admin && status.source === 'panel' && (
          <InlineConfirm label="Quitar" message="Se borra la clave: el agente dejará de mandar audios." confirmLabel="Sí, quitar" onConfirm={async () => { onChange(await api('/voice/key', { method: 'DELETE' })); toast('Clave quitada'); }} />
        )}
      </div>
      {admin && (
        <div className="row panel-addrow">
          <label style={{ flex: 1, minWidth: 240 }}>
            {status.configured ? 'Reemplazar la clave' : 'Clave de ElevenLabs (API key)'}
            <input type="password" autoComplete="new-password" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk_…" />
          </label>
          <Button disabled={busy || key.trim().length < 16} onClick={save}>Guardar</Button>
        </div>
      )}
      <small className="help">Se crea en elevenlabs.io → Developers → API Keys (alcanza con el permiso de «Texto a voz»). Queda guardada en el servidor y nunca se vuelve a mostrar completa. Para probarla, usá «Escuchar una muestra» en «Voz y modelo».</small>
      {err && <div className="error-block">{err}</div>}
    </Card>
  );
}

export default function Voice({ user }) {
  const admin = user?.role === 'admin';
  const [data, setData] = useState(null), [f, setF] = useState(null), [saved, setSaved] = useState(''), [error, setError] = useState(''), [t, setT] = useState(null), [toast, toastNode] = useToast();
  const sampleRef = useRef('');
  const [models, setModels] = useState(null), [mError, setMError] = useState(''), [mLoading, setMLoading] = useState(false);
  const [edge, setEdge] = useState(null), [edgeError, setEdgeError] = useState(''), [t2, setT2] = useState(null);
  const [voices, setVoices] = useState(null), [vLoading, setVLoading] = useState(false), [vError, setVError] = useState('');
  const load = useCallback(() => api('/voice').then((d) => { setData(d); setF(toForm(d.settings)); setSaved(JSON.stringify(toForm(d.settings))); setError(''); }).catch((e) => setError(e.message)), []);
  useEffect(() => { load(); }, [load]);
  const loadModels = useCallback(async (fresh) => {
    setMLoading(true); setMError('');
    const r = await api(`/voice/models${fresh ? '?fresh=1' : ''}`).catch((e) => ({ models: [], error: e.message }));
    setModels(r.models); if (r.error) setMError(r.error); setMLoading(false);
  }, []);
  useEffect(() => { if (data?.key?.configured) loadModels(false); }, [data?.key?.configured, loadModels]);
  useEffect(() => { api('/voice/edge-voices').then((r) => { setEdge(r.voices); if (r.error) setEdgeError(r.error); }).catch((e) => setEdgeError(e.message)); }, []);
  if (error) return <><PageHead title="Voz" /><div className="error-block">{error}</div></>;
  if (!f) return <><PageHead title="Voz" /><Skeleton rows={4} /></>;
  const set = (k, v) => setF({ ...f, [k]: v });
  const body = () => ({ ...f, stability: num(f.stability), distance: num(f.distance), speed: Number(f.speed), style: Number(f.style), maxChars: Number(f.maxChars), maxPerDay: Number(f.maxPerDay) });
  const dirty = JSON.stringify(f) !== saved;
  async function save() {
    try { const x = await api('/voice/settings', { method: 'PUT', body: body() }); setF(toForm(x)); setSaved(JSON.stringify(toForm(x))); toast('Configuración guardada'); } catch (e) { toast(e.message, 'err'); }
  }
  async function loadVoices(premade) {
    setVLoading(true); setVError('');
    const r = await api(`/voice/voices${premade ? '?premade=1' : ''}`).catch((e) => ({ voices: [], error: e.message }));
    setVoices(r.voices); if (r.error) setVError(r.error); setVLoading(false);
  }
  async function sampleEdge() {
    setT2({ loading: true });
    const r = await api('/voice/test', { method: 'POST', body: { engine: 'edge', text: sampleRef.current || undefined, settings: { edgeVoice: f.edgeVoice, speed: Number(f.speed) } } }).catch((e) => ({ ok: false, error: e.message }));
    setT2(r);
    if (r.ok) play(r.audio).catch(() => setT2({ ok: false, error: 'No se pudo reproducir el audio en este navegador.' }));
  }
  const el = f.provider !== 'edge'; // ElevenLabs es la voz principal
  const picked = voices?.find((v) => v.id === f.voiceId);
  const model = models?.find((m) => m.id === f.modelId) || null;
  async function sample() {
    setT({ loading: true });
    const r = await api('/voice/test', { method: 'POST', body: { text: sampleRef.current || undefined, settings: body() } }).catch((e) => ({ ok: false, error: e.message }));
    setT(r);
    if (r.ok) play(r.audio).catch(() => setT({ ok: false, error: 'No se pudo reproducir el audio en este navegador.' }));
  }
  return (
    <>
      <PageHead title="Voz">
        <Badge tone={data.settings.enabled && (f.provider === 'edge' || data.key.configured || f.fallback) ? 'ok' : 'neutral'}>{data.settings.enabled ? (f.provider === 'edge' || data.key.configured || f.fallback ? 'Activada' : 'Falta la clave') : 'Desactivada'}</Badge>
      </PageHead>
      <div className="stack">
        <Card title="Notas de voz del agente">
          <p className="help">Opcional. Si la activás, el agente puede responder con una nota de voz, generada con ElevenLabs o con una voz gratuita. El audio sale limpio, como si hablara una persona: sin emojis, sin formato y en primera persona.</p>
          <Switch title="El agente puede mandar notas de voz" disabled={!admin} checked={f.enabled} onChange={(v) => set('enabled', v)} />
          <PersonaScope value={f.personas} disabled={!admin} onChange={(v) => set('personas', v)} />
          <Combo label="Voz principal" disabled={!admin} value={f.provider} onChange={(v) => set('provider', v)}
            options={[{ value: 'elevenlabs', label: 'ElevenLabs (mejor calidad, necesita una cuenta y su clave)' }, { value: 'edge', label: 'Voz gratuita de Microsoft Edge (sin cuenta, sin clave)' }]} />
          {f.provider === 'edge' && <small className="help">Con esta opción no hace falta ninguna cuenta de ElevenLabs: el agente usa la voz gratuita que elegís más abajo.</small>}
          <Combo label="Cuándo manda audios" disabled={!admin} value={f.mode} onChange={(v) => set('mode', v)} options={MODES} />
          <Switch title="Acompañar el audio con un texto breve" desc="Apagado: el audio va solo, sin repetirlo por escrito." disabled={!admin} checked={f.alsoText} onChange={(v) => set('alsoText', v)} />
          <label>
            Cómo tiene que hablar en un audio
            <textarea rows={9} disabled={!admin} value={f.guide} onChange={(e) => set('guide', e.target.value)} />
          </label>
          {admin && f.guide !== data.defaults.guide && <div className="row"><Button variant="ghost" onClick={() => set('guide', data.defaults.guide)}>Restablecer la guía recomendada</Button></div>}
          <small className="help">Esta guía se le da al agente cada vez que puede mandar audios. Además, el servidor limpia el texto antes de generar la voz (quita emojis, formato, enlaces y etiquetas entre corchetes).</small>
        </Card>

        <Card title={f.provider === 'edge' ? 'Velocidad y topes' : 'Voz y modelo'}>
          {f.provider !== 'edge' && admin && (
            <div className="row" style={{ gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
              {voices?.length > 0 && (
                <div style={{ flex: 1, minWidth: 260 }}>
                  <Combo label="Elegir una voz de tu cuenta" searchable value={f.voiceId} onChange={(v) => set('voiceId', v)}
                    options={voices.map((v) => ({ value: v.id, label: `${v.name}${v.labels ? ` · ${v.labels}` : ''} — ${v.premade ? 'predeterminada' : 'de biblioteca (plan de pago)'}` }))} />
                </div>
              )}
              <Button variant="secondary" disabled={vLoading || !data.key.configured} onClick={() => loadVoices(true)}>{vLoading ? 'Cargando…' : 'Cargar voces predeterminadas'}</Button>
              <Button variant="ghost" disabled={vLoading || !data.key.configured} onClick={() => loadVoices(false)}>Cargar todas mis voces</Button>
              {picked?.preview && <Button variant="ghost" onClick={() => new Audio(picked.preview).play().catch(() => {})}>Escuchar esta voz</Button>}
            </div>
          )}
          {el && (<>
          {vError && <div className="error-block">{vError}</div>}
          {voices && !voices.length && !vError && <small className="help">Esta cuenta no devolvió voces.</small>}
          <label>ID de la voz<input disabled={!admin} value={f.voiceId} onChange={(e) => set('voiceId', e.target.value)} spellCheck={false} /></label>
          <small className="help">Elegila de la lista o pegá su ID. Con el plan gratis de ElevenLabs solo funcionan las predeterminadas; las de la biblioteca necesitan un plan de pago.</small>
          <div className="row" style={{ gap: 10, alignItems: 'end', flexWrap: 'wrap' }}>
            <div style={{ flex: 1, minWidth: 260 }}>
              <Combo label="Modelo (los que ofrece ElevenLabs)" disabled={!admin} searchable value={f.modelId} onChange={(v) => set('modelId', v)}
                options={[...(models || []).map((m) => ({ value: m.id, label: `${m.name}${m.alpha ? ' (acceso alfa)' : ''}` })), ...((models || []).some((m) => m.id === f.modelId) ? [] : [{ value: f.modelId, label: f.modelId }])]} />
            </div>
            {admin && <Button variant="ghost" disabled={mLoading || !data.key.configured} onClick={() => loadModels(true)}>{mLoading ? 'Cargando…' : 'Actualizar modelos'}</Button>}
          </div>
          {mError && <div className="error-block">{mError}</div>}
          {!data.key.configured && <small className="help">Cargá la clave para traer la lista de modelos de ElevenLabs.</small>}
          {model?.description && <small className="help">{model.description}{model.maxChars ? ` · hasta ${model.maxChars} caracteres por pedido` : ''}</small>}
          </>)}
          <div className="row panel-addrow">
            {el && (model?.languages?.length ? (
              <Combo label="Idioma" disabled={!admin} searchable value={f.languageCode} onChange={(v) => set('languageCode', v)}
                options={[...model.languages.map((l) => ({ value: l.id, label: `${l.name} (${l.id})` })), ...(model.languages.some((l) => l.id === f.languageCode) ? [] : [{ value: f.languageCode, label: f.languageCode }])]} />
            ) : (
              <label>Idioma (código)<input disabled={!admin} value={f.languageCode} onChange={(e) => set('languageCode', e.target.value)} placeholder="es" /></label>
            ))}
            <label>Velocidad (0,7 a 1,2)<input type="number" step="0.05" min="0.7" max="1.2" disabled={!admin} value={f.speed} onChange={(e) => set('speed', e.target.value)} /></label>
            {el && (<label>Estilo (0 a 1){model && !model.style ? ' · no lo usa este modelo' : ''}<input type="number" step="0.05" min="0" max="1" disabled={!admin || (model && !model.style)} value={f.style} onChange={(e) => set('style', e.target.value)} /></label>)}
          </div>
          <small className="help">La velocidad se aplica sobre el audio ya generado, así que funciona con cualquier voz o modelo.{el ? ' El estilo solo lo usan los modelos que lo soportan (ElevenLabs lo informa).' : ''}</small>
          {el && <div className="row panel-addrow">
            <label>Estabilidad (0 a 1, vacío = la de la voz)<input type="number" step="0.05" min="0" max="1" disabled={!admin} value={f.stability} onChange={(e) => set('stability', e.target.value)} /></label>
            <label>Distancia (0 a 1, vacío = sin efecto)<input type="number" step="0.05" min="0" max="1" disabled={!admin} value={f.distance} onChange={(e) => set('distance', e.target.value)} /></label>
          </div>}
          <div className="row panel-addrow">
            <label>Máximo de caracteres por audio<input type="number" min="100" max="4000" disabled={!admin} value={f.maxChars} onChange={(e) => set('maxChars', e.target.value)} /></label>
            <label>Máximo de audios por día<input type="number" min="1" max="1000" disabled={!admin} value={f.maxPerDay} onChange={(e) => set('maxPerDay', e.target.value)} /></label>
          </div>
          <small className="help">Hoy se generaron {data.usage.n} audio{data.usage.n === 1 ? '' : 's'} ({data.usage.chars} caracteres){data.usage.edge ? `, ${data.usage.edge} con la voz de respaldo` : ''}. El tope diario cuida el gasto de ElevenLabs: al llegar, el respaldo gratis toma el relevo (no cuenta para el tope).</small>
          {admin && !el && <div className="row"><Button icon="save" disabled={!dirty} onClick={save}>Guardar</Button></div>}
          {admin && el && (
            <>
              <label>
                Texto de la muestra (opcional)
                <input placeholder="Hola, soy tu asistente. Así voy a sonar." onChange={(e) => { sampleRef.current = e.target.value; }} />
              </label>
              <div className="row">
                <Button variant="secondary" disabled={t?.loading || !data.key.configured} onClick={sample}>Escuchar una muestra</Button>
                {admin && <Button icon="save" disabled={!dirty} onClick={save}>Guardar</Button>}
              </div>
              {!data.key.configured && <small className="help">Cargá primero la clave de ElevenLabs para poder escuchar la muestra.</small>}
              {t && <p className={t.loading || t.ok ? 'help' : 'alert'} role="status">{t.loading ? 'Generando…' : t.ok ? `✔ Listo (${t.chars} caracteres, ${t.ms < 1000 ? `${t.ms} ms` : `${Math.round(t.ms / 100) / 10} s`}). Usa la configuración que ves ahora, aunque no la hayas guardado.` : `✖ ${t.error}`}</p>}
            </>
          )}
        </Card>

        <Card title={el ? 'Voz de respaldo (gratis)' : 'Voz gratuita (Microsoft Edge)'}>
          {!el && <p className="help">Es la voz principal: no usa ElevenLabs ni ninguna cuenta. Es un servicio gratuito no oficial: el texto del audio pasa por los servidores de Microsoft y podría dejar de funcionar; en ese caso el agente responde por texto.</p>}
          {el && <p className="help">Si ElevenLabs falla, se queda sin créditos o llega al tope diario, el audio se genera con una voz gratuita de Microsoft Edge y el agente sigue mandando notas de voz. Sin clave de ElevenLabs, es la voz que se usa. Es un servicio gratuito no oficial: el texto del audio pasa por los servidores de Microsoft y podría dejar de funcionar; en ese caso el agente responde por texto.</p>}
          {el && <Switch title="Usar la voz de respaldo" disabled={!admin} checked={f.fallback} onChange={(v) => set('fallback', v)} />}
          {(f.fallback || !el) && (
            <>
              <Combo label={el ? 'Voz de respaldo' : 'Voz'} searchable disabled={!admin} value={f.edgeVoice} onChange={(v) => set('edgeVoice', v)}
                options={[...(edge || []).map((v) => ({ value: v.id, label: `${v.name} · ${v.gender} · ${v.place}` })), ...((edge || []).some((v) => v.id === f.edgeVoice) ? [] : [{ value: f.edgeVoice, label: f.edgeVoice }])]} />
              {edgeError && <div className="error-block">{edgeError}</div>}
              {admin && (
                <div className="row">
                  <Button variant="secondary" disabled={t2?.loading} onClick={sampleEdge}>{el ? 'Escuchar el respaldo' : 'Escuchar una muestra'}</Button>
                  <Button icon="save" disabled={!dirty} onClick={save}>Guardar</Button>
                </div>
              )}
              {t2 && <p className={t2.loading || t2.ok ? 'help' : 'alert'} role="status">{t2.loading ? 'Generando…' : t2.ok ? `✔ Listo (${t2.ms < 1000 ? `${t2.ms} ms` : `${Math.round(t2.ms / 100) / 10} s`}). La velocidad que ves se aplica también al respaldo.` : `✖ ${t2.error}`}</p>}
            </>
          )}
        </Card>

        {el && <UsageCard ready={data.key.configured} />}
        {el && <KeyCard admin={admin} status={data.key} onChange={(key) => setData({ ...data, key })} toast={toast} />}
      </div>
      {toastNode}
    </>
  );
}
