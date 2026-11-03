const sampleTools = [
  { name: 'search_contacts', description: 'Busca contactos por nombre o correo.' },
  { name: 'get_contact', description: 'Muestra los datos de un contacto.' },
  { name: 'create_campaign', description: 'Prepara una campaña de correo.' },
  { name: 'campaign_stats', description: 'Consulta las estadísticas de una campaña.' },
];

let agentCanInstall = false;
let servers = [
  {
    name: 'brevo',
    type: 'http',
    url: 'https://mcp.example.com/brevo',
    headers: { Authorization: '••••••••' },
    command: null,
    args: [],
    env: {},
    enabled: true,
    description: 'Contactos y campañas de correo',
    tools: sampleTools,
    status: 'ok',
    status_msg: null,
    tested_at: new Date().toISOString(),
  },
  {
    name: 'inventario',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@ejemplo/mcp-inventario'],
    env: { API_TOKEN: '••••••••' },
    url: null,
    headers: {},
    enabled: true,
    description: 'Consulta de stock y precios',
    tools: null,
    status: 'error',
    status_msg: 'El servidor rechazó la autenticación: revisá API_TOKEN.',
    tested_at: new Date().toISOString(),
  },
  {
    name: 'navegador',
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@ejemplo/mcp-browser'],
    env: {},
    url: null,
    headers: {},
    enabled: false,
    description: 'Navegación web automatizada',
    tools: null,
    status: null,
    status_msg: null,
    tested_at: null,
  },
];

const copy = (value) => JSON.parse(JSON.stringify(value));
const fail = (message) => Promise.reject(new Error(message));
const normalizeName = (name) =>
  String(name || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-');

function parseImport(text) {
  const input = String(text || '').trim();
  if (!input) throw new Error('Pegá la configuración del MCP');
  if (input.startsWith('{')) {
    let data;
    try {
      data = JSON.parse(input);
    } catch {
      throw new Error('El JSON no es válido');
    }
    const entries =
      data.mcpServers || data.servers || (data.command || data.url ? { [data.name || 'mcp']: data } : data);
    return Object.entries(entries).map(([name, value]) => ({ name: normalizeName(name), ...value }));
  }
  if (/^https?:\/\//i.test(input)) {
    const url = new URL(input);
    return [{ name: normalizeName(url.hostname.replace(/^mcp\./, '').split('.')[0]), type: 'http', url: input }];
  }
  if (/^claude\s+mcp\s+add\s+/i.test(input)) {
    const parts = input.split(/\s+/).slice(3);
    const separator = parts.indexOf('--');
    const head = separator < 0 ? parts : parts.slice(0, separator);
    const command = separator < 0 ? parts.slice(1) : parts.slice(separator + 1);
    const positional = [];
    let transport = 'http';
    for (let index = 0; index < head.length; index++) {
      if (head[index] === '--transport' || head[index] === '-t') transport = head[++index];
      else if (['--env', '-e', '--header', '-H', '--scope', '-s'].includes(head[index])) index++;
      else positional.push(head[index]);
    }
    const name = positional[0] || 'mcp';
    const url = positional.find((part) => /^https?:\/\//i.test(part));
    if (url) return [{ name: normalizeName(name), type: transport === 'sse' ? 'sse' : 'http', url }];
    return [{ name: normalizeName(name), command: command[0], args: command.slice(1) }];
  }
  const command = input.split(/\s+/);
  const pkg = command.slice(1).find((part) => !part.startsWith('-')) || 'mcp';
  return [
    {
      name: normalizeName(pkg.replace(/^@[^/]+\//, '').replace(/^mcp-server-|^server-/, '')),
      command: command[0],
      args: command.slice(1),
    },
  ];
}

// This explicit preview mode never writes to the real API.
export async function demoMcpApi(path, { method = 'GET', body } = {}) {
  if (path === '/mcp' && method === 'GET') return copy({ servers, agentCanInstall });
  if (path === '/mcp/import' && method === 'POST') {
    await new Promise((resolve) => setTimeout(resolve, 700));
    let added;
    try {
      added = parseImport(body?.text).map((definition) => ({
        name: definition.name,
        type: definition.type || (definition.url ? 'http' : 'stdio'),
        command: definition.command || null,
        args: definition.args || [],
        env: definition.env || {},
        url: definition.url || null,
        headers: definition.headers || {},
        enabled: true,
        description: definition.description || '',
        tools: sampleTools.slice(0, 2),
        status: 'ok',
        status_msg: null,
        tested_at: new Date().toISOString(),
      }));
    } catch (error) {
      return fail(error.message);
    }
    servers = [...servers.filter((server) => !added.some((item) => item.name === server.name)), ...added];
    return copy({ servers: added });
  }
  if (path === '/mcp-settings' && method === 'PUT') {
    agentCanInstall = !!body?.agentCanInstall;
    return { agentCanInstall };
  }
  const match = path.match(/^\/mcp\/([^/]+)(?:\/(test|enabled))?$/);
  if (!match) return fail('Ruta de demostración desconocida');
  const name = decodeURIComponent(match[1]);
  const index = servers.findIndex((server) => server.name === name);
  if (method === 'PUT') {
    const server = {
      ...servers[index],
      ...body,
      name,
      enabled: index < 0 ? true : servers[index].enabled,
      status: null,
      status_msg: null,
      tools: null,
      tested_at: null,
    };
    if (index < 0) servers.push(server);
    else servers[index] = server;
    return copy(server);
  }
  if (index < 0) return fail('El MCP no existe');
  if (method === 'DELETE') {
    servers.splice(index, 1);
    return { ok: true };
  }
  if (match[2] === 'enabled' && method === 'POST') servers[index].enabled = !!body?.enabled;
  if (match[2] === 'test' && method === 'POST') {
    await new Promise((resolve) => setTimeout(resolve, 700));
    servers[index] = {
      ...servers[index],
      tools: sampleTools.slice(0, 2),
      status: 'ok',
      status_msg: null,
      tested_at: new Date().toISOString(),
    };
  }
  return copy(servers[index]);
}
