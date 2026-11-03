// Levanta el panel en modo DEMO con datos realistas (contactos, conversaciones, tareas, personalidades) para diseñar/probar el front.
//   node scripts/dev-demo.mjs        → http://localhost:4990  (admin / admin123)
// Usa una carpeta temporal; no toca datos reales ni habla con WhatsApp ni con Claude.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = process.env.DEMO_DIR || path.join(os.tmpdir(), 'kiri-demo');
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(path.join(dir, 'agent'), { recursive: true });
// The real /api/models route reads Claude Code's /model output. This stub gives the demo a realistic catalog.
const demoClaudeBin = path.join(dir, 'claude-demo.mjs');
fs.writeFileSync(
  demoClaudeBin,
  `#!/usr/bin/env node
import fs from 'node:fs';
if (process.argv.includes('/model')) {
  fs.writeSync(1, 'Current model: Sonnet 5.5 (default)\\nAvailable: default, best, sonnet, opus, haiku, fable, sonnet[1m], opus[1m], opusplan, or a full model ID.\\n');
} else {
  fs.writeSync(1, ${JSON.stringify('{"type":"result","is_error":false,"result":"(respuesta de prueba del modo demo)","total_cost_usd":0}\n')});
}
`,
);
fs.chmodSync(demoClaudeBin, 0o755);
Object.assign(process.env, {
  DATA_DIR: dir,
  WORK_DIR: path.join(dir, 'work'),
  PORT: process.env.PORT || '4990',
  ADMIN_USER: 'admin',
  ADMIN_PASSWORD: 'admin123',
  AGENT_TOKEN: 'demo',
  KIRI_SKIP_RECOVERY: '1',
  JWT_SECRET: 'demo-secret',
  CLAUDE_BIN: demoClaudeBin,
});
const { db } = await import('../server/src/db.js');
const P = await import('../server/src/personas.js');
P.seedPersonas(path.join(root, 'agent-seed/CLAUDE.md'));

const casual = P.createPersona(
  {
    name: 'Vendedor casual',
    content:
      '# Vendedor casual\n\nSos relajado, usás "che" y mensajes cortos. Cerrás ventas sin presionar.\n\n## Reglas\n- Nunca prometas descuentos que no existan.\n',
    mcp: ['brevo'],
    skills: ['catalogos-pdf', 'comparar-precios'],
  },
  'demo',
);
const formal = P.createPersona(
  {
    name: 'Soporte formal',
    content: '# Soporte formal\n\nTratás de usted, con precisión y calma. Resolvés dudas técnicas paso a paso.\n',
    mcp: [],
    skills: [],
  },
  'demo',
);

// MCPs locales de muestra: la demo no intenta conectarse a servicios externos.
const MCP = await import('../server/src/mcp.js');
MCP.saveServer(
  MCP.normalize('brevo', {
    type: 'http',
    url: 'https://mcp.example.test/brevo',
    description: 'Campañas, contactos y envíos de correo.',
  }),
);
MCP.saveServer(
  MCP.normalize('productos', {
    type: 'stdio',
    command: 'npx',
    args: ['-y', '@ejemplo/mcp-productos'],
    description: 'Consulta precios y existencias del catálogo.',
  }),
);
MCP.saveServer(
  MCP.normalize('archivados', {
    type: 'http',
    url: 'https://mcp.example.test/archivados',
    description: 'Busca documentos antiguos.',
  }),
);
db.prepare("UPDATE mcp_servers SET status = 'ok', tools = ? WHERE name = 'brevo'").run(
  JSON.stringify([
    { name: 'contacts', description: 'Consulta contactos.' },
    { name: 'campaigns', description: 'Lista campañas.' },
    { name: 'send_email', description: 'Envía correos.' },
    { name: 'templates', description: 'Consulta plantillas.' },
  ]),
);
db.prepare("UPDATE mcp_servers SET status = 'ok', tools = ? WHERE name = 'productos'").run(
  JSON.stringify([
    { name: 'search_products', description: 'Busca productos.' },
    { name: 'stock', description: 'Consulta existencias.' },
  ]),
);
MCP.setEnabled('archivados', false);

const PersonaConfig = await import('../server/src/persona.js');
PersonaConfig.initAgentDir();
PersonaConfig.writeSettings({
  ...PersonaConfig.readSettings(),
  timezone: 'America/Asuncion',
  skillLearning: true,
  memoryAuto: true,
  allowedTools: ['WebSearch', 'WebFetch', 'Bash'],
});
// La demo usa las rutas reales de /api/personas/:id/settings; solo sembramos un ajuste propio.
P.saveSettingsFor(casual.id, {
  ...PersonaConfig.readSettings(),
  model: 'haiku',
  allowedTools: ['WebSearch', 'WebFetch'],
  permissionMode: 'default',
  maxTurns: 8,
});
PersonaConfig.writeSkill(
  'catalogos-pdf',
  '---\nname: catalogos-pdf\ndescription: Crear catálogos PDF claros a partir de una lista de productos.\n---\n\n# Catálogos PDF\n\n1. Revisar los productos y precios.\n2. Ordenar por categoría.\n3. Generar el PDF y verificar cada página.\n',
  'auto',
);
PersonaConfig.writeSkill(
  'comparar-precios',
  '---\nname: comparar-precios\ndescription: Comparar precios públicos y resumir diferencias.\n---\n\n# Comparar precios\n\n1. Buscar las fuentes públicas.\n2. Verificar fechas y moneda.\n3. Entregar una tabla con la comparación.\n',
  'auto',
);
await import('../server/src/learn.js');
db.prepare('INSERT INTO skill_log (name, action, task_id, summary, created_at) VALUES (?, ?, ?, ?, ?)').run(
  'catalogos-pdf',
  'create',
  1,
  'Aprendió a estructurar y revisar catálogos PDF.',
  new Date(Date.now() - 3 * 864e5).toISOString(),
);
db.prepare('INSERT INTO skill_log (name, action, task_id, summary, created_at) VALUES (?, ?, ?, ?, ?)').run(
  'comparar-precios',
  'create',
  2,
  'Guardó un procedimiento para comparar precios públicos.',
  new Date(Date.now() - 2 * 864e5).toISOString(),
);
db.prepare('INSERT INTO skill_log (name, action, task_id, summary, created_at) VALUES (?, ?, ?, ?, ?)').run(
  'catalogos-pdf',
  'update',
  3,
  'Mejoró la verificación de páginas y anexos.',
  new Date(Date.now() - 864e5).toISOString(),
);
db.prepare('INSERT INTO skill_log (name, action, task_id, summary, created_at) VALUES (?, ?, ?, ?, ?)').run(
  'comparar-precios',
  'update',
  4,
  'Añadió comprobación de moneda y fecha.',
  new Date().toISOString(),
);

const ago = (min) => new Date(Date.now() - min * 60e3).toISOString().slice(0, 19).replace('T', ' ');
const contacts = [
  ['595981123456@s.whatsapp.net', 'Ana Gómez', null, 3],
  ['595982555666@s.whatsapp.net', 'Carlos Benítez', casual.id, 18],
  ['595971222333@s.whatsapp.net', 'Lucía Fernández', formal.id, 55],
  ['595985444111@s.whatsapp.net', 'Distribuidora Norte', casual.id, 130],
  ['595961777888@s.whatsapp.net', 'Marcos Ruiz', null, 400],
  ['120363041234567890@g.us', 'Grupo Compras', null, 7],
  ['120363049876543210@g.us', 'Equipo Ventas', null, 28],
  ['595991000222@s.whatsapp.net', null, null, 1500],
];
for (const [jid, name, pid, minAgo] of contacts) {
  db.prepare(
    'INSERT INTO contacts (jid, name, session_id, session_started, persona_id, last_message_at) VALUES (?, ?, ?, 1, ?, ?)',
  ).run(jid, name, crypto.randomUUID(), pid, ago(minAgo));
}
db.prepare('UPDATE contacts SET paused = 1 WHERE jid = ?').run('595961777888@s.whatsapp.net');

const Memory = await import('../server/src/memory.js');
Memory.writeGlobal(
  '# Negocio\n- Horario de atención: lunes a viernes de 9:00 a 18:00.\n- Los precios se muestran en guaraníes.\n- En compras superiores a 500.000 Gs, el envío a Asunción es gratis.\n',
);
Memory.writeContact(
  contacts[0][0],
  '# Ana Gómez\n- Prefiere recibir catálogos en PDF.\n- Busca zapatillas runner en talle 42.\n- Pide respuestas breves y claras.\n',
);
Memory.writeContact(
  contacts[3][0],
  '# Distribuidora Norte\n- Compra al por mayor para tres sucursales.\n- Necesita facturas con RUC.\n- Prefiere coordinar entregas los miércoles.\n',
);
Memory.writeContact(
  contacts[5][0],
  '# Grupo Compras\n- Martín suele retirar los insumos.\n- Sara confirma la lista final antes de cada compra.\n',
);

const Schedules = await import('../server/src/schedules.js');
const futureDate = new Date(Date.now() + 2 * 864e5).toLocaleDateString('sv-SE', { timeZone: 'America/Asuncion' });
Schedules.createSchedule(
  contacts[0][0],
  {
    title: 'Recordar la reunión de catálogo',
    instructions: 'Avisar a Ana sobre la reunión del catálogo.',
    at: `${futureDate} 09:00`,
  },
  'panel',
);
Schedules.createSchedule(
  contacts[1][0],
  {
    title: 'Resumen diario de ventas y stock',
    instructions: 'Preparar un resumen de ventas y stock.',
    cron: '0 9 * * 1-5',
  },
  'agente',
);
const pausedSchedule = Schedules.createSchedule(
  contacts[2][0],
  { title: 'Revisar incidencias de soporte', instructions: 'Preguntar si hay incidencias nuevas.', cron: '0 10 * * *' },
  'panel',
);
Schedules.pauseSchedule(pausedSchedule.id);
const errorSchedule = Schedules.createSchedule(
  contacts[3][0],
  {
    title: 'Enviar lista semanal de precios',
    instructions: 'Preparar la lista de precios y enviarla.',
    cron: '0 17 * * 1',
  },
  'agente',
);
db.prepare('UPDATE schedules SET last_error = ?, last_run = ?, runs = 1 WHERE id = ?').run(
  'No se pudo abrir la planilla de precios (permiso denegado).',
  Date.now() - 864e5,
  errorSchedule.id,
);

const msg = (jid, role, content, minAgo, extra = {}) =>
  db
    .prepare('INSERT INTO messages (jid, role, content, duration_ms, sender, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(jid, role, content, extra.ms ?? null, extra.sender ?? null, ago(minAgo));

const groupRules = await import('../server/src/rules.js');
groupRules.writeRules({
  ...groupRules.readRules(),
  groups: true,
  groupMode: 'context',
  groupContextMinutes: 12,
  groupReplyToBot: true,
  groupUseName: true,
  groupKeywords: ['kiri'],
  groupHistory: 30,
  groupFilter: {
    any: false,
    text: true,
    audio: true,
    image: true,
    video: false,
    document: true,
    sticker: false,
    emojiReply: false,
  },
  groupFilterOverrides: { [contacts[5][0]]: { audio: false, video: true } },
  groupOverrides: { [contacts[6][0]]: 'all' },
});

const A = contacts[0][0];
msg(A, 'user', 'Hola! Necesito el catálogo de zapatillas actualizado', 34);
msg(A, 'assistant', '¡Hola Ana! Claro, ahora mismo te lo preparo. ¿Lo querés en PDF o en Excel?', 34, { ms: 4200 });
msg(A, 'user', 'En PDF porfa', 33);
msg(A, 'system', '🧩 Tarea #1 delegada a un sub agente: Catálogo de zapatillas en PDF', 33);
msg(A, 'assistant', 'Dale, ya me puse con eso. Apenas esté listo te aviso 👟', 33, { ms: 6100 });
msg(A, 'system', '✅ Tarea #1 terminada: Catálogo de zapatillas en PDF', 31);
msg(
  A,
  'assistant',
  'Listo Ana, acá tenés el catálogo con las 12 zapatillas y sus precios en guaraníes.\n📎 catalogo-zapatillas.pdf',
  31,
  { ms: 5300 },
);
msg(A, 'user', '🎤 Perfecto, y me podés decir si el modelo runner viene en talle 42?', 5);
msg(A, 'assistant', 'Sí, el runner viene del 36 al 45. En el 42 quedan 6 pares.', 4, { ms: 3800 });
msg(A, 'user', '🖼️ Imagen\nEsta es la que me gusta', 3);
const B = contacts[1][0];
msg(B, 'system', '🔄 Personalidad aplicada: Vendedor casual', 60);
msg(B, 'user', 'che, tenés stock de las camperas?', 20);
msg(B, 'assistant', 'Sí che, quedan de la azul y la negra. ¿Qué talle buscás?', 19, { ms: 3300 });
msg(B, 'user', 'M', 18);
const C = contacts[2][0];
msg(C, 'user', 'Buenas tardes, no puedo ingresar a mi cuenta.', 58);
msg(C, 'assistant', 'Buenas tardes, Lucía. Con gusto la ayudo. ¿Recibe algún mensaje de error al ingresar?', 57, {
  ms: 4900,
});
msg(C, 'user', '📎 captura-error.png\nAsí me aparece', 55);

// mensajes largos / con Markdown / con URLs sin cortes: ponen a prueba el recorte de textos en listas y el desborde horizontal
const D = contacts[3][0];
msg(
  D,
  'user',
  'Necesito saber todo sobre la promo, los plazos de entrega, las formas de pago, el costo de envío al interior del país y si se puede retirar en sucursal, además del enlace https://ejemplo.com/catalogo/2026/temporada-otono-invierno/zapatillas-urbanas-edicion-limitada?utm_source=whatsapp&utm_campaign=promo_otono_invierno_2026_paraguay',
  140,
);
msg(
  D,
  'assistant',
  'Te cuento todo en orden:\n\n1. **Plazos de entrega:** 48 a 72 horas hábiles en Asunción y Gran Asunción, y de 4 a 6 días hábiles para el interior del país, según la ruta de la empresa transportadora.\n2. **Formas de pago:** transferencia, tarjeta de débito o crédito en hasta 6 cuotas sin interés, y efectivo contra entrega solo en Asunción.\n3. **Envío:** gratis en compras mayores a 500.000 Gs; por debajo de ese monto cuesta 25.000 Gs en Asunción y 40.000 Gs al interior.\n\nSi querés, te armo un PDF con todo esto y la lista de sucursales para retirar. `retiro_sucursal` está disponible en 4 locales.',
  131,
  { ms: 7400 },
);

// respuestas con cita ("responder" de WhatsApp): una enlazada a un mensaje del chat y otra cuyo original no está en el historial
const quotedAssistant = db
  .prepare("SELECT id FROM messages WHERE jid = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1 OFFSET 1")
  .get(A);
db.prepare(
  "INSERT INTO messages (jid, role, content, quoted, quoted_id, created_at) VALUES (?, 'user', ?, ?, ?, ?)",
).run(
  A,
  'Y esto qué significa? Lo del 70%',
  'Listo Ana, acá tenés el catálogo con las 12 zapatillas y sus precios en guaraníes.',
  quotedAssistant?.id ?? null,
  ago(2),
);
db.prepare(
  "INSERT INTO messages (jid, role, content, quoted, quoted_id, created_at) VALUES (?, 'assistant', ?, ?, ?, ?)",
).run(
  A,
  'Ahí lo dijiste: el 70% es la asistencia mínima para aprobar. Si querés te explico cómo se calcula.',
  'Y esto qué significa? Lo del 70%',
  null,
  ago(2),
);
db.prepare(
  "INSERT INTO messages (jid, role, content, quoted, quoted_id, created_at) VALUES (?, 'user', ?, ?, NULL, ?)",
).run(
  A,
  'Pasame eso de nuevo porfa',
  'Dura 80 horas de clases (síncronas y asíncronas) más 10 de proyecto final. Para aprobar necesitás un 70% o más entre cuestionarios y trabajo final. Con 70% de asistencia a las clases síncronas te dan un certificado de participación. Los docentes tienen másteres y certificaciones como CEH y OSCP.',
  ago(1),
);

// En grupos se conserva quién habló, incluso en los mensajes que el agente solo escuchó.
const G1 = contacts[5][0];
msg(G1, 'user', '¿Ya definimos quién compra los insumos?', 12, { sender: 'Sara López' });
msg(G1, 'user', 'Yo puedo pasar por el local mañana.', 10, { sender: 'Martín Rojas' });
msg(G1, 'user', '@Kiri, ¿podés resumir lo que acordamos?', 9, { sender: 'Sara López' });
msg(G1, 'assistant', 'Claro: Martín puede pasar mañana por el local. Falta confirmar la lista de insumos.', 8, {
  ms: 4100,
});
msg(G1, 'user', 'Perfecto, después mando la lista.', 7, { sender: 'Martín Rojas' });
const G2 = contacts[6][0];
msg(G2, 'user', 'Tenemos la reunión con el cliente a las 15:00.', 32, { sender: 'Laura Duarte' });
msg(G2, 'user', 'Preparo la propuesta comercial.', 30, { sender: 'Diego Vera' });
msg(G2, 'assistant', 'Anotado. Puedo ayudar a revisar la propuesta cuando esté lista.', 28, { ms: 3300 });

const task = (jid, title, status, result, minAgo, files = []) =>
  db
    .prepare(
      'INSERT INTO tasks (jid, title, instructions, status, result, files, created_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .run(
      jid,
      title,
      'Instrucciones de ejemplo para el sub agente.',
      status,
      result,
      JSON.stringify(files),
      ago(minAgo),
      status === 'running' ? null : ago(minAgo - 2),
    );
task(A, 'Catálogo de zapatillas en PDF', 'done', 'Generé un PDF de una hoja con 12 modelos.', 33, [
  { fileName: 'catalogo-zapatillas.pdf', size: 48213 },
]);
task(A, 'Comparar precios de la competencia', 'running', null, 2);
task(B, 'Planilla de stock de camperas', 'failed', null, 25);
task(
  D,
  'Crear una propuesta comercial completa con precios, plazos de entrega y condiciones para las tres sucursales',
  'done',
  'Preparé una propuesta para las tres sucursales. Incluye precios por volumen, seis opciones de entrega y los medios de pago disponibles.\n\n**Próximos pasos:** revisar el stock actualizado, confirmar la dirección de cada sucursal y enviar la propuesta final antes del viernes. Adjunté la planilla con el detalle por producto y el PDF de presentación.',
  80,
  [
    { fileName: 'propuesta-distribuidora-norte.pdf', size: 92341 },
    { fileName: 'precios-y-stock-por-sucursal.xlsx', size: 38214 },
  ],
);
task(C, 'Investigar por qué falla el inicio de sesión cuando el contacto usa el enlace antiguo', 'running', null, 8);
db.prepare("UPDATE tasks SET error = 'no pude abrir la planilla compartida (403)' WHERE status = 'failed'").run();

await import('../server/src/index.js');
console.log(`\n  Demo del panel: http://localhost:${process.env.PORT}   (admin / admin123)\n`);
