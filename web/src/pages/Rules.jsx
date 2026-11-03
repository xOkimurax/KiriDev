import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import {
  Button,
  Card,
  Combo,
  Icon,
  PageHead,
  Segmented,
  Skeleton,
  Switch,
  relative,
  useToast,
} from '../components/ui.jsx';
import NumberList, { clean } from '../components/NumberList.jsx';
import Outreach from '../components/Outreach.jsx';
function KeywordChips({ items, onChange, disabled }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  function add() {
    const words = text
      .split(/[,;\n]+/)
      .map((word) => word.trim().toLocaleLowerCase())
      .filter(Boolean);
    if (words.some((word) => word.length < 2 || word.length > 40)) {
      setError('Cada palabra debe tener entre 2 y 40 caracteres.');
      return;
    }
    const next = [...new Set([...items, ...words])];
    if (next.length > 20) {
      setError('Podés guardar hasta 20 palabras clave.');
      return;
    }
    onChange(next);
    setText('');
    setError('');
  }
  return (
    <div className="chip-editor group-keywords">
      <span className="field-label">Palabras clave extra</span>
      <div className="chips" aria-label="Palabras clave que invocan al agente">
        {items.length ? (
          items.map((word) => (
            <span className="number-chip" key={word}>
              {word}
              {!disabled && (
                <button
                  type="button"
                  aria-label={`Quitar ${word}`}
                  onClick={() => onChange(items.filter((item) => item !== word))}
                >
                  <Icon name="close" size={13} />
                </button>
              )}
            </span>
          ))
        ) : (
          <span className="muted">Sin palabras extra.</span>
        )}
      </div>
      {!disabled && (
        <div className="row">
          <input
            aria-label="Agregar palabras clave"
            value={text}
            onChange={(event) => {
              setText(event.target.value);
              setError('');
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                add();
              }
            }}
            placeholder="Ej. kiri, asistente"
          />
          <Button variant="secondary" disabled={!text.trim()} onClick={add}>
            Agregar
          </Button>
        </div>
      )}
      {error && (
        <small className="alert" role="alert">
          {error}
        </small>
      )}
      <small className="help">Separá varias palabras con coma. También puede mencionarlo con @ en WhatsApp.</small>
    </div>
  );
}
const groupOptions = [
  { value: '', label: 'Usar el modo general' },
  { value: 'all', label: 'Responder a todo' },
  { value: 'mention', label: 'Solo si me mencionan' },
  { value: 'context', label: 'Por contexto' },
  { value: 'off', label: 'Silenciar' },
];
const anyFilter = {
  key: 'any',
  label: 'Cualquier mención',
  icon: 'user',
  description:
    'Responde siempre que lo mencionen, sin importar si es texto, audio, foto, video, archivo, sticker o emojis.',
};
const filterDefinitions = [
  {
    key: 'text',
    label: 'Texto',
    plural: 'texto',
    icon: 'chat',
    description: 'Mensajes escritos donde lo mencionan o invocan.',
  },
  {
    key: 'audio',
    label: 'Audio',
    plural: 'audio',
    icon: 'audio',
    description: 'Notas de voz o audios donde dicen su nombre o una palabra clave.',
  },
  {
    key: 'image',
    label: 'Foto',
    plural: 'fotos',
    icon: 'image',
    description: 'Fotos enviadas junto con una mención.',
  },
  {
    key: 'video',
    label: 'Video',
    plural: 'videos',
    icon: 'video',
    description: 'Videos enviados junto con una mención.',
  },
  {
    key: 'document',
    label: 'Archivo o documento',
    plural: 'archivos',
    icon: 'file',
    description: 'Archivos o documentos enviados junto con una mención.',
  },
  {
    key: 'sticker',
    label: 'Sticker',
    plural: 'stickers',
    icon: 'image',
    description: 'Stickers con una mención.',
  },
  {
    key: 'emojiReply',
    label: 'Respuestas con solo emojis',
    plural: 'respuestas con solo emojis',
    icon: 'chat',
    description: 'Cuando citan un mensaje suyo usando solo emojis. Podés evitar respuestas a 👍.',
  },
];
const filterDefaults = Object.fromEntries(
  ['any', ...filterDefinitions.map(({ key }) => key)].map((key) => [key, true]),
);
const overrideChoices = [
  { value: 'general', label: 'Como el general' },
  { value: 'yes', label: 'Sí' },
  { value: 'no', label: 'No' },
];
function normalizeFilterRules(rules) {
  const filter = { ...filterDefaults, ...(rules.groupFilter || {}) };
  const overrides = Object.fromEntries(
    Object.entries(rules.groupFilterOverrides || {})
      .map(([jid, values]) => [
        jid,
        Object.fromEntries(
          Object.keys(filterDefaults)
            .filter((key) => typeof values?.[key] === 'boolean' && values[key] !== filter[key])
            .map((key) => [key, values[key]]),
        ),
      ])
      .filter(([, values]) => Object.keys(values).length),
  );
  return { ...rules, groupFilter: filter, groupFilterOverrides: overrides };
}
function filterSummary(rules) {
  const { groupFilter: filter } = rules;
  const context =
    rules.groupMode === 'context' ? ' Por contexto, también responde si continúan una charla reciente con él.' : '';
  if (filter.any) return `Responderá a cualquier mención, de cualquier tipo.${context}`;

  const enabled = filterDefinitions.filter(({ key }) => filter[key]).map(({ plural }) => plural);
  const ignored = filterDefinitions.filter(({ key }) => !filter[key]).map(({ plural }) => plural);
  const ways = ['@'];
  if (rules.groupReplyToBot !== false) ways.push('respuestas a mensajes suyos');
  if (rules.groupUseName !== false) ways.push('su nombre');
  if (rules.groupKeywords?.length) ways.push(`palabras clave como «${rules.groupKeywords[0]}»`);

  const introduction = enabled.length
    ? `Responderá cuando lo mencionen (${ways.join(', ')}) en mensajes de: ${enabled.join(', ')}.`
    : 'No responderá a ninguna mención con el filtro actual.';
  return `${introduction} Ignorará menciones en: ${ignored.join(', ')}.${context}`;
}
function FilterSwitch({ filter, checked, onChange, disabled, primary = false }) {
  return (
    <div className={`group-filter-item ${primary ? 'primary' : ''}`}>
      <span className="group-filter-icon">
        <Icon name={filter.icon} size={18} />
      </span>
      <Switch
        title={filter.label}
        desc={filter.description}
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
    </div>
  );
}
function FilterOverrideChoice({ jid, filter, value, onChange, disabled }) {
  return (
    <div className="group-filter-override-row">
      <span className="group-filter-override-name">
        <Icon name={filter.icon} size={16} /> {filter.label}
      </span>
      <fieldset className="filter-override-control" disabled={disabled}>
        <legend className="sr-only">
          {filter.label} en {jid}
        </legend>
        {overrideChoices.map((choice) => (
          <label className={value === choice.value ? 'active' : ''} key={choice.value}>
            <input
              type="radio"
              name={`filter-${jid}-${filter.key}`}
              value={choice.value}
              checked={value === choice.value}
              onChange={() => onChange(choice.value)}
            />
            <span>{choice.label}</span>
          </label>
        ))}
      </fieldset>
    </div>
  );
}
const privateDescriptions = {
  text: 'Mensajes escritos.',
  audio: 'Notas de voz y audios (se transcriben).',
  image: 'Fotos.',
  video: 'Videos.',
  document: 'Archivos y documentos.',
  sticker: 'Stickers.',
  emojiReply: 'Cuando citan un mensaje suyo usando solo emojis. Podés evitar respuestas a 👍.',
};
function TypeFilter({ value, onChange, disabled }) {
  return (
    <div className="group-filter-type-list">
      {filterDefinitions.map((filter) => (
        <div className="group-filter-card" key={filter.key}>
          <FilterSwitch
            filter={{ ...filter, description: privateDescriptions[filter.key] }}
            checked={value?.[filter.key] !== false}
            onChange={(enabled) => onChange({ ...value, [filter.key]: enabled })}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  );
}
const typesIgnored = (f) => filterDefinitions.filter(({ key }) => f?.[key] === false).map(({ plural }) => plural);
const shortGroupId = (jid) => `…${String(jid).split('@')[0].slice(-8)}`;
export default function Rules({ user }) {
  const ro = user.role !== 'admin';
  const [r, setR] = useState(null),
    [orig, setOrig] = useState(''),
    [groups, setGroups] = useState([]),
    [groupsLoading, setGroupsLoading] = useState(true),
    [groupsError, setGroupsError] = useState(''),
    [mentionExpanded, setMentionExpanded] = useState(false),
    [expandedGroups, setExpandedGroups] = useState({}),
    [error, setError] = useState(''),
    [accounts, setAccounts] = useState([]),
    [contacts, setContacts] = useState([]),
    [fromEvo, setFromEvo] = useState(true),
    [inst, setInst] = useState(''),
    [members, setMembers] = useState([]),
    [groupMembers, setGroupMembers] = useState({}),
    [memberPanels, setMemberPanels] = useState({}),
    [toast, toastNode] = useToast();
  const qs = inst ? `?instance=${encodeURIComponent(inst)}` : '';
  const load = () =>
    api('/rules' + qs)
      .then((x) => {
        const normalized = normalizeFilterRules(x);
        setR(normalized);
        setOrig(JSON.stringify(normalized));
        setError('');
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    api('/whatsapp/accounts').then(setAccounts).catch(() => {});
  }, []);
  useEffect(() => {
    api('/contacts' + qs).then((r) => { setContacts(r.contacts.map((c) => ({ jid: `${c.number}@s.whatsapp.net`, wa_jid: `${c.number}@s.whatsapp.net`, name: c.name, instance: c.instance }))); setFromEvo(r.fromEvolution); }).catch(() => {});
  }, [inst]);
  useEffect(() => {
    setR(null);
    load();
    loadGroups();
    setGroupMembers({});
  }, [inst]);
  // miembros de los grupos de la(s) línea(s): sirven para elegir a quién se le permite activarlo
  useEffect(() => {
    const instances = inst ? [inst] : accounts.length ? accounts.map((a) => a.instance) : [''];
    Promise.all(instances.map((i) => api(`/groups/members?instance=${encodeURIComponent(i)}`).catch(() => [])))
      .then((all) => setMembers([...new Map(all.flat().map((m) => [m.number, m])).values()]))
      .catch(() => {});
  }, [inst, accounts]);
  function toggleMemberPanel(group) {
    const open = !memberPanels[group.jid];
    setMemberPanels((c) => ({ ...c, [group.jid]: open }));
    if (open && !groupMembers[group.jid])
      api(`/groups/members?instance=${encodeURIComponent(group.instance || '')}&jid=${encodeURIComponent(group.jid)}`)
        .then((list) => setGroupMembers((c) => ({ ...c, [group.jid]: list })))
        .catch(() => setGroupMembers((c) => ({ ...c, [group.jid]: [] })));
  }
  const nameByNumber = new Map(contacts.map((c) => [clean(c.wa_jid || c.jid), c.name]));
  const asContacts = (list) => (list || []).map((m) => ({ jid: `${m.number}@s.whatsapp.net`, wa_jid: `${m.number}@s.whatsapp.net`, name: nameByNumber.get(m.number) || null }));
  function setMemberOverride(jid, patch) {
    setR((current) => {
      const next = { ...(current.groupMemberOverrides || {}) };
      if (patch === null) delete next[jid];
      else next[jid] = { ...(next[jid] || {}), ...patch };
      return { ...current, groupMemberOverrides: next };
    });
  }
  function loadGroups() {
    setGroupsLoading(true);
    api('/groups' + qs)
      .then((items) => {
        setGroups(items.map((g) => ({ ...g, jid: g.wa_jid || g.jid })));
        setGroupsError('');
      })
      .catch((error) => setGroupsError(error.message))
      .finally(() => setGroupsLoading(false));
  }
  const set = (k) => (v) => setR((x) => ({ ...x, [k]: v }));
  const privateContacts = contacts;
  function setGroupOverride(jid, value) {
    setR((current) => {
      const overrides = { ...(current.groupOverrides || {}) };
      if (value) overrides[jid] = value;
      else delete overrides[jid];
      return { ...current, groupOverrides: overrides };
    });
  }
  function setFilter(key, enabled) {
    setR((current) => ({
      ...current,
      groupFilter: { ...current.groupFilter, [key]: enabled },
    }));
  }
  function setGroupFilterOverride(jid, key, choice) {
    setR((current) => {
      const perGroup = { ...(current.groupFilterOverrides?.[jid] || {}) };
      if (choice === 'general' || (choice === 'yes') === current.groupFilter[key]) delete perGroup[key];
      else perGroup[key] = choice === 'yes';
      const overrides = { ...(current.groupFilterOverrides || {}) };
      if (Object.keys(perGroup).length) overrides[jid] = perGroup;
      else delete overrides[jid];
      return { ...current, groupFilterOverrides: overrides };
    });
  }
  function resetGroupFilter(jid) {
    setR((current) => {
      const next = { ...(current.groupFilterOverrides || {}) };
      delete next[jid];
      return { ...current, groupFilterOverrides: next };
    });
  }
  async function save() {
    try {
      const x = normalizeFilterRules(await api('/rules' + qs, { method: 'PUT', body: normalizeFilterRules(r) }));
      setR(x);
      setOrig(JSON.stringify(x));
      toast('Reglas guardadas');
    } catch (e) {
      toast(e.message, 'err');
    }
  }
  const chatScope =
    r?.mode === 'allowlist' || !r?.privateChats
      ? 'solo números permitidos'
      : `chats individuales · ${r.newContacts ? 'contactos nuevos' : 'solo conocidos'}`;
  const groupModeLabel = {
    all: 'todos los mensajes',
    mention: 'según filtro de menciones',
    context: 'por contexto',
  }[r?.groupMode];
  const groupScope = r?.groups ? `grupos: ${groupModeLabel || 'todos los mensajes'}${r.groupMemberMode === 'allowlist' ? ' (solo miembros de la lista)' : ''}` : 'sin grupos';
  const scope = r
    ? `${chatScope} · ${groupScope}${r.blocklist?.length ? ` · ${r.blocklist.length} bloqueados` : ''}`
    : '';
  return (
    <>
      <PageHead title="Reglas de respuesta">
        {!ro && (
          <Button icon="save" disabled={!r || JSON.stringify(r) === orig} onClick={save}>
            Guardar
          </Button>
        )}
      </PageHead>
      {accounts.length > 1 && (
        <Card title="Aplicar a">
          <div className="row">
            <Combo
              label="Número"
              value={inst}
              onChange={setInst}
              options={[{ value: '', label: 'Todos los números (reglas generales)' }, ...accounts.map((a) => ({ value: a.instance, label: a.label || a.instance }))]}
            />
            {inst && !ro && (
              <Button
                variant="secondary"
                disabled={!r?._overridden?.length}
                onClick={async () => {
                  try {
                    await api('/rules' + qs, { method: 'DELETE' });
                    toast('Este número vuelve a usar las reglas generales');
                    load();
                  } catch (e) {
                    toast(e.message, 'err');
                  }
                }}
              >
                Restablecer a lo general
              </Button>
            )}
          </div>
          <p className="muted">
            {inst
              ? r?._overridden?.length
                ? `Este número tiene ${r._overridden.length} ajuste(s) propio(s) (${r._overridden.join(', ')}); el resto lo hereda de las reglas generales.`
                : 'Este número usa las reglas generales. Lo que cambies acá y guardes solo vale para esta línea.'
              : 'Estas son las reglas generales: valen para todos los números que no tengan ajustes propios.'}
          </p>
        </Card>
      )}
      {error ? (
        <div className="error-block">
          No se pudieron cargar las reglas: {error}
          <Button variant="secondary" onClick={load}>
            Reintentar
          </Button>
        </div>
      ) : !r ? (
        <Skeleton rows={6} />
      ) : (
        <>
          <div className="scope-summary">Responde a: {scope}</div>
          <div className="rules-layout">
            <div className="grid-2">
              <Card title="Tipos de chat">
                <Switch
                  title="Chats individuales"
                  desc="Conversaciones uno a uno"
                  checked={r.privateChats}
                  onChange={set('privateChats')}
                  disabled={ro}
                />
                <Switch
                  title="Contactos nuevos"
                  desc="Personas que escriben por primera vez"
                  checked={r.newContacts}
                  onChange={set('newContacts')}
                  disabled={ro}
                />
              </Card>
              <Card title="Alcance">
                <Segmented
                  label="Quién puede escribir"
                  value={r.mode}
                  disabled={ro}
                  onChange={set('mode')}
                  options={[
                    { value: 'everyone', label: 'Todos' },
                    { value: 'allowlist', label: 'Solo lista permitida' },
                  ]}
                />
                <p className="help">La lista bloqueada siempre tiene prioridad.</p>
              </Card>
            </div>
            {r.privateChats && (
              <Card title="Mensajes que responde en chats individuales">
                <Switch
                  title="Filtrar por tipo de mensaje"
                  desc="Opcional. Apagado, responde a todos los tipos. Encendido, solo a los que dejes activados; lo demás se guarda en el historial pero no se contesta."
                  checked={!!r.privateFilterOn}
                  onChange={set('privateFilterOn')}
                  disabled={ro}
                />
                {r.privateFilterOn && (
                  <>
                    <TypeFilter value={r.privateFilter} onChange={set('privateFilter')} disabled={ro} />
                    <p className="group-filter-summary" aria-live="polite">
                      {typesIgnored(r.privateFilter).length ? `No responderá a: ${typesIgnored(r.privateFilter).join(', ')}.` : 'Responde a todos los tipos.'}
                    </p>
                  </>
                )}
                <Switch
                  title="Filtro propio para contactos nuevos"
                  desc={r.newContacts ? 'Opcional. Mientras alguien no sea un contacto conocido, se usa este filtro en lugar del de arriba. Cuando ya lo conoce, pasa al filtro de chats individuales.' : 'Los contactos nuevos están desactivados arriba: no responde a quien escribe por primera vez.'}
                  checked={!!r.newFilterOn}
                  onChange={set('newFilterOn')}
                  disabled={ro || !r.newContacts}
                />
                {r.newFilterOn && r.newContacts && (
                  <>
                    <TypeFilter value={r.newFilter} onChange={set('newFilter')} disabled={ro} />
                    <p className="group-filter-summary" aria-live="polite">
                      {typesIgnored(r.newFilter).length ? `A los contactos nuevos no les responderá: ${typesIgnored(r.newFilter).join(', ')}.` : 'A los contactos nuevos les responde todos los tipos.'}
                    </p>
                  </>
                )}
                <p className="help">Los números de la lista permitida siempre reciben respuesta, sin filtro.</p>
              </Card>
            )}
            <Card title="Demora de respuesta">
              <Switch
                title="Esperar antes de responder"
                desc="Opcional. Hace que el agente conteste con una pausa, como una persona. Se descuenta lo que tarda en pensar."
                checked={!!r.replyDelay?.enabled}
                onChange={(v) => set('replyDelay')({ ...(r.replyDelay || { min: 5, max: 5, unit: 's' }), enabled: v })}
                disabled={ro}
              />
              {r.replyDelay?.enabled && (
                <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
                  <label>
                    Mínimo
                    <input type="number" min="0" disabled={ro} value={r.replyDelay.min} onChange={(e) => { const min = Number(e.target.value); set('replyDelay')({ ...r.replyDelay, min, max: Math.max(min, r.replyDelay.max) }); }} />
                  </label>
                  <label>
                    Máximo
                    <input type="number" min="0" disabled={ro} value={r.replyDelay.max} onChange={(e) => set('replyDelay')({ ...r.replyDelay, max: Number(e.target.value) })} />
                  </label>
                  <Combo
                    label="Unidad"
                    value={r.replyDelay.unit}
                    disabled={ro}
                    onChange={(unit) => set('replyDelay')({ ...r.replyDelay, unit })}
                    options={[{ value: 's', label: 'Segundos' }, { value: 'min', label: 'Minutos' }]}
                  />
                </div>
              )}
              <p className="help">Si el mínimo y el máximo son distintos, cada respuesta espera un tiempo al azar entre los dos. Tope: 60 minutos. Se configura por número con el selector de arriba.</p>
            </Card>
            <Card title="Grupos" className="rules-groups-card">
              <Switch
                title="Responder en grupos"
                desc="Se aplica a los grupos donde está la línea de WhatsApp."
                checked={r.groups}
                onChange={set('groups')}
                disabled={ro}
              />
              {r.groups && (
                <div className="rules-group-settings">
                  <fieldset className="group-mode-choices">
                    <legend>Modo general para grupos</legend>
                    <label className={`group-mode-choice ${r.groupMode === 'all' ? 'active' : ''}`}>
                      <input
                        type="radio"
                        name="group-mode"
                        value="all"
                        checked={r.groupMode === 'all'}
                        onChange={() => set('groupMode')('all')}
                        disabled={ro}
                      />
                      <strong>Responder a todo</strong>
                      <small>El agente participa en cada mensaje del grupo.</small>
                    </label>
                    <label className={`group-mode-choice ${r.groupMode === 'mention' ? 'active' : ''}`}>
                      <input
                        type="radio"
                        name="group-mode"
                        value="mention"
                        checked={r.groupMode === 'mention'}
                        onChange={() => set('groupMode')('mention')}
                        disabled={ro}
                      />
                      <strong>Solo si me mencionan</strong>
                      <small>
                        Lee y recuerda todo lo que se habla. Contesta si lo mencionan y el tipo de mensaje está
                        permitido por el filtro de abajo.
                      </small>
                    </label>
                    <label className={`group-mode-choice ${r.groupMode === 'context' ? 'active' : ''}`}>
                      <input
                        type="radio"
                        name="group-mode"
                        value="context"
                        checked={r.groupMode === 'context'}
                        onChange={() => set('groupMode')('context')}
                        disabled={ro}
                      />
                      <strong>Por contexto</strong>
                      <small>
                        Responde cuando lo mencionan y también cuando le siguen la charla: si venía hablando con alguien
                        y esa persona sigue pasándole datos del tema, contesta sin necesidad de mencionarlo. Lee y
                        recuerda todo el grupo.
                      </small>
                    </label>
                  </fieldset>
                  <div className="group-mention-options">
                    <h3>Quién puede activarlo</h3>
                    <Segmented
                      label="Miembros del grupo"
                      value={r.groupMemberMode}
                      disabled={ro}
                      onChange={set('groupMemberMode')}
                      options={[
                        { value: 'everyone', label: 'Cualquier miembro' },
                        { value: 'allowlist', label: 'Solo miembros de la lista' },
                      ]}
                    />
                    {r.groupMemberMode === 'allowlist' && (
                      <NumberList
                        bare
                        title="Miembros permitidos"
                        items={r.groupMembers || []}
                        onChange={set('groupMembers')}
                        disabled={ro}
                        contacts={[...asContacts(members), ...contacts]}
                        empty="Sin miembros: con la lista vacía no le responde a nadie en los grupos."
                        hint="Es la lista general: sirve para todos los grupos que no tengan una propia. Los demás miembros se leen (el agente recuerda lo que dicen) pero no se les contesta."
                      />
                    )}
                    <p className="help">Cada grupo puede cambiarlo en «Personalizar por grupo».</p>
                  </div>
                  {['mention', 'context'].includes(r.groupMode) && (
                    <div className="group-mention-options">
                      <h3>Cuándo responde</h3>
                      <div className="group-filter-card">
                        <FilterSwitch
                          filter={anyFilter}
                          primary
                          checked={r.groupFilter.any}
                          onChange={(enabled) => setFilter('any', enabled)}
                          disabled={ro}
                        />
                        <button
                          type="button"
                          className="link group-filter-expand"
                          aria-expanded={mentionExpanded}
                          aria-controls="mention-details"
                          onClick={() => setMentionExpanded(!mentionExpanded)}
                        >
                          {mentionExpanded
                            ? 'Ocultar menciones y palabras clave'
                            : 'Configurar menciones y palabras clave'}
                        </button>
                        {mentionExpanded && (
                          <div id="mention-details" className="group-mention-details">
                            <p className="help">
                              En WhatsApp, escribí @ y elegí el contacto del agente para mencionarlo.
                            </p>
                            <Switch
                              title="Cuando responden a un mensaje suyo"
                              desc="También cuenta como mención si alguien cita una respuesta del agente."
                              checked={r.groupReplyToBot !== false}
                              onChange={set('groupReplyToBot')}
                              disabled={ro}
                            />
                            <Switch
                              title="Cuando dicen su nombre"
                              desc="Reconoce el nombre de perfil de la línea de WhatsApp."
                              checked={r.groupUseName !== false}
                              onChange={set('groupUseName')}
                              disabled={ro}
                            />
                            <KeywordChips items={r.groupKeywords || []} onChange={set('groupKeywords')} disabled={ro} />
                          </div>
                        )}
                      </div>
                      <div className={`group-filter-types ${r.groupFilter.any ? 'is-disabled' : ''}`}>
                        <h4>Responder a menciones que vengan en…</h4>
                        {r.groupFilter.any && (
                          <p className="help">Con “Cualquier mención” encendido responde a todos los tipos.</p>
                        )}
                        <div className="group-filter-type-list">
                          {filterDefinitions.map((filter) => (
                            <div className="group-filter-card" key={filter.key}>
                              <FilterSwitch
                                filter={filter}
                                checked={r.groupFilter[filter.key]}
                                onChange={(enabled) => setFilter(filter.key, enabled)}
                                disabled={ro || r.groupFilter.any}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                      <p className="group-filter-summary" aria-live="polite">
                        {filterSummary(r)}
                      </p>
                      <div className="group-history-control">
                        <label htmlFor="group-history">Mensajes de contexto que ve al responder</label>
                        <div className="group-history-inputs">
                          <input
                            id="group-history"
                            type="range"
                            min="5"
                            max="100"
                            value={Number(r.groupHistory) || 30}
                            onChange={(event) => set('groupHistory')(Number(event.target.value))}
                            disabled={ro}
                          />
                          <input
                            type="number"
                            min="5"
                            max="100"
                            aria-label="Cantidad de mensajes de contexto"
                            value={r.groupHistory ?? 30}
                            onChange={(event) => set('groupHistory')(event.target.value)}
                            onBlur={(event) =>
                              set('groupHistory')(Math.min(100, Math.max(5, Number(event.target.value) || 30)))
                            }
                            disabled={ro}
                          />
                        </div>
                        <small className="help">
                          Entre 5 y 100 mensajes previos, desde la última intervención del agente.
                        </small>
                      </div>
                      {r.groupMode === 'context' && (
                        <div className="group-history-control">
                          <label htmlFor="group-context-minutes">Tiempo de atención a la charla (minutos)</label>
                          <div className="group-history-inputs">
                            <input
                              id="group-context-minutes"
                              type="range"
                              min="1"
                              max="120"
                              value={Number(r.groupContextMinutes) || 10}
                              onChange={(event) => set('groupContextMinutes')(Number(event.target.value))}
                              disabled={ro}
                            />
                            <input
                              type="number"
                              min="1"
                              max="120"
                              aria-label="Tiempo de atención a la charla en minutos"
                              value={r.groupContextMinutes ?? 10}
                              onChange={(event) => set('groupContextMinutes')(event.target.value)}
                              onBlur={(event) =>
                                set('groupContextMinutes')(Math.min(120, Math.max(1, Number(event.target.value) || 10)))
                              }
                              disabled={ro}
                            />
                          </div>
                          <small className="help">
                            Después de su última respuesta, sigue atento a la charla durante este tiempo; pasado ese
                            tiempo vuelve a necesitar mención.
                          </small>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </Card>
            <Card title="Personalizar por grupo" className="group-overrides-card">
              <p className="help">
                Cada grupo puede seguir el modo general, responder a todo, esperar una mención, responder por contexto o
                quedar silenciado. El interruptor general tiene prioridad.
              </p>
              {groupsLoading ? (
                <Skeleton rows={2} />
              ) : groupsError ? (
                <div className="error-block">
                  No se pudieron cargar los grupos: {groupsError}
                  <Button variant="secondary" onClick={loadGroups}>
                    Reintentar
                  </Button>
                </div>
              ) : groups.length ? (
                <div className="group-override-list">
                  {groups.map((group, index) => {
                    const overrides = Object.fromEntries(
                      Object.entries(r.groupFilterOverrides?.[group.jid] || {}).filter(
                        ([key, value]) => value !== r.groupFilter[key],
                      ),
                    );
                    const count = Object.keys(overrides).length;
                    const expanded = !!expandedGroups[group.jid];
                    const mo = r.groupMemberOverrides?.[group.jid];
                    const panelId = `group-filter-${index}`;
                    return (
                      <div className="group-override-item" key={group.jid}>
                        <div className="group-override-row">
                          <div className="group-override-info">
                            <span className="group-override-icon">
                              <Icon name="group" size={18} />
                            </span>
                            <div>
                              <strong>{group.name || 'Grupo sin nombre'}</strong>
                              <small>
                                {shortGroupId(group.jid)} · {group.total || 0} mensajes · Última actividad:{' '}
                                {relative(group.last_message_at)}
                              </small>
                              {count > 0 && (
                                <span className="tag">
                                  {count} personalizado{count === 1 ? '' : 's'}
                                </span>
                              )}
                            </div>
                          </div>
                          <Combo
                            label={`Modo de ${group.name || shortGroupId(group.jid)}`}
                            value={r.groupOverrides?.[group.jid] || ''}
                            options={groupOptions}
                            onChange={(value) => setGroupOverride(group.jid, value)}
                            disabled={ro}
                          />
                        </div>
                        <div className="group-filter-tools">
                          <button
                            type="button"
                            className="link"
                            aria-expanded={expanded}
                            aria-controls={panelId}
                            onClick={() => setExpandedGroups((current) => ({ ...current, [group.jid]: !expanded }))}
                          >
                            {expanded ? 'Ocultar filtro de este grupo' : 'Filtro de este grupo'}
                          </button>
                          {count > 0 && !ro && (
                            <Button variant="ghost" onClick={() => resetGroupFilter(group.jid)}>
                              Restablecer
                            </Button>
                          )}
                          <button
                            type="button"
                            className="link"
                            aria-expanded={!!memberPanels[group.jid]}
                            onClick={() => toggleMemberPanel(group)}
                          >
                            {memberPanels[group.jid] ? 'Ocultar miembros de este grupo' : 'Miembros permitidos de este grupo'}
                          </button>
                          {mo && <span className="tag">{mo.mode === 'everyone' ? 'Todos los miembros' : `Lista propia (${(mo.list || []).length})`}</span>}
                        </div>
                        {memberPanels[group.jid] && (
                          <div className="group-filter-overrides">
                            <Combo
                              label={`Quién puede activarlo en ${group.name || shortGroupId(group.jid)}`}
                              value={mo?.mode || ''}
                              disabled={ro}
                              onChange={(v) => (v ? setMemberOverride(group.jid, v === 'everyone' ? { mode: 'everyone', list: undefined, withGeneral: undefined } : { mode: 'own', list: mo?.list || [], withGeneral: !!mo?.withGeneral }) : setMemberOverride(group.jid, null))}
                              options={[
                                { value: '', label: r.groupMemberMode === 'allowlist' ? 'Como el general (solo la lista general)' : 'Como el general (cualquier miembro)' },
                                { value: 'everyone', label: 'Cualquier miembro' },
                                { value: 'own', label: 'Solo una lista de este grupo' },
                              ]}
                            />
                            {mo?.mode === 'own' && (
                              <>
                                <NumberList
                                  bare
                                  title="Miembros de este grupo"
                                  items={mo.list || []}
                                  onChange={(list) => setMemberOverride(group.jid, { list })}
                                  disabled={ro}
                                  contacts={[...asContacts(groupMembers[group.jid]), ...contacts]}
                                  empty="Sin miembros: no le responde a nadie en este grupo."
                                  hint="Los demás miembros se leen pero no se les contesta."
                                />
                                <Switch
                                  title="Sumar también la lista general"
                                  desc={`Además de esta lista, responde a los ${(r.groupMembers || []).length} de la lista general.`}
                                  checked={!!mo.withGeneral}
                                  onChange={(v) => setMemberOverride(group.jid, { withGeneral: v })}
                                  disabled={ro}
                                />
                              </>
                            )}
                          </div>
                        )}
                        {expanded && (
                          <div id={panelId} className="group-filter-overrides">
                            <p className="help">
                              Solo se guardan los valores distintos del filtro general. El filtro se aplica a las
                              menciones cuando este grupo usa “Solo si me mencionan” o “Por contexto”.
                            </p>
                            {[anyFilter, ...filterDefinitions].map((filter) => (
                              <FilterOverrideChoice
                                key={filter.key}
                                jid={group.jid}
                                filter={filter}
                                value={
                                  overrides[filter.key] === undefined ? 'general' : overrides[filter.key] ? 'yes' : 'no'
                                }
                                onChange={(choice) => setGroupFilterOverride(group.jid, filter.key, choice)}
                                disabled={ro}
                              />
                            ))}
                            <p className="help">
                              Si “Cualquier mención” está en Sí, responde a todos los tipos. Ponelo en No para aplicar
                              las opciones de texto, audio, foto y demás.
                            </p>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              ) : (
                <p className="muted">Los grupos aparecen acá cuando alguien escribe en uno donde está el agente.</p>
              )}
            </Card>
            <div className="grid-2">
              <NumberList title="Lista permitida" items={r.allowlist || []} onChange={set('allowlist')} disabled={ro} contacts={privateContacts} hint={fromEvo ? '' : 'Acá aparecen los contactos que ya le escribieron a este número. Los demás (que nunca escribieron) no figuran porque Evolution no guarda la agenda de la línea: agregalos con «Número nuevo».'} />
              <NumberList title="Lista bloqueada" items={r.blocklist || []} onChange={set('blocklist')} disabled={ro} contacts={privateContacts} hint={fromEvo ? '' : 'Acá aparecen los contactos que ya le escribieron a este número. Los demás (que nunca escribieron) no figuran porque Evolution no guarda la agenda de la línea: agregalos con «Número nuevo».'} />
            </div>
            <Outreach admin={!ro} />
          </div>
        </>
      )}
      {toastNode}
    </>
  );
}
