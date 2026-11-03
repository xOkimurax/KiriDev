import React, { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { api } from '../api.js';
import { Button, Card, Combo, Empty, InlineConfirm, PageHead, Skeleton, Switch, fmtDate, useToast } from '../components/ui.jsx';

const emptyMemory = { content: '', size: 0, updated_at: null };
const sizeLabel = (bytes) => `${Number(bytes || 0).toLocaleString('es-PY')} bytes`;

function AccountMemory({ admin }) {
  const [accounts, setAccounts] = useState([]),
    [inst, setInst] = useState(''),
    [draft, setDraft] = useState(''),
    [saved, setSaved] = useState(''),
    [msg, setMsg] = useState('');
  useEffect(() => {
    api('/whatsapp/accounts').then((a) => { setAccounts(a); if (a.length) setInst(a[0].instance); }).catch(() => {});
  }, []);
  useEffect(() => {
    if (!inst) return;
    api(`/memory/account/${encodeURIComponent(inst)}`).then((m) => { setDraft(m.content || ''); setSaved(m.content || ''); setMsg(''); }).catch((e) => setMsg(e.message));
  }, [inst]);
  if (accounts.length < 2) return null;
  async function save() {
    try {
      const m = await api(`/memory/account/${encodeURIComponent(inst)}`, { method: 'PUT', body: { content: draft } });
      setSaved(m.content || '');
      setMsg('Guardado');
    } catch (e) {
      setMsg(e.message);
    }
  }
  return (
    <Card title="Memoria de cada número de WhatsApp">
      <p className="help">Se suma a la memoria global, pero solo en las charlas que llegan por ese número (por ejemplo, otro negocio, otro horario o otro rol).</p>
      <Combo
        label="Número"
        value={inst}
        onChange={setInst}
        options={accounts.map((a) => ({ value: a.instance, label: a.label || a.instance }))}
      />
      <textarea className="memory-editor" value={draft} onChange={(e) => setDraft(e.target.value)} readOnly={!admin} spellCheck={false} maxLength={14000} placeholder="- Este número atiende ventas mayoristas." />
      <div className="memory-editor-footer">
        <span>{draft.length.toLocaleString('es-PY')} caracteres · {draft === saved ? 'Guardado' : 'Sin guardar'} {msg && `· ${msg}`}</span>
        {admin && (
          <Button icon="save" disabled={draft === saved} onClick={save}>
            Guardar
          </Button>
        )}
      </div>
    </Card>
  );
}

function AddChat({ onAdded, toast }) {
  const [accounts, setAccounts] = useState([]),
    [inst, setInst] = useState(''),
    [contacts, setContacts] = useState([]),
    [pick, setPick] = useState(''),
    [number, setNumber] = useState(''),
    [open, setOpen] = useState(false);
  useEffect(() => { api('/whatsapp/accounts').then((a) => { setAccounts(a); if (a.length) setInst((x) => x || a.find((y) => y.primary)?.instance || a[0].instance); }).catch(() => {}); }, []);
  useEffect(() => { if (inst) api(`/contacts?instance=${encodeURIComponent(inst)}`).then((r) => setContacts(r.contacts)).catch(() => setContacts([])); }, [inst]);
  async function add(num) {
    try {
      const r = await api('/contacts/ensure', { method: 'POST', body: { instance: inst, number: num, name: contacts.find((c) => c.number === num)?.name } });
      setPick(''); setNumber(''); toast('Chat agregado: ya podés ver y editar su memoria y su perfil'); onAdded(r.jid);
    } catch (e) { toast(e.message, 'err'); }
  }
  return (
    <div className="stack">
      <div className="row"><Button variant="secondary" icon={open ? 'close' : 'plus'} onClick={() => setOpen(!open)}>{open ? 'Cerrar' : 'Agregar otro chat'}</Button></div>
      {open && <div className="stack">
        {accounts.length > 1 && <Combo label="Número de WhatsApp" value={inst} onChange={setInst} options={accounts.map((a) => ({ value: a.instance, label: a.label || a.instance }))} />}
        <div className="row">
          <div style={{ flex: 1, minWidth: 180 }}>
            <Combo label="Contacto conocido" value={pick} onChange={setPick} searchable placeholder="Elegir…" options={contacts.map((c) => ({ value: c.number, label: c.name || `+${c.number}`, description: `+${c.number}` }))} />
          </div>
          <Button variant="secondary" disabled={!pick} onClick={() => add(pick)}>Agregar</Button>
        </div>
        <div className="row">
          <label style={{ flex: 1 }}>Número nuevo<input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="595981123456" /></label>
          <Button variant="secondary" disabled={number.replace(/\D/g, '').length < 6} onClick={() => add(number.replace(/\D/g, ''))}>Agregar</Button>
        </div>
      </div>}
    </div>
  );
}

function ContactProfile({ jid, admin }) {
  const [p, setP] = useState(null),
    [draft, setDraft] = useState(''),
    [busy, setBusy] = useState(false),
    [msg, setMsg] = useState('');
  useEffect(() => {
    setP(null); setMsg('');
    api(`/profile/${encodeURIComponent(jid)}`).then((x) => { setP(x); setDraft(x.text || ''); }).catch(() => setP({}));
  }, [jid]);
  async function generate() {
    setBusy(true); setMsg('Estudiando el historial… puede tardar un minuto');
    try { const x = await api(`/profile/${encodeURIComponent(jid)}/generate`, { method: 'POST' }); setP(x); setDraft(x.text || ''); setMsg(`Listo (${x.messages} mensajes leídos, fuente: ${x.source === 'evolution' ? 'WhatsApp/Evolution' : 'panel'})`); }
    catch (e) { setMsg(e.message); } finally { setBusy(false); }
  }
  async function save() {
    try { const x = await api(`/profile/${encodeURIComponent(jid)}`, { method: 'PUT', body: { text: draft } }); setP(x); setDraft(x.text || ''); setMsg('Guardado (editado a mano: no se renueva solo)'); }
    catch (e) { setMsg(e.message); }
  }
  if (!p) return null;
  return (
    <div style={{ marginTop: 18 }}>
      <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>Perfil de comunicación</h3>
      <p className="help">
        {p.text ? `${p.edited ? 'Editado a mano' : 'Generado'} · ${fmtDate(p.updated_at)}${p.messages ? ` · ${p.messages} mensajes` : ''}` : 'Todavía no hay perfil. Se activa en Personalidades → Configuración → Adaptación a cada chat.'}
      </p>
      <textarea className="memory-editor" value={draft} onChange={(e) => setDraft(e.target.value)} readOnly={!admin} spellCheck={false} maxLength={6000} placeholder="Cómo se comunica, temperamento, cómo conviene tratarla…" />
      {admin && (
        <div className="row">
          <Button icon="refresh" disabled={busy} onClick={generate}>{p.text ? 'Regenerar desde el historial' : 'Generar desde el historial'}</Button>
          <Button variant="secondary" icon="save" disabled={draft === (p.text || '')} onClick={save}>Guardar edición</Button>
          {p.text && <InlineConfirm label="Borrar perfil" message="Se borra el perfil de este chat." confirmLabel="Sí, borrar" onConfirm={async () => { await api(`/profile/${encodeURIComponent(jid)}`, { method: 'DELETE' }); setP({}); setDraft(''); }} />}
          {msg && <span className="muted">{msg}</span>}
        </div>
      )}
    </div>
  );
}

export default function Memory({ user }) {
  const admin = user.role === 'admin';
  const [searchParams, setSearchParams] = useSearchParams();
  const jid = searchParams.get('jid') || '';
  const [globalMemory, setGlobalMemory] = useState(null),
    [globalDraft, setGlobalDraft] = useState(''),
    [globalError, setGlobalError] = useState(''),
    [contacts, setContacts] = useState([]),
    [contactsLoading, setContactsLoading] = useState(true),
    [contactsError, setContactsError] = useState(''),
    [search, setSearch] = useState(''),
    [contactMemory, setContactMemory] = useState(null),
    [contactDraft, setContactDraft] = useState(''),
    [contactLoading, setContactLoading] = useState(false),
    [contactError, setContactError] = useState(''),
    [pendingJid, setPendingJid] = useState(null),
    [savingGlobal, setSavingGlobal] = useState(false),
    [savingContact, setSavingContact] = useState(false),
    [toast, toastNode] = useToast();

  const globalDirty = globalMemory && globalDraft !== globalMemory.content;
  const contactDirty = contactMemory && contactDraft !== contactMemory.content;
  const visibleContacts = contacts.filter((contact) =>
    `${contact.name || ''} ${contact.jid}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  const selectedContact = contacts.find((contact) => contact.jid === jid);

  function loadGlobal() {
    api('/memory/global')
      .then((memory) => {
        setGlobalMemory(memory);
        setGlobalDraft(memory.content);
        setGlobalError('');
      })
      .catch((error) => setGlobalError(error.message));
  }
  function loadContacts() {
    setContactsLoading(true);
    api('/memory/contacts')
      .then((items) => {
        setContacts(items);
        setContactsError('');
      })
      .catch((error) => setContactsError(error.message))
      .finally(() => setContactsLoading(false));
  }
  useEffect(() => {
    loadGlobal();
    loadContacts();
  }, []);
  useEffect(() => {
    if (!jid) {
      setContactMemory(null);
      setContactDraft('');
      return;
    }
    let current = true;
    setContactLoading(true);
    api(`/memory/contact/${encodeURIComponent(jid)}`)
      .then((memory) => {
        if (!current) return;
        setContactMemory(memory);
        setContactDraft(memory.content);
        setContactError('');
      })
      .catch((error) => {
        if (current) setContactError(error.message);
      })
      .finally(() => {
        if (current) setContactLoading(false);
      });
    return () => {
      current = false;
    };
  }, [jid]);
  function openContact(nextJid) {
    if (nextJid === jid) return;
    if (contactDirty) {
      setPendingJid(nextJid);
      return;
    }
    const next = new URLSearchParams(searchParams);
    if (nextJid) next.set('jid', nextJid);
    else next.delete('jid');
    setSearchParams(next);
  }
  function discardAndOpen() {
    const next = pendingJid;
    setPendingJid(null);
    const nextParams = new URLSearchParams(searchParams);
    if (next) nextParams.set('jid', next);
    else nextParams.delete('jid');
    setSearchParams(nextParams);
  }
  async function saveGlobal() {
    setSavingGlobal(true);
    try {
      const saved = await api('/memory/global', { method: 'PUT', body: { content: globalDraft } });
      setGlobalMemory(saved);
      setGlobalDraft(saved.content);
      toast('Memoria global guardada');
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      setSavingGlobal(false);
    }
  }
  async function saveContact() {
    setSavingContact(true);
    try {
      const saved = await api(`/memory/contact/${encodeURIComponent(jid)}`, {
        method: 'PUT',
        body: { content: contactDraft },
      });
      setContactMemory(saved);
      setContactDraft(saved.content);
      loadContacts();
      toast('Memoria del contacto guardada');
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      setSavingContact(false);
    }
  }
  async function clearContact() {
    try {
      await api(`/memory/contact/${encodeURIComponent(jid)}`, { method: 'DELETE' });
      setContactMemory(emptyMemory);
      setContactDraft('');
      loadContacts();
      toast('Memoria vaciada');
    } catch (error) {
      toast(error.message, 'err');
    }
  }

  return (
    <div className="memory-page">
      <PageHead title="Memoria" />
      <p className="memory-intro">
        La memoria complementa las conversaciones: el agente anota solo datos duraderos de cada persona o grupo y los
        usa siempre, aunque reinicies la memoria de la charla. La global aplica a todas las conversaciones y solo se
        edita acá.
      </p>
      <Card title="Memoria global" className="memory-global-card">
        {globalError ? (
          <div className="error-block">
            No se pudo cargar la memoria global.{' '}
            <Button variant="secondary" onClick={loadGlobal}>
              Reintentar
            </Button>
          </div>
        ) : !globalMemory ? (
          <Skeleton rows={3} />
        ) : (
          <>
            <label>
              Datos que aplican a todos
              <textarea
                className="memory-editor"
                value={globalDraft}
                onChange={(event) => setGlobalDraft(event.target.value)}
                readOnly={!admin}
                spellCheck={false}
                maxLength={14000}
                placeholder="## Negocio\n- Horario: lunes a viernes de 9 a 18.\n- Política de devoluciones: 30 días."
              />
            </label>
            <div className="memory-editor-footer">
              <span>
                {globalDraft.length.toLocaleString('es-PY')} caracteres · {globalDirty ? 'Sin guardar' : 'Guardado'}
              </span>
              {admin && (
                <Button icon="save" disabled={!globalDirty || savingGlobal} onClick={saveGlobal}>
                  Guardar
                </Button>
              )}
            </div>
            <details className="memory-example">
              <summary>Qué conviene escribir acá</summary>
              <p>Datos del negocio, horarios, políticas y criterios que el agente debe conocer en todas las charlas.</p>
            </details>
          </>
        )}
      </Card>
      <AccountMemory admin={admin} />
      <div className="memory-contacts-layout">
        <Card title="Memorias por contacto" className="memory-list-card">
          <p className="help">Lo que el agente anota es visible y editable por vos.</p>
          <p className="help">Acá aparecen los chats que el agente ya atendió, es decir los que pasan las <strong>Reglas de respuesta</strong> (si un número está fuera de la lista permitida, no se le responde y no tiene memoria). Los chats viejos de WhatsApp no se importan solos: Evolution hoy no guarda el historial.</p>
          {admin && <AddChat toast={toast} onAdded={(key) => { loadContacts(); openContact(key); }} />}
          <label>
            Buscar por nombre o número
            <input type="search" value={search} onChange={(event) => setSearch(event.target.value)} />
          </label>
          {contactsError ? (
            <div className="error-block">
              No se pudieron cargar las memorias.{' '}
              <Button variant="secondary" onClick={loadContacts}>
                Reintentar
              </Button>
            </div>
          ) : contactsLoading ? (
            <Skeleton rows={4} />
          ) : visibleContacts.length ? (
            <div className="memory-contact-list">
              {visibleContacts.map((contact) => (
                <button
                  type="button"
                  key={contact.jid}
                  className={`memory-contact-row ${jid === contact.jid ? 'active' : ''}`}
                  aria-current={jid === contact.jid ? 'true' : undefined}
                  onClick={() => openContact(contact.jid)}
                >
                  <strong>{contact.name || contact.jid.split('@')[0]}</strong>
                  {contact.instanceLabel && <span className="chip"> {contact.instanceLabel}</span>}
                  {contact.has_profile && <span className="chip">Perfil</span>}
                  <span>
                    {contact.facts} datos · {sizeLabel(contact.size)}
                  </span>
                  <small>Actualizada: {fmtDate(contact.updated_at)}</small>
                </button>
              ))}
            </div>
          ) : (
            <Empty title={search ? 'Sin coincidencias' : 'Sin memorias'}>
              {search ? 'Probá con otro nombre o número.' : 'Aparecen acá cuando el agente anota datos duraderos.'}
            </Empty>
          )}
        </Card>
        <Card
          title={jid ? selectedContact?.name || jid.split('@')[0] : 'Detalle de memoria'}
          className="memory-detail-card"
        >
          {!jid ? (
            <p className="muted">Elegí un contacto o grupo para leer su memoria.</p>
          ) : contactError ? (
            <div className="error-block">No se pudo cargar esta memoria: {contactError}</div>
          ) : contactLoading || !contactMemory ? (
            <Skeleton rows={3} />
          ) : (
            <>
              <p className="help">
                {jid} · {sizeLabel(contactMemory.size)} · {fmtDate(contactMemory.updated_at)}
              </p>
              <textarea
                className="memory-editor"
                aria-label={`Memoria de ${selectedContact?.name || jid}`}
                value={contactDraft}
                onChange={(event) => setContactDraft(event.target.value)}
                readOnly={!admin}
                spellCheck={false}
                maxLength={14000}
                placeholder="Todavía no hay datos guardados para este contacto."
              />
              <div className="memory-editor-footer">
                <span>
                  {contactDraft.length.toLocaleString('es-PY')} caracteres · {contactDirty ? 'Sin guardar' : 'Guardado'}
                </span>
                {admin && (
                  <div className="row">
                    <Button icon="save" disabled={!contactDirty || savingContact} onClick={saveContact}>
                      Guardar
                    </Button>
                    {(contactMemory.content || contactDraft) && (
                      <InlineConfirm
                        label="Vaciar memoria"
                        message="Se borran los datos duraderos de este contacto. No se puede deshacer."
                        confirmLabel="Sí, vaciar"
                        onConfirm={clearContact}
                      />
                    )}
                  </div>
                )}
              </div>
              <ContactProfile jid={jid} admin={admin} />
            </>
          )}
        </Card>
      </div>
      {pendingJid !== null && (
        <div className="inline-confirm memory-pending" role="alert">
          <span>Hay cambios sin guardar en esta memoria. ¿Descartarlos?</span>
          <Button variant="danger" onClick={discardAndOpen}>
            Descartar
          </Button>
          <Button variant="ghost" onClick={() => setPendingJid(null)}>
            Seguir editando
          </Button>
        </div>
      )}
      {toastNode}
    </div>
  );
}
