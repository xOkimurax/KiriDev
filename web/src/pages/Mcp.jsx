import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';
import {
  Badge,
  Button,
  Card,
  Combo,
  Empty,
  Icon,
  PageHead,
  Skeleton,
  Switch,
  fmtDate,
  useToast,
} from '../components/ui.jsx';
import { demoMcpApi } from './mcpDemo.js';

const examples = [
  {
    label: 'JSON',
    text: '{\n  "mcpServers": {\n    "archivos": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/workspace"]\n    }\n  }\n}',
  },
  { label: 'URL', text: 'https://mcp.ejemplo.com/mcp' },
  { label: 'npx', text: 'npx -y @modelcontextprotocol/server-filesystem /workspace' },
];
const typeLabels = { stdio: 'Comando', http: 'HTTP', sse: 'SSE' };
const emptyForm = () => ({
  name: '',
  type: 'stdio',
  command: '',
  args: '',
  url: '',
  description: '',
  env: [],
  headers: [],
});
let rowId = 0;
const newRow = (key = '', value = '') => ({ id: ++rowId, key, value, visible: false });
const rowsFrom = (values) => Object.entries(values || {}).map(([key, value]) => newRow(key, value));
const objectFromRows = (rows) =>
  Object.fromEntries(rows.filter((row) => row.key.trim()).map((row) => [row.key.trim(), row.value]));

function statusLabel(server) {
  if (!server.enabled) return 'Desactivado';
  if (server.status === 'ok') return `Conectado · ${server.tools?.length || 0} herramientas`;
  if (server.status === 'error') return 'Error de conexión';
  if (server.status === 'auth_required') return 'Requiere iniciar sesión';
  return 'Sin probar';
}

function ServerCard({ server, admin, busy, busyAction, onTest, onLogin, onEdit, onToggle, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [search, setSearch] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [deleteError, setDeleteError] = useState('');
  const confirmRef = useRef(null);
  const triggerRef = useRef(null);
  useEffect(() => {
    if (confirming) confirmRef.current?.focus();
  }, [confirming]);
  const tools = server.tools || [];
  useEffect(() => {
    if (tools.length <= 6) setSearch('');
  }, [tools.length]);
  const shownTools = tools.filter((tool) =>
    `${tool.name} ${tool.description || ''}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()),
  );
  async function remove() {
    setDeleteError('');
    try {
      await onDelete(server.name);
    } catch (error) {
      setDeleteError(error.message);
    }
  }
  function cancelDelete() {
    setConfirming(false);
    setDeleteError('');
    requestAnimationFrame(() => triggerRef.current?.focus());
  }
  return (
    <Card className="mcp-server-card">
      <div className="mcp-server-top">
        <div className="mcp-server-heading">
          <span className="mcp-server-symbol">
            <Icon name="mcp" size={19} />
          </span>
          <div>
            <h3>{server.name}</h3>
            <div className="mcp-server-badges">
              <span className="mcp-type">{typeLabels[server.type] || server.type}</span>
              <Badge
                tone={
                  !server.enabled
                    ? 'neutral'
                    : server.status === 'ok'
                      ? 'ok'
                      : server.status === 'error' || server.status === 'auth_required'
                        ? 'bad'
                        : 'neutral'
                }
              >
                {statusLabel(server)}
              </Badge>
            </div>
          </div>
        </div>
        {admin && (
          <Switch
            title={server.enabled ? 'Activado' : 'Desactivado'}
            checked={server.enabled}
            disabled={busy}
            onChange={(enabled) => onToggle(server.name, enabled)}
          />
        )}
      </div>
      {server.description && <p className="mcp-description">{server.description}</p>}
      <code
        className="mcp-endpoint"
        title={server.type === 'stdio' ? [server.command, ...(server.args || [])].join(' ') : server.url}
      >
        {server.type === 'stdio' ? [server.command, ...(server.args || [])].join(' ') : server.url}
      </code>
      <div className="mcp-card-footer">
        <button type="button" className="link" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
          {expanded ? 'Ocultar detalles' : 'Ver herramientas y diagnóstico'}
        </button>
        {admin && (
          <div className="row">
            {server.type !== 'stdio' && (server.status === 'auth_required' || server.oauth) && (
              <Button
                variant={server.status === 'auth_required' ? 'primary' : 'ghost'}
                disabled={busy}
                onClick={() => onLogin(server.name)}
              >
                {busyAction === 'login'
                  ? 'Preparando…'
                  : server.status === 'auth_required'
                    ? 'Iniciar sesión'
                    : 'Volver a iniciar sesión'}
              </Button>
            )}
            <Button variant="secondary" disabled={busy} onClick={() => onTest(server.name)}>
              {busyAction === 'test' ? 'Conectando…' : 'Probar'}
            </Button>
            <Button variant="ghost" disabled={busy} onClick={() => onEdit(server)}>
              Editar
            </Button>
            {!confirming && (
              <Button ref={triggerRef} variant="danger" disabled={busy} onClick={() => setConfirming(true)}>
                Eliminar
              </Button>
            )}
          </div>
        )}
      </div>
      {busyAction === 'test' && (
        <p className="mcp-working" role="status">
          <span className="mcp-spinner" aria-hidden="true" /> Conectando… Puede tardar hasta un minuto.
        </p>
      )}
      {confirming && (
        <div className="inline-confirm mcp-delete-confirm" aria-live="polite">
          <span>¿Eliminar «{server.name}»? El agente dejará de usar sus herramientas.</span>
          {deleteError && (
            <span className="mcp-error" role="alert">
              {deleteError}
            </span>
          )}
          <div className="row">
            <Button variant="ghost" disabled={busy} onClick={cancelDelete}>
              Cancelar
            </Button>
            <Button ref={confirmRef} variant="danger-solid" disabled={busy} onClick={remove}>
              Sí, eliminar
            </Button>
          </div>
        </div>
      )}
      {expanded && (
        <div className="mcp-details">
          {server.tested_at && <small className="muted">Última prueba: {fmtDate(server.tested_at)}</small>}
          {tools.length > 6 && (
            <label>
              Buscar herramientas
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Nombre o descripción"
              />
            </label>
          )}
          {shownTools.length ? (
            <ul className="mcp-tools">
              {shownTools.map((tool) => (
                <li key={tool.name}>
                  <strong>{tool.name}</strong>
                  {tool.description && <span>{tool.description}</span>}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted">
              {search ? 'No hay herramientas que coincidan.' : 'Todavía no hay herramientas disponibles.'}
            </p>
          )}
          {server.status_msg && (
            <div>
              <strong className="mcp-diagnostic-title">Último mensaje de error</strong>
              <pre className="mcp-diagnostic">{server.status_msg}</pre>
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function KeyValueRows({ title, rows, onChange, disabled }) {
  function update(id, key, value) {
    onChange(rows.map((row) => (row.id === id ? { ...row, [key]: value } : row)));
  }
  return (
    <div className="mcp-key-values">
      <div className="mcp-key-values-head">
        <strong>{title}</strong>
        <Button type="button" variant="ghost" disabled={disabled} onClick={() => onChange([...rows, newRow()])}>
          Agregar fila
        </Button>
      </div>
      {rows.map((row) => (
        <div className="mcp-key-value-row" key={row.id}>
          <input
            aria-label={`${title}: clave`}
            placeholder="Clave"
            disabled={disabled}
            value={row.key}
            onChange={(event) => update(row.id, 'key', event.target.value)}
          />
          <input
            aria-label={`${title}: valor de ${row.key || 'clave nueva'}`}
            type={row.visible ? 'text' : 'password'}
            disabled={disabled}
            placeholder="Valor"
            value={row.value}
            onChange={(event) => update(row.id, 'value', event.target.value)}
          />
          <button
            type="button"
            className="icon-btn"
            aria-label={row.visible ? 'Ocultar valor' : 'Mostrar valor'}
            aria-pressed={row.visible}
            disabled={disabled}
            onClick={() => update(row.id, 'visible', !row.visible)}
          >
            <Icon name={row.visible ? 'eyeOff' : 'eye'} size={17} />
          </button>
          <button
            type="button"
            className="icon-btn"
            aria-label={`Quitar ${row.key || 'fila'}`}
            disabled={disabled}
            onClick={() => onChange(rows.filter((item) => item.id !== row.id))}
          >
            <Icon name="trash" size={16} />
          </button>
        </div>
      ))}
      {rows.some((row) => row.value === '••••••••') && (
        <small className="help">Los valores enmascarados se conservan al guardar.</small>
      )}
    </div>
  );
}

export default function Mcp({ user }) {
  const admin = user.role === 'admin';
  const demoMode = new URLSearchParams(window.location.search).get('demo') === '1';
  const request = demoMode ? demoMcpApi : api;
  const [servers, setServers] = useState([]);
  const [agentCanInstall, setAgentCanInstall] = useState(false);
  const [loading, setLoading] = useState(true);
  const [pageError, setPageError] = useState('');
  const [importText, setImportText] = useState('');
  const [importBusy, setImportBusy] = useState(false);
  const [importError, setImportError] = useState('');
  const [importResults, setImportResults] = useState([]);
  const [editor, setEditor] = useState(null);
  const [editorBusy, setEditorBusy] = useState(false);
  const [editorError, setEditorError] = useState('');
  const [busyName, setBusyName] = useState(null);
  const [busyAction, setBusyAction] = useState(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const [toast, toastNode] = useToast();
  const editorRef = useRef(null);
  const editorFocusKey = editor?.existing ? editor.name : editor ? 'new' : null;
  useEffect(() => {
    let current = true;
    request('/mcp')
      .then((data) => {
        if (!current) return;
        setServers(data.servers);
        setAgentCanInstall(data.agentCanInstall);
        setPageError('');
      })
      .catch((error) => {
        if (current) setPageError(error.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [request]);
  useEffect(() => {
    if (editor) editorRef.current?.focus();
  }, [editorFocusKey]);
  async function reload() {
    const data = await request('/mcp');
    setServers(data.servers);
    setAgentCanInstall(data.agentCanInstall);
    setPageError('');
  }
  async function importMcp() {
    setImportBusy(true);
    setImportError('');
    setImportResults([]);
    try {
      const result = await request('/mcp/import', { method: 'POST', body: { text: importText, test: true } });
      setImportResults(result.servers);
      await reload();
      toast(
        `${result.servers.length} MCP${result.servers.length === 1 ? '' : 's'} agregado${result.servers.length === 1 ? '' : 's'}`,
      );
    } catch (error) {
      setImportError(error.message);
    } finally {
      setImportBusy(false);
    }
  }
  function openEditor(server) {
    setEditorError('');
    setEditor(
      server
        ? {
            name: server.name,
            type: server.type,
            command: server.command || '',
            args: (server.args || []).join('\n'),
            url: server.url || '',
            description: server.description || '',
            env: rowsFrom(server.env),
            headers: rowsFrom(server.headers),
            existing: true,
          }
        : emptyForm(),
    );
    requestAnimationFrame(() =>
      editorRef.current?.scrollIntoView({
        block: 'start',
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
      }),
    );
  }
  const change = (key, value) => setEditor((form) => ({ ...form, [key]: value }));
  async function saveEditor(testAfterSave) {
    setEditorBusy(testAfterSave ? 'testing' : 'saving');
    setEditorError('');
    try {
      const name = editor.name.trim();
      if (!name) throw new Error('Escribí un nombre para el MCP');
      if (!/^[a-z0-9_-]{1,40}$/.test(name)) throw new Error('Usá hasta 40 letras minúsculas, números, guiones o _');
      const body = {
        type: editor.type,
        command: editor.type === 'stdio' ? editor.command.trim() : null,
        args:
          editor.type === 'stdio'
            ? editor.args
                .split('\n')
                .map((part) => part.trim())
                .filter(Boolean)
            : [],
        env: editor.type === 'stdio' ? objectFromRows(editor.env) : {},
        url: editor.type === 'stdio' ? null : editor.url.trim(),
        headers: editor.type === 'stdio' ? {} : objectFromRows(editor.headers),
        description: editor.description.trim(),
      };
      await request(`/mcp/${encodeURIComponent(name)}`, { method: 'PUT', body });
      let tested = null;
      if (testAfterSave) tested = await request(`/mcp/${encodeURIComponent(name)}/test`, { method: 'POST' });
      await reload();
      setEditor(null);
      toast(tested?.status === 'error' ? 'Guardado · La prueba informó un error' : 'MCP guardado');
    } catch (error) {
      setEditorError(error.message);
    } finally {
      setEditorBusy(false);
    }
  }
  async function test(name) {
    setBusyName(name);
    setBusyAction('test');
    try {
      const result = await request(`/mcp/${encodeURIComponent(name)}/test`, { method: 'POST' });
      setServers((current) => current.map((server) => (server.name === name ? result : server)));
      toast(
        result.status === 'ok' ? `${name}: conectado` : `${name}: error de conexión`,
        result.status === 'ok' ? 'ok' : 'err',
      );
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      setBusyName(null);
      setBusyAction(null);
    }
  }
  // el login se hace en el navegador de quien lo abra: el proveedor devuelve al hub, que guarda el acceso y prueba el MCP
  async function login(name) {
    setBusyName(name);
    setBusyAction('login');
    try {
      const { url } = await request(`/mcp/${encodeURIComponent(name)}/login`, { method: 'POST' });
      window.open(url, '_blank', 'noopener');
      toast('Se abrió el inicio de sesión. Al terminar, volvé acá y tocá Probar.');
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      setBusyName(null);
      setBusyAction(null);
    }
  }
  async function toggle(name, enabled) {
    setBusyName(name);
    setBusyAction('toggle');
    try {
      const result = await request(`/mcp/${encodeURIComponent(name)}/enabled`, { method: 'POST', body: { enabled } });
      setServers((current) => current.map((server) => (server.name === name ? result : server)));
      toast(enabled ? 'MCP activado' : 'MCP desactivado');
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      setBusyName(null);
      setBusyAction(null);
    }
  }
  async function remove(name) {
    setBusyName(name);
    setBusyAction('delete');
    try {
      await request(`/mcp/${encodeURIComponent(name)}`, { method: 'DELETE' });
      setServers((current) => current.filter((server) => server.name !== name));
      toast('MCP eliminado');
    } finally {
      setBusyName(null);
      setBusyAction(null);
    }
  }
  async function changeAgentInstall(enabled) {
    setSettingsBusy(true);
    try {
      const result = await request('/mcp-settings', { method: 'PUT', body: { agentCanInstall: enabled } });
      setAgentCanInstall(result.agentCanInstall);
      toast(
        result.agentCanInstall ? 'Instalación por el agente habilitada' : 'Instalación por el agente deshabilitada',
      );
    } catch (error) {
      toast(error.message, 'err');
    } finally {
      setSettingsBusy(false);
    }
  }
  return (
    <div className="mcp-page">
      <PageHead title="MCPs" />
      <div className="mcp-intro">
        <p>
          Los MCPs le dan al agente herramientas nuevas (Gmail, bases de datos, Brevo, navegadores…). Se aplican desde
          el próximo mensaje, sin reiniciar nada.
        </p>
        <p className="mcp-security">
          <Icon name="info" size={17} /> Los MCP de tipo comando se ejecutan dentro del contenedor del agente. Instalá
          solo los que confíes.
        </p>
        {demoMode && <Badge>Vista de demostración · Los cambios no se guardan</Badge>}
      </div>
      {loading ? (
        <Skeleton rows={6} />
      ) : pageError ? (
        <div className="error-block">
          No se pudieron cargar los MCPs: {pageError}{' '}
          <Button
            variant="secondary"
            onClick={() => {
              setLoading(true);
              reload()
                .catch((error) => setPageError(error.message))
                .finally(() => setLoading(false));
            }}
          >
            Reintentar
          </Button>
        </div>
      ) : (
        <>
          {admin && (
            <Card title="Agregar un MCP" className="mcp-import-card">
              <p className="muted">
                Pegá la configuración tal como la recibiste. La guardamos y comprobamos qué herramientas ofrece.
              </p>
              <label>
                Configuración
                <textarea
                  value={importText}
                  onChange={(event) => setImportText(event.target.value)}
                  placeholder="Pegá acá el JSON, la URL, el comando o la línea claude mcp add …"
                  spellCheck={false}
                />
              </label>
              <div className="mcp-import-actions">
                <div className="mcp-examples" aria-label="Ejemplos de formato">
                  <span>Ejemplos:</span>
                  {examples.map((example) => (
                    <button
                      type="button"
                      className="mcp-example"
                      key={example.label}
                      onClick={() => setImportText(example.text)}
                    >
                      {example.label}
                    </button>
                  ))}
                </div>
                <Button disabled={!importText.trim() || importBusy} onClick={importMcp}>
                  {importBusy ? 'Conectando…' : 'Agregar y probar'}
                </Button>
              </div>
              {importBusy && (
                <p className="mcp-working" role="status">
                  <span className="mcp-spinner" aria-hidden="true" /> Conectando… La primera prueba puede tardar hasta
                  un minuto.
                </p>
              )}
              <div aria-live="polite" className="mcp-import-results">
                {importError && (
                  <p className="mcp-error" role="alert">
                    {importError}
                  </p>
                )}
                {importResults.map((server) => (
                  <p key={server.name} className={server.status === 'ok' ? 'mcp-result-ok' : 'mcp-error'}>
                    {server.status === 'ok' ? '✔' : '✖'} {server.name}:{' '}
                    {server.status === 'ok'
                      ? `conectado con ${server.tools?.length || 0} herramientas`
                      : server.status_msg || 'No se pudo conectar'}
                  </p>
                ))}
              </div>
              <button type="button" className="link mcp-manual-link" onClick={() => openEditor(null)}>
                Completar a mano
              </button>
            </Card>
          )}
          {admin && editor && (
            <Card
              title={editor.existing ? `Editar ${editor.name}` : 'Completar MCP a mano'}
              className="mcp-editor-card"
            >
              <div className="mcp-form-grid">
                <label>
                  Nombre
                  <input
                    ref={editorRef}
                    value={editor.name}
                    readOnly={editor.existing}
                    disabled={!!editorBusy}
                    onChange={(event) => change('name', event.target.value)}
                    placeholder="ej. brevo"
                  />
                </label>
                <Combo
                  label="Tipo"
                  value={editor.type}
                  disabled={!!editorBusy}
                  onChange={(value) => change('type', value)}
                  options={[
                    { value: 'stdio', label: 'Comando' },
                    { value: 'http', label: 'HTTP' },
                    { value: 'sse', label: 'SSE' },
                  ]}
                />
                {editor.type === 'stdio' ? (
                  <>
                    <label>
                      Comando
                      <input
                        value={editor.command}
                        disabled={editorBusy}
                        onChange={(event) => change('command', event.target.value)}
                        placeholder="npx"
                      />
                    </label>
                    <label>
                      Argumentos <small className="help">Uno por línea</small>
                      <textarea
                        className="mcp-args"
                        value={editor.args}
                        disabled={editorBusy}
                        onChange={(event) => change('args', event.target.value)}
                        placeholder={'-y\npaquete-mcp'}
                        spellCheck={false}
                      />
                    </label>
                  </>
                ) : (
                  <label className="mcp-wide">
                    URL
                    <input
                      type="url"
                      value={editor.url}
                      disabled={editorBusy}
                      onChange={(event) => change('url', event.target.value)}
                      placeholder="https://ejemplo.com/mcp"
                    />
                  </label>
                )}
                <label className="mcp-wide">
                  Descripción
                  <input
                    maxLength={200}
                    value={editor.description}
                    disabled={editorBusy}
                    onChange={(event) => change('description', event.target.value)}
                    placeholder="Qué puede hacer este MCP"
                  />
                </label>
              </div>
              {editor.type === 'stdio' ? (
                <KeyValueRows
                  title="Variables de entorno"
                  rows={editor.env}
                  onChange={(rows) => change('env', rows)}
                  disabled={!!editorBusy}
                />
              ) : (
                <KeyValueRows
                  title="Cabeceras HTTP"
                  rows={editor.headers}
                  onChange={(rows) => change('headers', rows)}
                  disabled={!!editorBusy}
                />
              )}
              {editorError && (
                <p className="mcp-error" role="alert">
                  {editorError}
                </p>
              )}
              {editorBusy && (
                <p className="mcp-working" role="status">
                  <span className="mcp-spinner" aria-hidden="true" />{' '}
                  {editorBusy === 'testing' ? 'Conectando…' : 'Guardando…'}
                </p>
              )}
              <div className="row mcp-editor-actions">
                <Button variant="ghost" disabled={editorBusy} onClick={() => setEditor(null)}>
                  Cancelar
                </Button>
                <Button variant="secondary" disabled={editorBusy} onClick={() => saveEditor(false)}>
                  Guardar sin probar
                </Button>
                <Button disabled={editorBusy} onClick={() => saveEditor(true)}>
                  Guardar y probar
                </Button>
              </div>
            </Card>
          )}
          <div className="mcp-list-head">
            <h2>Servidores MCP</h2>
            <span className="muted">
              {servers.length} MCP{servers.length === 1 ? '' : 's'}
            </span>
          </div>
          {servers.length ? (
            <div className="mcp-server-list">
              {servers.map((server) => (
                <ServerCard
                  key={server.name}
                  server={server}
                  admin={admin}
                  busy={busyName !== null}
                  busyAction={busyName === server.name ? busyAction : null}
                  onTest={test}
                  onLogin={login}
                  onEdit={openEditor}
                  onToggle={toggle}
                  onDelete={remove}
                />
              ))}
            </div>
          ) : (
            <Card className="mcp-empty">
              <Empty title="Todavía no hay MCPs">
                Agregá uno con JSON, una URL o un comando para darle herramientas nuevas al agente.
              </Empty>
              {admin && (
                <div className="mcp-examples">
                  {examples.map((example) => (
                    <button
                      type="button"
                      className="mcp-example"
                      key={example.label}
                      onClick={() => {
                        setImportText(example.text);
                        document.querySelector('.mcp-import-card textarea')?.focus();
                      }}
                    >
                      {example.label}
                    </button>
                  ))}
                </div>
              )}
            </Card>
          )}
          <Card title="Instalación por el agente" className="mcp-settings-card">
            {admin ? (
              <Switch
                title="El agente puede instalar MCPs por su cuenta"
                desc="Si alguien le pasa un MCP por WhatsApp, un sub agente puede agregarlo. Desactivalo si preferís aprobar cada servidor desde el panel."
                checked={agentCanInstall}
                disabled={settingsBusy}
                onChange={changeAgentInstall}
              />
            ) : (
              <p className="muted">Instalación por el agente: {agentCanInstall ? 'permitida' : 'desactivada'}</p>
            )}
          </Card>
        </>
      )}
      {toastNode}
    </div>
  );
}
