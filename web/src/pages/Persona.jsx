import React, { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import {
  Button,
  Card,
  Combo,
  Drawer,
  Empty,
  InlineConfirm,
  PageHead,
  Segmented,
  Skeleton,
  Switch,
  contactName,
  fmtDate,
  phone,
  useToast,
} from '../components/ui.jsx';
const MODELS = [
  { value: 'sonnet', label: 'Sonnet', description: 'Equilibrado', group: 'Alias' },
  { value: 'opus', label: 'Opus', description: 'Máxima calidad', group: 'Alias' },
  { value: 'haiku', label: 'Haiku', description: 'Rápido y económico', group: 'Alias' },
];
const OTHER_MODEL = '\0other-model';
const OTHER_TIMEZONE = '\0other-timezone';
const TIMEZONES = [
  ['America/Asuncion', 'Asunción · Paraguay'],
  ['America/Argentina/Buenos_Aires', 'Buenos Aires · Argentina'],
  ['America/Sao_Paulo', 'São Paulo · Brasil'],
  ['America/Santiago', 'Santiago · Chile'],
  ['America/Montevideo', 'Montevideo · Uruguay'],
  ['America/Lima', 'Lima · Perú'],
  ['America/Bogota', 'Bogotá · Colombia'],
  ['America/Mexico_City', 'Ciudad de México · México'],
  ['Europe/Madrid', 'Madrid · España'],
].map(([value, label]) => ({ value, label, description: value }));
const modelIdPattern = /^[\w.\[\]-]{1,60}$/;
const ocModelIdPattern = /^[\w.-]+\/[\w.\[\]\/:@-]{1,100}$/; // OpenCode: proveedor/modelo
const ENGINE_OPTIONS = [
  { value: 'claude', label: 'Claude Code', description: 'Modelos de Anthropic con tu suscripción o clave' },
  { value: 'opencode', label: 'OpenCode', description: 'Modelos gratuitos y de más de 75 proveedores' },
];
const MODES = [
  ['default', 'Predeterminado', 'Solo herramientas permitidas; las demás se rechazan.'],
  ['manual', 'Pedir aprobación', 'En WhatsApp no hay quién apruebe: se rechazan.'],
  ['acceptEdits', 'Aceptar ediciones', 'Puede crear y editar archivos.'],
  ['plan', 'Solo planificar', 'Analiza y propone, sin ejecutar.'],
  ['dontAsk', 'No preguntar', 'Rechaza lo no permitido.'],
  ['auto', 'Automático', 'Clasificador de seguridad por acción.'],
  ['bypassPermissions', 'Sin restricciones', 'Acceso completo dentro del contenedor. Riesgo alto.'],
].map(([value, label, description]) => ({ value, label, description }));
const clauseRe = /<!-- kiri:delegacion -->[\s\S]*?<!-- \/kiri:delegacion -->/;
function splitClause(content) {
  const clause = String(content || '').match(clauseRe)?.[0] || '';
  return {
    editable: String(content || '')
      .replace(clauseRe, '')
      .trimEnd(),
    clause,
  };
}
const joinClause = (editable, clause) => (clause ? `${editable.trimEnd()}\n\n${clause}\n` : editable);
const allowanceKey = (value) => (value === null ? 'all' : JSON.stringify([...(value || [])].sort()));
const mcpChip = (value) => {
  if (value === undefined) return 'MCPs sin cargar';
  if (value === null) return 'Todos los MCPs';
  if (!value.length) return 'Sin MCPs';
  return `${value.length} MCP${value.length === 1 ? '' : 's'}`;
};
const skillsChip = (value) => {
  if (value === undefined) return 'Skills sin cargar';
  if (value === null) return 'Todas las skills';
  if (!value.length) return 'Sin skills';
  return `${value.length} skill${value.length === 1 ? '' : 's'}`;
};
const mcpType = { stdio: 'Comando', http: 'HTTP', sse: 'SSE' };
function mcpStatus(server) {
  if (!server.enabled) return 'Desactivado';
  if (server.status === 'ok') {
    const count = server.tools?.length || 0;
    return `Conectado · ${count} herramienta${count === 1 ? '' : 's'}`;
  }
  if (server.status === 'error') return 'Error';
  return 'Sin probar';
}
function PersonaAdaptation({ id, ro }) {
  const [s, setS] = useState(null),
    [all, setAll] = useState([]),
    [saved, setSaved] = useState(''),
    [info, setInfo] = useState(null),
    [msg, setMsg] = useState('');
  const load = () => {
    api('/profiling-settings').then((x) => { setS(x); setSaved(JSON.stringify(x)); }).catch(() => {});
    api('/personas').then(setAll).catch(() => {});
    api('/profile-overview').then(setInfo).catch(() => {});
  };
  useEffect(load, [id]);
  if (!s) return null;
  const pid = Number(id), ids = all.map((p) => p.id);
  const on = s.enabled && (s.personas === null || s.personas.includes(pid));
  const set = (k, v) => setS((x) => ({ ...x, [k]: v }));
  function toggle(v) {
    if (v) setS({ ...s, enabled: true, personas: s.personas === null ? null : [...new Set([...s.personas, pid])] });
    else {
      const rest = (s.personas === null ? ids : s.personas).filter((x) => x !== pid);
      setS({ ...s, enabled: rest.length > 0, personas: rest.length ? rest : null });
    }
  }
  async function save() {
    try { const x = await api('/profiling-settings', { method: 'PUT', body: s }); setS(x); setSaved(JSON.stringify(x)); setMsg(x.enabled && x.auto ? 'Guardado: empezó a estudiar los chats recientes' : 'Guardado'); setTimeout(() => api('/profile-overview').then(setInfo).catch(() => {}), 4000); }
    catch (e) { setMsg(e.message); }
  }
  async function now() {
    try { const r = await api('/profile-backfill', { method: 'POST', body: {} }); setMsg(r.started ? `Estudiando ${r.chats} chats en segundo plano…` : 'Ya hay una generación en curso o la función está apagada'); setTimeout(() => api('/profile-overview').then(setInfo).catch(() => {}), 6000); }
    catch (e) { setMsg(e.message); }
  }
  return (
    <Card title="Adaptación a cada chat">
      <p className="help">
        Opcional. El agente estudia el historial de cada chat y anota cómo es esa persona al hablar (seca, carismática, formal…) para adaptar el tono sin cambiar quién es. Los perfiles se ven y se editan en Memoria, dentro de cada chat.
      </p>
      <Switch title="Adaptarse al chat con esta personalidad" desc="Se aplica a los chats que usan esta personalidad" checked={on} disabled={ro} onChange={toggle} />
      {s.enabled && (
        <>
          <Switch title="Generarlos solos" desc="La primera vez que alguien escribe y cuando se vencen" checked={s.auto} disabled={ro} onChange={(v) => set('auto', v)} />
          <Switch title="Considerar también lo que escribió el dueño" checked={s.includeOwner} disabled={ro} onChange={(v) => set('includeOwner', v)} />
          <Switch title="Incluir grupos" checked={s.groups} disabled={ro} onChange={(v) => set('groups', v)} />
          <div className="row" style={{ gap: 12, flexWrap: 'wrap' }}>
            <label>Mensajes mínimos para generar solo<input type="number" min="1" max="200" disabled={ro} value={s.minMessages} onChange={(e) => set('minMessages', Number(e.target.value))} /></label>
            <label>Mensajes recientes que lee<input type="number" min="30" max="1000" disabled={ro} value={s.maxMessages} onChange={(e) => set('maxMessages', Number(e.target.value))} /></label>
            <label>Renovar cada (días, 0 = nunca)<input type="number" min="0" max="365" disabled={ro} value={s.refreshDays} onChange={(e) => set('refreshDays', Number(e.target.value))} /></label>
          </div>
          <p className="help">Estos valores son comunes a todas las personalidades que usan la adaptación.</p>
        </>
      )}
      {!ro && (
        <div className="row">
          <Button icon="save" disabled={JSON.stringify(s) === saved} onClick={save}>Guardar</Button>
          {s.enabled && <Button variant="secondary" icon="refresh" onClick={now}>Estudiar chats recientes ahora</Button>}
          {msg && <span className="muted">{msg}</span>}
        </div>
      )}
      {s.enabled && info && (
        <p className="help">
          {info.profiles} perfil(es) generados{info.running.length ? ` · generando ${info.running.length}…` : ''}.
          {info.failed.length > 0 && ` Sin perfil todavía: ${info.failed.slice(0, 4).map((f) => `${f.name || f.jid.replace(/^.*::/, '').split('@')[0]} (${f.error})`).join('; ')}.`}
        </p>
      )}
    </Card>
  );
}

function PersonaAccounts({ id, ro }) {
  const [all, setAll] = useState([]),
    [mine, setMine] = useState([]),
    [msg, setMsg] = useState('');
  useEffect(() => {
    let live = true;
    Promise.all([api('/whatsapp/accounts'), api(`/personas/${id}/accounts`)])
      .then(([a, m]) => { if (live) { setAll(a); setMine(m.map((x) => x.instance)); } })
      .catch(() => {});
    return () => { live = false; };
  }, [id]);
  if (all.length < 2) return null;
  async function toggle(instance, on) {
    const next = on ? [...new Set([...mine, instance])] : mine.filter((x) => x !== instance);
    setMine(next);
    try {
      await api(`/personas/${id}/accounts`, { method: 'PUT', body: { instances: next } });
      setMsg('Guardado');
      setAll(await api('/whatsapp/accounts'));
      setMine((await api(`/personas/${id}/accounts`)).map((x) => x.instance));
    } catch (e) {
      setMsg(e.message);
    }
  }
  return (
    <Card title="Números de WhatsApp que atiende">
      <p className="help">
        Los chats que lleguen por los números marcados usan esta personalidad (salvo que un contacto tenga una asignada a mano). Un número solo puede tener una personalidad; si marcás uno que ya tenía otra, pasa a esta.
      </p>
      {all.map((a) => {
        const other = a.persona_id && !mine.includes(a.instance);
        return (
          <Switch key={a.instance} title={a.label || a.instance} desc={`${a.number || ''}${other ? ' · hoy usa otra personalidad' : ''}`.replace(/^ · /, '')} disabled={ro} checked={mine.includes(a.instance)} onChange={(v) => toggle(a.instance, v)} />
        );
      })}
      {msg && <p className="muted">{msg}</p>}
    </Card>
  );
}

function SubAgentBlock({ settings, set, ro }) {
  const eng = settings.subEngine === 'opencode' ? 'opencode' : 'claude', [cat, setCat] = useState([]);
  useEffect(() => {
    if (!settings.subOverride) return undefined;
    let live = true;
    api(eng === 'opencode' ? '/models?engine=opencode' : '/models').then((c) => live && setCat(c.models || [])).catch(() => live && setCat([]));
    return () => { live = false; };
  }, [eng, settings.subOverride]);
  const value = settings.subModel || (eng === 'opencode' ? 'opencode/big-pickle' : 'sonnet');
  const options = cat.some((o) => o.value === value) ? cat : [{ value, label: value, description: 'Valor guardado', group: 'Guardado' }, ...cat];
  const variants = cat.find((m) => m.value === value)?.variants || [];
  return (
    <div className="failover-block">
      <Switch
        title="Usar otro motor o modelo para los sub agentes"
        desc="El trabajo en segundo plano (buscar, crear archivos, armar paneles…) puede usar un modelo más barato o gratuito, y la charla uno más capaz."
        checked={!!settings.subOverride}
        disabled={ro}
        onChange={(v) => set('subOverride')(v)}
      />
      {settings.subOverride && (
        <>
          <Combo label="Motor de los sub agentes" value={eng} disabled={ro} options={ENGINE_OPTIONS} onChange={(v) => { set('subEngine')(v); set('subModel')(''); set('subVariant')(''); }} />
          <Combo label="Modelo de los sub agentes" value={value} disabled={ro} searchable options={options} onChange={(v) => { set('subModel')(v); set('subVariant')(''); }} />
          {eng === 'opencode' && variants.length > 0 && <Combo label="Nivel de razonamiento" value={settings.subVariant || ''} disabled={ro} options={[{ value: '', label: 'Predeterminado' }, ...variants.map((x) => ({ value: x, label: x }))]} onChange={(v) => set('subVariant')(v)} />}
        </>
      )}
    </div>
  );
}

function FailoverBlock({ settings, set, engine, ro }) {
  const other = engine === 'opencode' ? 'claude' : 'opencode', otherName = other === 'opencode' ? 'OpenCode' : 'Claude Code', thisName = engine === 'opencode' ? 'OpenCode' : 'Claude Code';
  const [cat, setCat] = useState([]), [st, setSt] = useState(null), [msg, setMsg] = useState('');
  const loadSt = () => api('/engines').then(setSt).catch(() => {});
  useEffect(() => { loadSt(); }, []);
  useEffect(() => {
    if (!settings.fallbackEnabled) return undefined;
    let live = true;
    api(other === 'opencode' ? '/models?engine=opencode' : '/models').then((c) => live && setCat(c.models || [])).catch(() => live && setCat([]));
    return () => { live = false; };
  }, [other, settings.fallbackEnabled]);
  const def = other === 'opencode' ? 'opencode/big-pickle' : 'sonnet';
  const value = settings.fallbackModel || def;
  const options = cat.some((o) => o.value === value) || !value ? cat : [{ value, label: value, description: 'Valor guardado', group: 'Guardado' }, ...cat];
  const when = (ms) => new Date(ms).toLocaleString('es', { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const paused = ['claude', 'opencode'].filter((e) => st?.[e]?.paused);
  return (
    <div className="failover-block">
      <Switch
        title="Cambiar de motor automáticamente si llega al límite"
        desc={`Si ${thisName} se queda sin cupo, el mismo mensaje sigue con ${otherName}; cuando el cupo se renueva, vuelve solo.`}
        checked={!!settings.fallbackEnabled}
        disabled={ro}
        onChange={(v) => set('fallbackEnabled')(v)}
      />
      {settings.fallbackEnabled && (
        <Combo label={`Modelo de respaldo (${otherName})`} value={value} disabled={ro} searchable options={options} onChange={(v) => set('fallbackModel')(v)} />
      )}
      {paused.map((e) => (
        <p key={e} className="help failover-paused">
          {e === 'opencode' ? 'OpenCode' : 'Claude Code'} está en pausa por su límite de uso hasta {when(st[e].paused.until)}.
          {!ro && <Button variant="ghost" onClick={async () => { await api(`/engines/${e}/resume`, { method: 'POST' }); setMsg('Pausa quitada'); loadSt(); }}>Reintentar ahora</Button>}
        </p>
      ))}
      {msg && <small className="muted">{msg}</small>}
    </div>
  );
}

export default function Persona({ user }) {
  const ro = user.role !== 'admin';
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get('tab') === 'configuracion' ? 'configuracion' : 'personalidades';
  const tabRefs = useRef({});
  const modelInputRef = useRef(null);
  const [settings, setSettings] = useState(null),
    [configMeta, setConfigMeta] = useState(null),
    [configDetail, setConfigDetail] = useState(null),
    [configId, setConfigId] = useState(null),
    [configLoading, setConfigLoading] = useState(false),
    [configError, setConfigError] = useState(''),
    [pendingConfigId, setPendingConfigId] = useState(null),
    [modelCatalog, setModelCatalog] = useState({ models: MODELS, source: null, current: null }),
    [modelsLoading, setModelsLoading] = useState(true),
    [modelsError, setModelsError] = useState(false),
    [customModelOpen, setCustomModelOpen] = useState(false),
    [customModelDraft, setCustomModelDraft] = useState(''),
    [customModelError, setCustomModelError] = useState(''),
    [customTimezoneOpen, setCustomTimezoneOpen] = useState(false),
    [timezoneDraft, setTimezoneDraft] = useState(''),
    [timezoneError, setTimezoneError] = useState(''),
    [skills, setSkills] = useState([]),
    [skillsLoading, setSkillsLoading] = useState(true),
    [skillsError, setSkillsError] = useState(''),
    [skillLog, setSkillLog] = useState([]),
    [skillLogError, setSkillLogError] = useState(''),
    [list, setList] = useState([]),
    [mcpServers, setMcpServers] = useState([]),
    [mcpsLoading, setMcpsLoading] = useState(true),
    [mcpsError, setMcpsError] = useState(''),
    [detail, setDetail] = useState(null),
    [name, setName] = useState(''),
    [md, setMd] = useState(''),
    [mcp, setMcp] = useState(null),
    [lastMcpSelection, setLastMcpSelection] = useState(null),
    [personaSkills, setPersonaSkills] = useState(null),
    [lastSkillsSelection, setLastSkillsSelection] = useState(null),
    [clause, setClause] = useState(''),
    [createOpen, setCreateOpen] = useState(false),
    [newName, setNewName] = useState(''),
    [copy, setCopy] = useState(false),
    [skill, setSkill] = useState(null),
    [pendingSkill, setPendingSkill] = useState(null),
    [pending, setPending] = useState(null),
    [risky, setRisky] = useState(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(true),
    [toast, toastNode] = useToast();
  // Skill updates refresh the catalog without replacing unsaved configuration edits.
  const loadList = async () => {
    const entries = await api('/personas');
    const results = await Promise.allSettled(entries.map((entry) => api(`/personas/${entry.id}`)));
    const enriched = entries.map((entry, index) => ({
      ...entry,
      mcp: results[index].status === 'fulfilled' ? results[index].value.mcp : undefined,
      skills: results[index].status === 'fulfilled' ? results[index].value.skills : undefined,
    }));
    setList(enriched);
    return enriched;
  };
  const loadDetail = (id) =>
    api(`/personas/${id}`).then((p) => {
      setDetail(p);
      setName(p.name);
      const x = splitClause(p.content);
      setMd(x.editable);
      setClause(x.clause);
    });
  async function loadConfig(id) {
    setConfigLoading(true);
    setConfigError('');
    setConfigId(String(id));
    setConfigMeta(null);
    setConfigDetail(null);
    setSettings(null);
    try {
      const [meta, persona] = await Promise.all([api(`/personas/${id}/settings`), api(`/personas/${id}`)]);
      setConfigMeta(meta);
      setSettings(meta.settings);
      setConfigDetail(persona);
      setMcp(persona.mcp ?? null);
      setLastMcpSelection(Array.isArray(persona.mcp) ? persona.mcp : null);
      setPersonaSkills(persona.skills ?? null);
      setLastSkillsSelection(Array.isArray(persona.skills) ? persona.skills : null);
      setCustomModelOpen(false);
      setCustomTimezoneOpen(false);
      setRisky(null);
    } catch (error) {
      setConfigError(error.message);
    } finally {
      setConfigLoading(false);
    }
  }
  const reloadEditor = async (id) => {
    await Promise.all([loadList(), loadDetail(id), loadSkills()]);
  };
  useEffect(() => {
    Promise.all([
      loadList().then(async (l) => {
        if (!l.length) return;
        const defaultId = (l.find((p) => p.is_default) || l[0]).id;
        const requestedId = searchParams.get('persona');
        const selectedId = l.some((p) => String(p.id) === requestedId) ? requestedId : defaultId;
        await Promise.all([loadDetail(defaultId), loadConfig(selectedId)]);
      }),
    ])
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);
  const engineNow = settings?.engine === 'opencode' ? 'opencode' : 'claude';
  useEffect(() => {
    let current = true;
    setModelsLoading(true);
    api(engineNow === 'opencode' ? '/models?engine=opencode' : '/models')
      .then((catalog) => {
        if (!current) return;
        setModelCatalog(catalog);
        setModelsError(false);
      })
      .catch(() => {
        if (current) setModelsError(true);
      })
      .finally(() => {
        if (current) setModelsLoading(false);
      });
    return () => {
      current = false;
    };
  }, [engineNow]);
  function loadMcps() {
    setMcpsLoading(true);
    api('/mcp')
      .then(({ servers }) => {
        setMcpServers(servers);
        setMcpsError('');
      })
      .catch((error) => setMcpsError(error.message))
      .finally(() => setMcpsLoading(false));
  }
  useEffect(() => {
    loadMcps();
  }, []);
  useEffect(() => {
    if (customModelOpen) modelInputRef.current?.focus();
  }, [customModelOpen]);
  function loadSkills() {
    setSkillsLoading(true);
    return Promise.allSettled([api('/skills'), api('/skill-log?limit=50')]).then(([skillResult, logResult]) => {
      if (skillResult.status === 'fulfilled') {
        setSkills(skillResult.value);
        setSkillsError('');
      } else setSkillsError(skillResult.reason.message);
      if (logResult.status === 'fulfilled') {
        setSkillLog(logResult.value);
        setSkillLogError('');
      } else setSkillLogError(logResult.reason.message);
      setSkillsLoading(false);
    });
  }
  useEffect(() => {
    loadSkills();
  }, []);
  const editorDirty =
    detail && (name.trim() !== detail.name || joinClause(md, detail.is_default ? clause : '') !== detail.content);
  const settingsDirty = configMeta && JSON.stringify(settings) !== JSON.stringify(configMeta.settings);
  const allowancesDirty =
    configDetail &&
    (allowanceKey(mcp) !== allowanceKey(configDetail.mcp ?? null) ||
      allowanceKey(personaSkills) !== allowanceKey(configDetail.skills ?? null));
  const configDirty = !!(settingsDirty || allowancesDirty);
  const allowedMcpCount = mcpServers.filter((server) => mcp?.includes(server.name)).length;
  const missingMcps =
    mcpsLoading || mcpsError ? [] : (mcp || []).filter((item) => !mcpServers.some((server) => server.name === item));
  const allowedSkillsCount = skills.filter((item) => personaSkills?.includes(item.name)).length;
  const missingSkills =
    skillsLoading || skillsError
      ? []
      : (personaSkills || []).filter((name) => !skills.some((item) => item.name === name));
  const modelOptions = [...modelCatalog.models];
  if (settings?.model && !modelOptions.some((option) => option.value === settings.model)) {
    modelOptions.unshift({
      value: settings.model,
      label: `Personalizado: ${settings.model}`,
      description: 'Valor guardado actualmente',
      group: engineNow === 'opencode' ? 'Personalizado' : 'Alias',
      monoDescription: true,
    });
  }
  modelOptions.push({ value: OTHER_MODEL, label: 'Otro (ID completo)…', group: engineNow === 'opencode' ? 'Personalizado' : 'Versiones específicas' });
  const timezoneOptions = [...TIMEZONES];
  if (settings?.timezone && !timezoneOptions.some((option) => option.value === settings.timezone)) {
    timezoneOptions.unshift({ value: settings.timezone, label: settings.timezone, description: 'Zona guardada' });
  }
  timezoneOptions.push({ value: OTHER_TIMEZONE, label: 'Otra zona horaria…' });
  function chooseModel(value) {
    if (value !== OTHER_MODEL) {
      set('model')(value);
      set('variant')('');
      setCustomModelOpen(false);
      return;
    }
    setCustomModelDraft(
      modelCatalog.models.some((option) => option.value === settings.model) ? '' : settings.model || '',
    );
    setCustomModelError('');
    setCustomModelOpen(true);
  }
  function applyCustomModel() {
    const value = customModelDraft.trim();
    if (!(engineNow === 'opencode' ? ocModelIdPattern : modelIdPattern).test(value)) {
      setCustomModelError(engineNow === 'opencode' ? 'Usá el formato proveedor/modelo, por ejemplo opencode/big-pickle u openrouter/anthropic/claude-sonnet-4.5.' : 'Usá de 1 a 60 caracteres: letras, números, _, puntos, guiones o corchetes.');
      return;
    }
    set('model')(value);
    setCustomModelOpen(false);
    setCustomModelError('');
  }
  function chooseTimezone(value) {
    if (value !== OTHER_TIMEZONE) {
      set('timezone')(value);
      setCustomTimezoneOpen(false);
      return;
    }
    setTimezoneDraft(settings.timezone || '');
    setTimezoneError('');
    setCustomTimezoneOpen(true);
  }
  function applyTimezone() {
    const value = timezoneDraft.trim();
    try {
      new Intl.DateTimeFormat('es', { timeZone: value });
      set('timezone')(value);
      setCustomTimezoneOpen(false);
      setTimezoneError('');
    } catch {
      setTimezoneError('Escribí una zona IANA válida, por ejemplo America/Asuncion.');
    }
  }
  // Keep the default tab out of the URL while preserving any other search parameters.
  function changeTab(tab) {
    const next = new URLSearchParams(searchParams);
    if (tab === 'personalidades') {
      next.delete('tab');
      next.delete('persona');
    } else {
      next.set('tab', tab);
      if (activeTab !== 'configuracion' && detail?.id) {
        if (String(detail.id) !== configId && configDirty) {
          setPendingConfigId(String(detail.id));
          next.set('persona', configId);
        } else {
          next.set('persona', String(detail.id));
          if (String(detail.id) !== configId) loadConfig(detail.id);
        }
      }
    }
    setSearchParams(next);
  }
  function onTabKeyDown(event) {
    const tabs = ['personalidades', 'configuracion'];
    const current = tabs.indexOf(activeTab);
    let next;
    if (event.key === 'ArrowRight') next = tabs[(current + 1) % tabs.length];
    if (event.key === 'ArrowLeft') next = tabs[(current + tabs.length - 1) % tabs.length];
    if (event.key === 'Home') next = tabs[0];
    if (event.key === 'End') next = tabs[tabs.length - 1];
    if (!next) return;
    event.preventDefault();
    changeTab(next);
    tabRefs.current[next]?.focus();
  }
  async function select(id, force = false) {
    if (id === detail?.id) return;
    if (editorDirty && !force) {
      setPending(id);
      return;
    }
    setPending(null);
    try {
      await loadDetail(id);
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  function chooseMcpMode(mode) {
    if (mode === 'all') {
      if (Array.isArray(mcp)) setLastMcpSelection(mcp);
      setMcp(null);
      return;
    }
    setMcp(lastMcpSelection ?? mcpServers.map((server) => server.name));
  }
  function toggleMcp(name, enabled) {
    const next = enabled ? [...new Set([...(mcp || []), name])] : (mcp || []).filter((item) => item !== name);
    setMcp(next);
    setLastMcpSelection(next);
  }
  function chooseSkillsMode(mode) {
    if (mode === 'all') {
      if (Array.isArray(personaSkills)) setLastSkillsSelection(personaSkills);
      setPersonaSkills(null);
      return;
    }
    setPersonaSkills(lastSkillsSelection ?? skills.map((item) => item.name));
  }
  function togglePersonaSkill(name, enabled) {
    const next = enabled
      ? [...new Set([...(personaSkills || []), name])]
      : (personaSkills || []).filter((item) => item !== name);
    setPersonaSkills(next);
    setLastSkillsSelection(next);
  }
  function chooseConfigPersona(id, force = false) {
    if (String(id) === configId) return;
    if (configDirty && !force) {
      setPendingConfigId(String(id));
      return;
    }
    setPendingConfigId(null);
    const next = new URLSearchParams(searchParams);
    next.set('tab', 'configuracion');
    next.set('persona', String(id));
    setSearchParams(next);
    loadConfig(id);
  }
  async function persistEditor() {
    await api(`/personas/${detail.id}`, {
      method: 'PUT',
      body: { name: name.trim(), content: joinClause(md, detail.is_default ? clause : '') },
    });
  }
  async function persistAllowances() {
    const saved = await api(`/personas/${configId}`, {
      method: 'PUT',
      body: { mcp, skills: personaSkills },
    });
    if (allowanceKey(saved.mcp ?? null) !== allowanceKey(mcp)) {
      throw new Error('El servidor no aplicó la selección de MCPs. Los cambios siguen sin guardar.');
    }
    if (allowanceKey(saved.skills ?? null) !== allowanceKey(personaSkills)) {
      throw new Error('El servidor no aplicó la selección de skills. Los cambios siguen sin guardar.');
    }
  }
  async function saveEditor() {
    try {
      if (editorDirty) await persistEditor();
      await reloadEditor(detail.id);
      toast('Cambios guardados');
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  async function saveConfig() {
    try {
      let adjusted = [];
      if (configDirty) {
        const sent = settings;
        const saved = await api(`/personas/${configId}/settings`, { method: 'PUT', body: { settings } });
        // si el servidor corrigió un valor fuera de rango, avisar en vez de volver al número anterior sin explicación
        const labels = {
          maxTurns: 'Pasos máximos',
          timeoutSec: 'Tiempo límite',
          subagentMaxTurns: 'Pasos del sub agente',
          subagentTimeoutSec: 'Tiempo límite del sub agente',
        };
        adjusted = Object.entries(labels)
          .filter(([key]) => saved?.settings && Number(sent[key]) !== Number(saved.settings[key]))
          .map(([key, label]) => `${label}: ${saved.settings[key]}`);
      }
      if (allowancesDirty) await persistAllowances();
      await Promise.all([loadConfig(configId), loadList(), loadSkills()]);
      toast(
        adjusted.length
          ? `Guardado. Se ajustó al límite permitido → ${adjusted.join(' · ')}`
          : 'Configuración guardada',
      );
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  async function resetConfig() {
    try {
      await api(`/personas/${configId}/settings`, { method: 'DELETE' });
      await loadConfig(configId);
      toast('Ahora usa la configuración general');
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  useEffect(() => {
    const key = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (ro) return;
        if (activeTab === 'configuracion' && configDirty) saveConfig();
        if (activeTab === 'personalidades' && editorDirty) saveEditor();
      }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, [activeTab, editorDirty, configDirty, name, md, mcp, personaSkills, settings, detail, configId]);
  async function create() {
    try {
      const p = await api('/personas', {
        method: 'POST',
        body: {
          name: newName.trim(),
          copyFrom: copy ? detail.id : undefined,
          content: copy ? joinClause(md, detail.is_default ? clause : '') : undefined,
          mcp: copy ? detail.mcp : null,
          skills: copy ? detail.skills : null,
        },
      });
      await loadList();
      await loadDetail(p.id);
      loadSkills();
      setCreateOpen(false);
      setNewName('');
      setCopy(false);
      toast('Personalidad creada');
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  async function makeDefault() {
    try {
      if (editorDirty) await persistEditor();
      const previous = list.find((p) => p.is_default && p.id !== detail.id);
      await api(`/personas/${detail.id}/default`, { method: 'POST' });
      if (previous) {
        const old = await api(`/personas/${previous.id}`);
        await api(`/personas/${previous.id}`, { method: 'PUT', body: { content: splitClause(old.content).editable } });
      }
      await reloadEditor(detail.id);
      if (!configDirty) await loadConfig(configId);
      toast('Personalidad predeterminada actualizada');
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  async function remove() {
    try {
      await api(`/personas/${detail.id}`, { method: 'DELETE' });
      const l = await api('/personas');
      const nextId = (l.find((p) => p.is_default) || l[0]).id;
      await Promise.all([loadList(), loadDetail(nextId)]);
      if (String(configId) === String(detail.id)) await loadConfig(nextId);
      loadSkills();
      toast('Personalidad eliminada');
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  async function restore(id) {
    try {
      const v = await api(`/persona/versions/${id}`);
      setMd(splitClause(v.content).editable);
      toast('Versión cargada; guardá para aplicarla');
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  async function saveSkill() {
    try {
      await api(`/persona/skills/${encodeURIComponent(skill.name)}`, {
        method: 'PUT',
        body: { content: skill.content },
      });
      setSkill(null);
      setPendingSkill(null);
      loadSkills();
      toast('Habilidad guardada');
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  function openSkill(next) {
    if (skill && (skill.isNew || skill.content !== skill.originalContent)) {
      setPendingSkill(next);
      return;
    }
    setSkill(next);
  }
  async function deleteSkill(n) {
    try {
      await api(`/persona/skills/${encodeURIComponent(n)}`, { method: 'DELETE' });
      if (skill?.name === n) setSkill(null);
      loadSkills();
      toast('Habilidad eliminada');
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  const set = (k) => (v) => setSettings((s) => ({ ...s, [k]: v }));
  // cambiar de motor: el modelo vuelve al predeterminado de ese motor (los modelos de uno no existen en el otro)
  const chooseEngine = (engine) => {
    if (engine === settings.engine) return;
    setModelCatalog({ models: [], source: null, current: null });
    setSettings((s) => ({ ...s, engine, model: engine === 'opencode' ? 'opencode/big-pickle' : 'sonnet' }));
    setCustomModelOpen(false);
  };
  function toggleTool(t) {
    const enabled = settings.allowedTools.includes(t);
    if (t === 'Bash' && !enabled) {
      setRisky({ kind: 'tool', value: t });
      return;
    }
    set('allowedTools')(enabled ? settings.allowedTools.filter((x) => x !== t) : [...settings.allowedTools, t]);
  }
  function mode(v) {
    if (v === 'bypassPermissions' && settings.permissionMode !== v) {
      setRisky({ kind: 'mode', value: v });
      return;
    }
    set('permissionMode')(v);
  }
  function approveRisk() {
    if (risky.kind === 'mode') set('permissionMode')(risky.value);
    else set('allowedTools')([...settings.allowedTools, risky.value]);
    setRisky(null);
  }
  if (loading)
    return (
      <>
        <PageHead title="Personalidades" />
        <Skeleton rows={8} />
      </>
    );
  if (error)
    return (
      <>
        <PageHead title="Personalidades" />
        <div className="error-block">
          No se pudieron cargar los datos: {error}
          <Button variant="secondary" onClick={() => location.reload()}>
            Reintentar
          </Button>
        </div>
      </>
    );
  if (!detail) return <Empty title="Sin personalidades" />;
  return (
    <>
      <div className="persona-page-head">
        <PageHead title="Personalidades">
          {!ro && (
            <div className="row">
              {activeTab === 'personalidades' && (
                <Button icon="plus" variant="secondary" onClick={() => setCreateOpen(true)}>
                  Nueva personalidad
                </Button>
              )}
              <Button
                icon="save"
                disabled={activeTab === 'configuracion' ? !configDirty || configLoading : !editorDirty}
                onClick={activeTab === 'configuracion' ? saveConfig : saveEditor}
              >
                Guardar
              </Button>
            </div>
          )}
        </PageHead>
      </div>
      <div className="persona-tabs" role="tablist" aria-label="Secciones de Personalidades" onKeyDown={onTabKeyDown}>
        {[
          ['personalidades', 'Personalidades', editorDirty],
          ['configuracion', 'Configuración', configDirty],
        ].map(([tab, label, changed]) => (
          <button
            key={tab}
            ref={(element) => {
              tabRefs.current[tab] = element;
            }}
            id={`${tab}-tab`}
            type="button"
            role="tab"
            aria-selected={activeTab === tab}
            aria-controls={`${tab}-panel`}
            tabIndex={activeTab === tab ? 0 : -1}
            className={`persona-tab ${activeTab === tab ? 'active' : ''}`}
            onClick={() => changeTab(tab)}
          >
            {label}
            {changed && <span className="persona-tab-dot" aria-label="Cambios sin guardar" />}
          </button>
        ))}
      </div>
      {/* Keep both panels mounted so their controls and inline confirmations retain their state. */}
      <section
        id="personalidades-panel"
        role="tabpanel"
        aria-labelledby="personalidades-tab"
        tabIndex={0}
        hidden={activeTab !== 'personalidades'}
      >
        <div className="persona-layout">
          <div className="card persona-rail" role="list" aria-label="Personalidades">
            {list.map((p) => (
              <button
                className={`persona-row ${p.id === detail.id ? 'active' : ''}`}
                key={p.id}
                onClick={() => select(p.id)}
              >
                <strong>{p.name}</strong>
                <small>
                  {p.is_default ? 'Predeterminada' : `${p.contacts} contacto${p.contacts === 1 ? '' : 's'}`}
                </small>
                <span className="persona-allowance-chips">
                  <span className="persona-mcp-chip">{mcpChip(p.id === configDetail?.id ? mcp : p.mcp)}</span>
                  <span className="persona-mcp-chip">
                    {skillsChip(p.id === configDetail?.id ? personaSkills : p.skills)}
                  </span>
                </span>
              </button>
            ))}
          </div>
          <div className="persona-editor stack">
            <Card title="Editor" action={detail.is_default && <span className="tag">Predeterminada</span>}>
              <label>
                Nombre
                <input maxLength={40} disabled={ro} value={name} onChange={(e) => setName(e.target.value)} />
              </label>
              <label>
                Instrucciones
                <textarea
                  className="editor"
                  disabled={ro}
                  spellCheck={false}
                  value={md}
                  onChange={(e) => setMd(e.target.value)}
                />
              </label>
              <div className="editor-meta">
                <span>Markdown · {md.length.toLocaleString('es-PY')} caracteres</span>
                <span>{editorDirty ? 'Cambios sin guardar' : 'Guardado'}</span>
              </div>
              {detail.is_default && (
                <details className="locked-clause">
                  <summary>Cláusula obligatoria: delegación en sub agentes · Solo lectura</summary>
                  <pre>{clause}</pre>
                </details>
              )}
              {!ro && (
                <div className="row">
                  {!detail.is_default && (
                    <Button variant="secondary" onClick={makeDefault}>
                      Usar como predeterminada
                    </Button>
                  )}
                  {!detail.is_default && (
                    <InlineConfirm
                      label="Eliminar"
                      message={`${detail.contacts.length} contactos pasarán a la predeterminada. ¿Eliminar?`}
                      onConfirm={remove}
                    />
                  )}
                </div>
              )}
              <p className="help">Los contactos notan los cambios en su próximo mensaje.</p>
              <button type="button" className="link" onClick={() => changeTab('configuracion')}>
                Configuración de esta personalidad →
              </button>
            </Card>
            <Card title="Historial de versiones">
              {detail.versions.length ? (
                <ul className="list">
                  {detail.versions.slice(0, 10).map((v) => (
                    <li key={v.id}>
                      <div>
                        <strong>{fmtDate(v.created_at)}</strong>
                        <small>
                          {v.author || 'Sistema'} · {v.size} caracteres
                        </small>
                      </div>
                      {!ro && (
                        <button className="link" onClick={() => restore(v.id)}>
                          Cargar
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="muted">Sin versiones anteriores.</p>
              )}
            </Card>
          </div>
        </div>
      </section>
      <section
        id="configuracion-panel"
        role="tabpanel"
        aria-labelledby="configuracion-tab"
        tabIndex={0}
        hidden={activeTab !== 'configuracion'}
      >
        <div className="config-layout">
          <div className="card config-persona-picker">
            <div>
              <h2>Configuración de personalidad</h2>
              <p className="help">Elegí a qué personalidad se aplican estos ajustes, MCPs y skills.</p>
            </div>
            <Combo
              label="Configuración de"
              value={configId || ''}
              onChange={chooseConfigPersona}
              options={list.map((persona) => ({
                value: String(persona.id),
                label: persona.name,
                description: persona.is_default ? 'Predeterminada · Configuración general' : 'Personalidad',
              }))}
              searchable
            />
            {configDetail && (
              <div className="config-persona-status" aria-live="polite">
                {configMeta?.isDefault && <span className="tag">Predeterminada · Configuración general</span>}
                {!configMeta?.isDefault && (
                  <span className="tag">
                    {configMeta?.inherited ? 'Usa la configuración general' : 'Configuración propia'}
                  </span>
                )}
                {configDirty && <span className="config-unsaved">Cambios sin guardar</span>}
              </div>
            )}
            {pendingConfigId && (
              <div className="inline-confirm" role="alert" aria-live="assertive">
                <span>Hay cambios sin guardar en esta configuración. ¿Descartarlos y cambiar de personalidad?</span>
                <Button variant="danger" onClick={() => chooseConfigPersona(pendingConfigId, true)}>
                  Descartar y cambiar
                </Button>
                <Button variant="ghost" onClick={() => setPendingConfigId(null)}>
                  Seguir editando
                </Button>
              </div>
            )}
            {configMeta?.inherited && (
              <p className="config-inheritance-note">
                Esta personalidad usa la configuración general. Al guardar, tendrá la suya propia.
              </p>
            )}
            {!ro && configMeta && !configMeta.isDefault && !configMeta.inherited && (
              <InlineConfirm
                label="Restablecer a la general"
                message="Se perderán los ajustes propios de esta personalidad y los cambios sin guardar de esta configuración. Volverá a usar la general."
                confirmLabel="Restablecer"
                onConfirm={resetConfig}
              />
            )}
            {configError && (
              <div className="error-block" role="alert">
                No se pudo cargar la configuración.{' '}
                <button type="button" className="link" onClick={() => loadConfig(configId)}>
                  Reintentar
                </button>
              </div>
            )}
          </div>
          {configError ? null : configLoading || !settings ? (
            <Skeleton rows={5} />
          ) : (
            <>
              <PersonaAccounts id={configId} ro={ro} />
              <PersonaAdaptation id={configId} ro={ro} />
              <Card title="MCPs de esta personalidad" className="persona-mcps-card">
                <p className="help">
                  Los sub agentes de esta personalidad solo pueden usar los MCPs permitidos acá. Un MCP desactivado
                  globalmente no se usa aunque esté permitido.
                </p>
                <Segmented
                  label="Acceso a MCPs"
                  value={mcp === null ? 'all' : 'choose'}
                  onChange={chooseMcpMode}
                  options={[
                    { value: 'all', label: 'Todos los MCPs' },
                    { value: 'choose', label: 'Elegir cuáles' },
                  ]}
                  disabled={ro}
                />
                {mcp === null ? (
                  <p className="help">Usa todos los MCPs que estén activados en la configuración global.</p>
                ) : (
                  <div className="persona-mcp-selection">
                    <div className="persona-mcp-selection-head">
                      <strong role="status" aria-live="polite">
                        {allowedMcpCount} de {mcpServers.length} permitidos
                      </strong>
                      {!ro && mcpServers.length > 0 && (
                        <div className="row">
                          <button
                            type="button"
                            className="link"
                            onClick={() => {
                              const all = mcpServers.map((server) => server.name);
                              setMcp(all);
                              setLastMcpSelection(all);
                            }}
                          >
                            Todos
                          </button>
                          <button
                            type="button"
                            className="link"
                            onClick={() => {
                              setMcp([]);
                              setLastMcpSelection([]);
                            }}
                          >
                            Ninguno
                          </button>
                        </div>
                      )}
                    </div>
                    {mcpsLoading ? (
                      <Skeleton rows={2} />
                    ) : mcpsError ? (
                      <p className="persona-mcp-error" role="alert">
                        No se pudo cargar la lista de MCPs.{' '}
                        <button type="button" className="link" onClick={loadMcps}>
                          Reintentar
                        </button>
                      </p>
                    ) : mcpServers.length ? (
                      <div className="persona-mcp-list">
                        {mcpServers.map((server) => {
                          const allowed = mcp.includes(server.name);
                          return (
                            <div className="persona-mcp-row" key={server.name}>
                              <Switch
                                title={server.name}
                                desc={`${mcpType[server.type] || server.type} · ${mcpStatus(server)}`}
                                checked={allowed}
                                onChange={(enabled) => toggleMcp(server.name, enabled)}
                                disabled={ro}
                              />
                              {server.description && <p className="help">{server.description}</p>}
                              {allowed && !server.enabled && (
                                <p className="persona-mcp-warning">
                                  Desactivado globalmente. <Link to="/mcps">Revisar MCPs</Link>
                                </p>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    ) : (
                      <p className="help">
                        Todavía no hay MCPs instalados. <Link to="/mcps">Ir a MCPs</Link> para agregar uno.
                      </p>
                    )}
                    {missingMcps.length > 0 && (
                      <p className="persona-mcp-warning">
                        MCPs permitidos que ya no están instalados: {missingMcps.join(', ')}. Podés quitarlos con
                        “Todos” o “Ninguno”.
                      </p>
                    )}
                  </div>
                )}
              </Card>
              <Card title="Skills de esta personalidad" className="persona-mcps-card">
                <p className="help">
                  El agente de esta personalidad solo puede usar las skills permitidas acá. Las que aprenda solo después
                  de una tarea se agregan a esta lista.
                </p>
                <Segmented
                  label="Acceso a skills"
                  value={personaSkills === null ? 'all' : 'choose'}
                  onChange={chooseSkillsMode}
                  options={[
                    { value: 'all', label: 'Todas las skills' },
                    { value: 'choose', label: 'Elegir cuáles' },
                  ]}
                  disabled={ro || skillsLoading || !!skillsError}
                />
                {personaSkills === null ? (
                  <p className="help">Puede usar todas las skills disponibles, incluidas las nuevas.</p>
                ) : (
                  <div className="persona-mcp-selection">
                    <div className="persona-mcp-selection-head">
                      <strong role="status" aria-live="polite">
                        {allowedSkillsCount} de {skills.length} permitidas
                      </strong>
                      {!ro && skills.length > 0 && (
                        <div className="row">
                          <button
                            type="button"
                            className="link"
                            onClick={() => {
                              const all = skills.map((item) => item.name);
                              setPersonaSkills(all);
                              setLastSkillsSelection(all);
                            }}
                          >
                            Todas
                          </button>
                          <button
                            type="button"
                            className="link"
                            onClick={() => {
                              setPersonaSkills([]);
                              setLastSkillsSelection([]);
                            }}
                          >
                            Ninguna
                          </button>
                        </div>
                      )}
                    </div>
                    {skillsLoading ? (
                      <Skeleton rows={2} />
                    ) : skillsError ? (
                      <p className="persona-mcp-error" role="alert">
                        No se pudo cargar la lista de skills.{' '}
                        <button type="button" className="link" onClick={loadSkills}>
                          Reintentar
                        </button>
                      </p>
                    ) : skills.length ? (
                      <div className="persona-mcp-list">
                        {skills.map((item) => (
                          <div className="persona-mcp-row" key={item.name}>
                            <Switch
                              title={item.name}
                              desc={`${item.origin === 'auto' ? 'Aprendida sola' : 'Manual'} · ${item.size.toLocaleString('es-PY')} caracteres`}
                              checked={personaSkills.includes(item.name)}
                              onChange={(enabled) => togglePersonaSkill(item.name, enabled)}
                              disabled={ro}
                            />
                            {item.description && <p className="help">{item.description}</p>}
                          </div>
                        ))}
                      </div>
                    ) : (
                      <p className="help">Todavía no hay skills. Podés agregarlas en Configuración → Skills.</p>
                    )}
                    {missingSkills.length > 0 && (
                      <p className="persona-mcp-warning">
                        Skills permitidas que ya no están instaladas: {missingSkills.join(', ')}. Podés quitarlas con
                        “Todas” o “Ninguna”.
                      </p>
                    )}
                  </div>
                )}
              </Card>
              <div className="settings-grid">
                <div className="card config-section">
                  <div className="config-intro">
                    <h2>Motor, modelo y límites</h2>
                    <p>Elegí con qué motor trabaja (Claude Code u OpenCode), el modelo y cuánto tiempo puede dedicar a cada respuesta. Por defecto vale para la charla y para los sub agentes; más abajo podés darles otro a los sub agentes.</p>
                  </div>
                  <div className="config-controls">
                    <Combo
                      className="model-combo"
                      label="Motor"
                      value={engineNow}
                      disabled={ro}
                      options={ENGINE_OPTIONS}
                      onChange={chooseEngine}
                    />
                    <Combo
                      className="model-combo"
                      label="Modelo"
                      value={settings.model}
                      disabled={ro}
                      options={modelOptions.map((option) => ({
                        ...option,
                        monoDescription: engineNow === 'claude' && option.group === 'Versiones específicas',
                      }))}
                      onChange={chooseModel}
                      searchable
                    />
                    <div className="model-help" aria-live="polite">
                      {modelsLoading && <span>Cargando modelos… El valor guardado sigue disponible.</span>}
                      {engineNow === 'claude' && modelCatalog.current && <span>Modelo actual de Claude Code: {modelCatalog.current}</span>}
                      {engineNow === 'opencode' && modelCatalog.installed === false && <span>OpenCode no está instalado en este servidor.</span>}
                      {engineNow === 'opencode' && modelCatalog.installed !== false && !modelsLoading && <span>Los modelos marcados «Gratis» no necesitan cuenta. Para usar otros proveedores hay que conectarlos (se verá en «Cuentas y motores»).</span>}
                      {(modelCatalog.source === 'fallback' || modelsError) && (
                        <span>
                          {modelsError
                            ? 'No se pudo consultar la lista de modelos; se muestran las opciones básicas.'
                            : 'Se muestra la lista básica porque no se pudo consultar a Claude Code.'}
                        </span>
                      )}
                    </div>
                    {customModelOpen && !ro && (
                      <div className="model-custom">
                        <label>
                          ID completo del modelo
                          <input
                            ref={modelInputRef}
                            value={customModelDraft}
                            maxLength={engineNow === 'opencode' ? 110 : 60}
                            spellCheck={false}
                            autoComplete="off"
                            aria-invalid={!!customModelError}
                            placeholder={engineNow === 'opencode' ? 'proveedor/modelo' : 'claude-sonnet-5-5'}
                            onChange={(event) => {
                              setCustomModelDraft(event.target.value);
                              setCustomModelError('');
                            }}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter') {
                                event.preventDefault();
                                applyCustomModel();
                              }
                            }}
                          />
                        </label>
                        {customModelError && (
                          <p className="alert" role="alert">
                            {customModelError}
                          </p>
                        )}
                        <div className="row">
                          <Button variant="ghost" onClick={() => setCustomModelOpen(false)}>
                            Cancelar
                          </Button>
                          <Button onClick={applyCustomModel}>Aplicar ID</Button>
                        </div>
                      </div>
                    )}
                    {engineNow === 'opencode' && (modelCatalog.models.find((m) => m.value === settings.model)?.variants || []).length > 0 && (
                      <Combo
                        label="Nivel de razonamiento"
                        value={settings.variant || ''}
                        disabled={ro}
                        options={[{ value: '', label: 'Predeterminado', description: 'El que trae el modelo' }, ...modelCatalog.models.find((m) => m.value === settings.model).variants.map((v) => ({ value: v, label: v }))]}
                        onChange={(v) => set('variant')(v)}
                      />
                    )}
                    <FailoverBlock settings={settings} set={set} engine={engineNow} ro={ro} />
                    <SubAgentBlock settings={settings} set={set} ro={ro} />
                    <div className="two">
                      <label>
                        Pasos máximos
                        <input
                          disabled={ro}
                          type="number"
                          min="1"
                          max="100"
                          value={settings.maxTurns}
                          onChange={(e) => set('maxTurns')(e.target.value)}
                        />
                      </label>
                      <label>
                        Tiempo límite (s)
                        <input
                          disabled={ro}
                          type="number"
                          min="10"
                          max="1800"
                          value={settings.timeoutSec}
                          onChange={(e) => set('timeoutSec')(e.target.value)}
                        />
                      </label>
                    </div>
                    <p className="help">
                      Pasos: 1 a 100. Tiempo: 10 a 1800 s (30 min). Superusuario en contenedor:{' '}
                      <strong>{configMeta?.containerRoot ? 'Activado' : 'Desactivado'}</strong>
                    </p>
                  </div>
                </div>
                <div className="card config-section">
                  <div className="config-intro">
                    <h2>Permisos y herramientas</h2>
                    <p>Definí qué acciones puede ejecutar el agente.</p>
                  </div>
                  <div className="config-controls">
                    <Combo
                      label="Modo de permisos"
                      value={settings.permissionMode || 'default'}
                      disabled={ro}
                      options={MODES}
                      onChange={mode}
                    />
                    {risky && (
                      <div className="inline-confirm">
                        <span>
                          {risky.kind === 'mode'
                            ? 'Acceso completo a comandos y archivos del contenedor. ¿Activar?'
                            : 'Bash permite ejecutar comandos dentro del contenedor. ¿Permitir?'}
                        </span>
                        <Button variant="danger-solid" onClick={approveRisk}>
                          Sí, activar
                        </Button>
                        <Button variant="ghost" onClick={() => setRisky(null)}>
                          No
                        </Button>
                      </div>
                    )}
                    <div className="check-list">
                      {[
                        ['WebSearch', 'Buscar en la web'],
                        ['WebFetch', 'Leer páginas web'],
                        ['Bash', 'Ejecutar comandos'],
                      ].map(([t, l]) => (
                        <Switch
                          key={t}
                          disabled={ro}
                          checked={settings.allowedTools.includes(t)}
                          onChange={() => toggleTool(t)}
                          title={l}
                          desc={t}
                        />
                      ))}
                    </div>
                    <Switch
                      disabled={ro}
                      checked={settings.sendFiles !== false}
                      onChange={set('sendFiles')}
                      title="Crear y enviar archivos"
                      desc="Documentos, imágenes y archivos adjuntos"
                    />
                  </div>
                </div>
                <div className="card config-section">
                  <div className="config-intro">
                    <h2>Sub agentes</h2>
                    <p>Ajustá los límites de cada tarea delegada.</p>
                  </div>
                  <div className="config-controls">
                    <div className="two">
                      <label>
                        Pasos del sub agente
                        <input
                          disabled={ro}
                          type="number"
                          min="5"
                          value={settings.subagentMaxTurns ?? 40}
                          onChange={(e) => set('subagentMaxTurns')(e.target.value)}
                        />
                      </label>
                      <label>
                        Tiempo límite (s)
                        <input
                          disabled={ro}
                          type="number"
                          min="60"
                          max="86400"
                          value={settings.subagentTimeoutSec ?? 900}
                          onChange={(e) => set('subagentTimeoutSec')(e.target.value)}
                        />
                      </label>
                    </div>
                    <p className="help">
                      Estos límites se aplican a cada tarea delegada. Pasos: desde 5, sin tope práctico. Tiempo: 60 s a
                      86400 s (24 horas).
                    </p>
                  </div>
                </div>
                <div className="card config-section">
                  <div className="config-intro">
                    <h2>Ajustes generales</h2>
                    <p>Horario, aprendizaje y memoria. Aplican a todas las personalidades.</p>
                  </div>
                  <div className="config-controls">
                    <Combo
                      label="Zona horaria del agente"
                      value={settings.timezone || 'America/Asuncion'}
                      disabled={ro}
                      options={timezoneOptions}
                      onChange={chooseTimezone}
                      searchable
                    />
                    {customTimezoneOpen && !ro && (
                      <div className="timezone-custom">
                        <label>
                          Otra zona horaria IANA
                          <input
                            value={timezoneDraft}
                            onChange={(event) => {
                              setTimezoneDraft(event.target.value);
                              setTimezoneError('');
                            }}
                            placeholder="America/Asuncion"
                            spellCheck={false}
                          />
                        </label>
                        {timezoneError && (
                          <p className="alert" role="alert">
                            {timezoneError}
                          </p>
                        )}
                        <div className="row">
                          <Button variant="ghost" onClick={() => setCustomTimezoneOpen(false)}>
                            Cancelar
                          </Button>
                          <Button onClick={applyTimezone}>Aplicar</Button>
                        </div>
                      </div>
                    )}
                    <Switch
                      title="Aprender skills automáticamente"
                      desc="Después de una tarea compleja, puede guardar un procedimiento reutilizable."
                      checked={settings.skillLearning !== false}
                      onChange={set('skillLearning')}
                      disabled={ro}
                    />
                    <Switch
                      title="Guardar memoria por su cuenta"
                      desc="Anota datos duraderos y útiles de cada contacto o grupo."
                      checked={settings.memoryAuto !== false}
                      onChange={set('memoryAuto')}
                      disabled={ro}
                    />
                  </div>
                </div>
              </div>
            </>
          )}
          <Card
            title="Skills"
            action={
              !ro && (
                <Button
                  variant="secondary"
                  icon="plus"
                  onClick={() =>
                    openSkill({
                      name: '',
                      content: '---\nname: \ndescription: \n---\n\n',
                      isNew: true,
                      originalContent: '',
                    })
                  }
                >
                  Nueva skill
                </Button>
              )
            }
          >
            <p className="help">
              Después de una tarea compleja el agente revisa cómo la resolvió y, si hay un procedimiento reutilizable,
              crea o mejora una skill. Se instalan globalmente, pero cada personalidad puede tener acceso distinto;
              revisá que no tengan datos personales.
            </p>
            {skillsError && (
              <div className="error-block">
                No se pudieron cargar las skills.{' '}
                <Button variant="secondary" onClick={loadSkills}>
                  Reintentar
                </Button>
              </div>
            )}
            {skillsLoading ? (
              <Skeleton rows={3} />
            ) : skills.length ? (
              <div className="skills-list">
                {skills.map((item) => (
                  <div className="skill-row" key={item.name}>
                    <div>
                      <strong>{item.name}</strong>
                      <p className="help">{item.description || 'Sin descripción'}</p>
                      <div className="skill-meta">
                        <span className="tag">{item.origin === 'auto' ? 'Aprendida sola' : 'Manual'}</span>
                        <span>{item.size.toLocaleString('es-PY')} caracteres</span>
                        <span>{fmtDate(item.updated_at)}</span>
                      </div>
                      <div className="skill-used-by" aria-label={`Personalidades que usan ${item.name}`}>
                        <span>Usada por:</span>
                        {item.used_by?.length === list.length && list.length > 0 ? (
                          <span className="tag">Todas las personalidades</span>
                        ) : item.used_by?.length ? (
                          item.used_by.map((persona) => (
                            <span className="tag" key={persona.id}>
                              {persona.name}
                            </span>
                          ))
                        ) : (
                          <span className="tag">Ninguna personalidad</span>
                        )}
                      </div>
                    </div>
                    <div className="row">
                      <button className="link" onClick={() => openSkill({ ...item, originalContent: item.content })}>
                        {ro ? 'Ver' : 'Editar'}
                      </button>
                      {!ro && (
                        <InlineConfirm
                          label="Eliminar"
                          message={`¿Eliminar la skill ${item.name}? No se puede deshacer.`}
                          onConfirm={() => deleteSkill(item.name)}
                        />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            ) : !skillsError ? (
              <Empty title="Sin skills">Aparecen acá cuando el agente aprende un procedimiento o agregás uno.</Empty>
            ) : null}
            {pendingSkill && (
              <div className="inline-confirm" role="alert">
                <span>Hay cambios sin guardar en la skill abierta. ¿Descartarlos?</span>
                <Button
                  variant="danger"
                  onClick={() => {
                    setSkill(pendingSkill);
                    setPendingSkill(null);
                  }}
                >
                  Descartar y abrir
                </Button>
                <Button variant="ghost" onClick={() => setPendingSkill(null)}>
                  Seguir editando
                </Button>
              </div>
            )}
            {skill && (
              <div className="skill-inline-editor">
                <div className="skill-inline-head">
                  <h3>{skill.isNew ? 'Nueva skill' : `Skill: ${skill.name}`}</h3>
                  {skill.isNew || skill.content !== skill.originalContent ? (
                    <InlineConfirm
                      label="Cerrar"
                      message="Hay cambios sin guardar en esta skill. ¿Descartarlos?"
                      confirmLabel="Descartar"
                      onConfirm={() => setSkill(null)}
                    />
                  ) : (
                    <Button variant="ghost" onClick={() => setSkill(null)}>
                      Cerrar
                    </Button>
                  )}
                </div>
                {skill.isNew && (
                  <label>
                    Identificador
                    <input
                      value={skill.name}
                      onChange={(event) => setSkill({ ...skill, name: event.target.value })}
                      placeholder="ej. precios"
                    />
                  </label>
                )}
                <label>
                  Markdown
                  <textarea
                    className="editor small"
                    spellCheck={false}
                    readOnly={ro}
                    value={skill.content}
                    onChange={(event) => setSkill({ ...skill, content: event.target.value })}
                  />
                </label>
                {!ro && (
                  <Button
                    disabled={!skill.name.trim() || (!skill.isNew && skill.content === skill.originalContent)}
                    onClick={saveSkill}
                  >
                    Guardar skill
                  </Button>
                )}
              </div>
            )}
            <div className="skill-log">
              <h3>Registro de aprendizaje</h3>
              {skillLogError ? (
                <p className="alert">
                  No se pudo cargar el registro.{' '}
                  <button className="link" onClick={loadSkills}>
                    Reintentar
                  </button>
                </p>
              ) : skillLog.length ? (
                <ol>
                  {skillLog.map((entry) => (
                    <li key={entry.id}>
                      <strong>
                        {entry.action === 'create' ? 'Creó' : 'Mejoró'} la skill {entry.name}
                      </strong>
                      {entry.task_id && <span> tras la tarea #{entry.task_id}</span>}
                      {entry.summary && <p>{entry.summary}</p>}
                      <small>{fmtDate(entry.created_at)}</small>
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="muted">Todavía no hay aprendizajes registrados.</p>
              )}
            </div>
          </Card>
        </div>
      </section>
      {createOpen && (
        <Drawer
          title="Nueva personalidad"
          onClose={() => setCreateOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setCreateOpen(false)}>
                Cancelar
              </Button>
              <Button disabled={!newName.trim()} onClick={create}>
                Crear
              </Button>
            </>
          }
        >
          <label>
            Nombre
            <input
              autoFocus
              maxLength={40}
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Ej. Soporte técnico"
            />
          </label>
          <Switch title="Copiar instrucciones, MCPs y skills actuales" checked={copy} onChange={setCopy} />
        </Drawer>
      )}
      {pending && (
        <div
          className="inline-confirm"
          style={{
            position: 'fixed',
            bottom: 24,
            left: 240,
            zIndex: 40,
            background: 'var(--surface)',
            boxShadow: 'var(--shadow)',
          }}
        >
          <span>Tenés cambios sin guardar. ¿Descartarlos?</span>
          <Button variant="danger" onClick={() => select(pending, true)}>
            Descartar
          </Button>
          <Button variant="ghost" onClick={() => setPending(null)}>
            Seguir editando
          </Button>
        </div>
      )}
      {toastNode}
    </>
  );
}
