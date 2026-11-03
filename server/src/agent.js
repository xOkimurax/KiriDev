// Runner del Claude Code aislado: un `claude -p` por mensaje, con sesión persistente por contacto.
import { activeConfig, clearNeedsAuth } from './mcp.js';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, DATA_DIR } from './db.js';
import { AGENT_DIR, HOME_DIR, readSettings } from './persona.js';
import { shouldIgnore, readRules, groupModeFor, isAddressed, filterFor, passesFilter, messageType, memberAllowed, memberRestricted, senderNumber, privateTypeAllowed } from './rules.js';
import * as evo from './evolution.js';
import { INBOX, WORK_DIR, UserFacingError, buildPrompt, inboxDir, outboxDir, stashMedia, describeStashed } from './media.js';
import { describe } from './files.js';
import { COOKIES_FILE } from './secrets.js';
import { hashOf, resolveFor, settingsFor, getPersona } from './personas.js';
import { decryptEdit, knownLids } from './edits.js';
import { memoryBlock } from './memory.js';
import { splitKey, accountOf, getAccount, noteSeen } from './accounts.js';
import { readAttentionSettings, alertOwners } from './attention.js';
import { getOffice, isOpen } from './office.js';
import { panelsOnFor, readPanelSettings, autoSaveDocs } from './panel-settings.js';
import { runOpencode, deleteOcSession, askOpencode } from './opencode.js';
import { usePanelLogin } from './claude-login.js';
import { DEFAULT_MODEL, logUsage, logEvent, ENGINE_LABEL, planFor, pickRun, classifyLimit, markPaused, clearPause, isPaused, readEngineSettings, untilText } from './engines.js';
import { maybeAutoProfile } from './profile.js';
import * as outreach from './outreach.js';
import * as apps from './apps.js';
import * as voice from './voice.js';

// token de uso interno (solo lo conoce el hub y el servidor MCP que lanza): permite que el agente delegue tareas
export const INTERNAL_TOKEN = process.env.KIRI_INTERNAL_TOKEN || crypto.randomBytes(24).toString('hex');

const queues = new Map(); // jid -> Promise (serializa los turnos del mismo contacto)

/** Encola un turno de este contacto: nunca corren dos a la vez (mensajes y avisos de tareas terminadas). */
export function enqueue(jid, fn) {
  const prev = queues.get(jid) || Promise.resolve();
  const job = prev.catch(() => {}).then(fn);
  queues.set(jid, job);
  job.finally(() => { if (queues.get(jid) === job) queues.delete(jid); }).catch(() => {});
  return job;
}

export function getContact(jid, name) {
  let c = db.prepare('SELECT * FROM contacts WHERE jid = ?').get(jid);
  if (!c) {
    const sid = crypto.randomUUID();
    db.prepare('INSERT INTO contacts (jid, name, session_id) VALUES (?, ?, ?)').run(jid, jid.endsWith('@g.us') ? null : name || null, sid);
    db.prepare("INSERT OR IGNORE INTO session_log (session_id, jid, kind) VALUES (?, ?, 'chat')").run(sid, jid);
    c = db.prepare('SELECT * FROM contacts WHERE jid = ?').get(jid);
  } else if (name && name !== c.name && !jid.endsWith('@g.us')) {
    db.prepare('UPDATE contacts SET name = ? WHERE jid = ?').run(name, jid);
  }
  return c;
}

/** ¿Existe en disco la transcripción de esta sesión de Claude? (si falta, `--resume` falla y se perdería la memoria) */
export function sessionExists(id) {
  const root = path.join(HOME_DIR, '.claude', 'projects');
  try { return fs.readdirSync(root).some((d) => fs.existsSync(path.join(root, d, `${id}.jsonl`))); } catch { return false; }
}

/** Historial reciente del chat (lo que ve el panel) para reconstruir el contexto cuando la memoria interna se perdió. */
function recoveredContext(jid) {
  const rows = db.prepare("SELECT role, content FROM messages WHERE jid = ? AND role != 'system' ORDER BY id DESC LIMIT 41").all(jid).reverse();
  if (rows.length && rows[rows.length - 1].role === 'user') rows.pop(); // el mensaje actual va aparte
  if (!rows.length) return '';
  const lines = rows.map((m) => `${m.role === 'user' ? 'Persona' : 'Vos'}: ${String(m.content).replace(/\s+/g, ' ').slice(0, 500)}`);
  return `[CONTEXTO RECUPERADO — no lo menciones tal cual: la memoria interna de esta conversación se perdió, pero este es el historial reciente (del más viejo al más nuevo). Retomá desde acá con naturalidad, como si lo recordaras.]\n${lines.join('\n')}\n[FIN DEL CONTEXTO RECUPERADO]\n\n`;
}

/** Si la sesión del contacto ya no existe en disco, abre una nueva y devuelve el contexto reconstruido ('' si no hizo falta). */
export function recoverIfLost(jid) {
  const c = db.prepare('SELECT * FROM contacts WHERE jid = ?').get(jid);
  if (!c || !c.session_started || sessionExists(c.session_id)) return '';
  if (settingsFor(resolveFor(c)).engine === 'opencode') return ''; // con OpenCode la sesión de Claude no existe ni hace falta
  console.error(`[sesión] la memoria de ${jid} se perdió (falta ${c.session_id}); se reconstruye desde el historial`);
  resetSession(jid);
  return recoveredContext(jid);
}

export function resetSession(jid) {
  const old = db.prepare('SELECT oc_session FROM contacts WHERE jid = ?').get(jid)?.oc_session;
  if (old) { deleteOcSession(old); db.prepare('UPDATE contacts SET oc_session = NULL WHERE jid = ?').run(jid); }
  const sid = crypto.randomUUID();
  db.prepare('UPDATE contacts SET session_id = ?, session_started = 0 WHERE jid = ?').run(sid, jid);
  db.prepare("INSERT OR IGNORE INTO session_log (session_id, jid, kind) VALUES (?, ?, 'chat')").run(sid, jid);
}

const MCP_SERVER = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'agent-mcp.js');
const MEMORY_TOOLS = ['mcp__kiri__remember', 'mcp__kiri__forget'];
const SCHEDULE_TOOLS = ['mcp__kiri__schedule_create', 'mcp__kiri__schedule_list', 'mcp__kiri__schedule_cancel'];
const SKILLS_DIR = path.join(AGENT_DIR, '.claude', 'skills');
/** Carpeta de trabajo temporal con SOLO las skills permitidas (enlaces a las reales): Claude Code carga las skills de su carpeta de trabajo. */
function skillView(allow) {
  const dir = path.join(DATA_DIR, 'runs', crypto.randomBytes(6).toString('hex')); // fuera de /data/agent: Claude Code también carga las skills de las carpetas padre
  const dest = path.join(dir, '.claude', 'skills');
  fs.mkdirSync(dest, { recursive: true });
  for (const name of allow) { const src = path.join(SKILLS_DIR, name); if (fs.existsSync(path.join(src, 'SKILL.md'))) fs.symlinkSync(src, path.join(dest, name), 'dir'); }
  return dir;
}
const FILE_TOOLS = ['write_file', 'make_document', 'download_file', 'download_media', 'send_file'].map((t) => `mcp__kiri__${t}`);
const CAPS = `Podés crear y enviar archivos por WhatsApp con tus herramientas:
- write_file: crea un archivo de texto/código/CSV/JSON/HTML/etc. (o cualquier binario pequeño en base64).
- make_document: genera un PDF, DOCX, XLSX o ZIP reales.
- download_file: baja un archivo desde un enlace público (imagen, PDF, documento, lo que sea).
- download_media: baja un VIDEO o el AUDIO (mp3) de TikTok, Instagram, Twitter/X, Vimeo, SoundCloud, etc.
- send_file: ENVÍA un archivo a la persona. Puede ser uno que creaste o bajaste, o uno que ella te mandó (rutas en tu carpeta de recibidos).
Crear un archivo NO lo envía: para entregarlo tenés que llamar a send_file. Acompañalo siempre con un mensaje corto de texto.
Enviá solo lo que la persona pidió o lo que claramente le sirve, como máximo 5 archivos por respuesta. Nunca inventes enlaces: si necesitás un archivo de internet, bajalo con download_file.
Si te pasan un MCP (JSON, URL, comando o una línea "claude mcp add …"), instalalo con add_mcp_server pasándole el texto tal cual, o ejecutando "claude mcp add …" en Bash: las dos formas valen, el sistema lo registra solo en el panel y queda disponible desde la próxima tarea. Si el MCP PIDE INICIAR SESIÓN (error de autenticación / OAuth), no le digas a la persona que no se puede: usá mcp_login_link con su nombre y pasale el enlace COMPLETO para que lo abra en su celular o navegador; cuando termine, el sistema le avisa solo.
Si tenés Bash y necesitás instalar programas del sistema, usá "kiri-install apt <paquetes>" (o "kiri-install cmd '<comando>'"): instala ahora y lo deja registrado para que sobreviva a los redespliegues (lo que instales de otra forma se pierde). Tenés Chromium en /usr/bin/chromium.
Hablá simple, sin jerga técnica (nada de npm, compilar, tokens, plugins…) salvo que la persona sea técnica. Si el sistema de seguridad te bloquea una acción (por ejemplo ejecutar código de un proyecto que encontraste vos y no te pidieron), decilo en una frase y qué hacer: "mi seguridad no me deja ejecutar programas que elijo yo; si me pedís vos exactamente qué instalar o ejecutar, lo intento". No pidas "permisos" que la persona no puede darte desde WhatsApp. Si el obstáculo real es otro (por ejemplo YouTube bloquea servidores), no te pongas a buscar rodeos con programas externos: explicá el motivo y las opciones.
SIEMPRE explicá con claridad lo que pasó: si no pudiste conseguir o enviar algo, decile a la persona QUÉ intentaste y POR QUÉ falló (el motivo exacto que te devolvió la herramienta, en tus palabras) y qué alternativa hay (otro enlace, solo el audio, otra calidad, pasarle el enlace directo). Nunca respondas solo "tuve un problema" ni digas que no podés sin intentarlo.
Sé directo para no gastar pasos: para una imagen o archivo buscá una vez, elegí una URL que apunte directo al archivo (.jpg, .png, .pdf…) y bajala; si tras 2 o 3 intentos no lo conseguís, contale a la persona qué probaste en vez de seguir.`;
const CAPS_DELEGATE = `Modo coordinador: vos solo conversás. Podés leer los archivos que la persona te mande (para entenderlos) y delegar. NO tenés herramientas para buscar en la web, descargar, crear ni enviar archivos ni ejecutar comandos: eso lo hace un sub agente. Ante CUALQUIER pedido de hacer, buscar, descargar, generar, enviar, pasar, investigar o revisar algo, llamá SIEMPRE a delegate_task({title, instructions}) —aunque parezca simple— con instrucciones completas y autosuficientes (el sub agente no ve esta conversación; si hace falta un archivo que mandó la persona, pasale su ruta exacta, que figura en el mensaje). Apenas la llamás, escribile a la persona un mensaje corto avisando que ya estás en eso y que le avisás cuando termine; no esperes el resultado ni lo inventes. Cuando el sub agente termina, el sistema te manda un aviso interno con el resultado y entonces le escribís a la persona. Si intentás usar una herramienta y te dice que está deshabilitada, no es un error ni una falta de permisos: significa que ese trabajo lo hace un sub agente, así que delegalo. NUNCA le digas a la persona que no tenés permisos, acceso a internet o herramientas. Los números como [mensaje #N] o #N son referencias INTERNAS del sistema: la persona no las ve ni las conoce, así que NUNCA los menciones ni los escribas en tus respuestas (ni "el mensaje #197" ni nada parecido): para referirte a un mensaje usá quote_message y/o citá sus palabras ("cuando me dijiste que…"). CITAR (función "responder" de WhatsApp): usá quote_message SIEMPRE que tu respuesta se refiera a un mensaje puntual —de la persona, tuyo o de otra persona del grupo— o cuando la persona te esté contestando/citando algo: preguntas tipo "¿dónde/cuándo dije…?", "¿qué te dije de…?", aclaraciones sobre algo dicho antes, corregir o retomar un tema anterior, o contestar entre varios temas o personas a la vez. Casos típicos donde SIEMPRE se cita: "¿dónde?", "¿cuándo?", "¿qué número/cosa dije?", "no veo el mensaje", "pasame/mostrame ese mensaje", "¿qué te dije de…?", cuando la persona te cita o responde a un mensaje, y cuando corregís o aclarás algo que se dijo antes. Ante la duda entre citar o no cuando el tema es un mensaje puntual, CITÁ. No hace falta que te lo pidan: hacelo por tu cuenta. En un intercambio simple de a dos donde contestás justo lo último que se dijo, no la uses. Llamala ANTES de escribir la respuesta. RECORDATORIOS Y TAREAS PROGRAMADAS: si la persona te pide que le recuerdes algo o que hagas algo más tarde o cada cierto tiempo ("recordame mañana a las 9", "avisame el viernes", "todas las mañanas mandame las noticias"), usá schedule_create. Calculá la fecha a partir de [Ahora: …] que figura en cada mensaje (hora local de esa zona). Para una vez: at="AAAA-MM-DD HH:mm"; para repetir: cron de 5 campos (ej. "0 9 * * 1-5" = lunes a viernes a las 9). En instructions escribí qué hay que decirle o hacer cuando llegue la hora, con todos los datos (después no vas a recordar esta charla). Confirmale a la persona qué quedó programado y cuándo, en lenguaje natural. Con schedule_list ves lo programado y con schedule_cancel lo cancelás. Respondé directo solo a charla, saludos, preguntas de conocimiento general y aclaraciones. Máximo 3 tareas en curso por persona.`;
const PANEL_TOOLS = ['document_save', 'panel_link', 'panel_overview', 'collection_create', 'collection_add_field', 'rows_add', 'rows_find', 'rows_update', 'rows_delete', 'panel_create', 'panel_update'].map((t) => `mcp__kiri__${t}`);
const PANELS_NOTE = (suggest) => `PANELES DEL USUARIO: el dueño tiene en su panel web secciones (paneles) que vos podés armar y mantener con tus herramientas (panel_overview, collection_create, rows_add, panel_create, panel_update…). Hay colecciones (tablas de datos: precios, clientes, pedidos, nombres…) y paneles con vistas sobre ellas: tabla, calendario, tablero por estado, nota y resumen numérico. Los recordatorios que programás se ven solos en un calendario ("reminders"). ${suggest ? 'Sé proactivo con criterio: cuando la persona maneje una lista, una agenda, pedidos o datos que le convenga ver ordenados (varios recordatorios, una lista de precios, clientes…), ofrecele en una frase dejarlo en un panel ("¿Querés que te lo deje en un calendario/tabla en tu panel?") y créalo solo si acepta. ' : 'Creá o cambiá paneles solo cuando la persona lo pida. '}Antes de crear algo llamá a panel_overview: si ya existe uno parecido, modificalo en vez de duplicarlo. Cualquier tabla, lista o tablero se puede filtrar y ordenar (por campo, con operadores según el tipo: texto, números, fechas, selección, casillas) desde el botón Filtros; en rows_find y en config.filter de una sección podés dejar un filtro por defecto (por ejemplo «solo pendientes de esta semana»). Para borrar filas, pedí confirmación explícita en la charla. Nunca inventes datos para llenar un panel. Los paneles que armás son SIEMPRE de ESTA conversación (no ves ni tocás los de otras personas). La persona los abre y edita ella misma con su ENLACE PERSONAL, sin contraseña: cuando armes o actualices un panel dáselo con panel_link (completo, tal cual) y decile que es personal; el administrador también los ve en su panel. Los archivos que le enviás a la persona (PDF, Word, Excel, imágenes…) se guardan solos en su sección Documentos si el panel tiene una sección "documents"; con document_save guardás otros (por ejemplo uno que ella te mandó). Sugerí tener esa sección cuando generes documentos. Contale qué quedó guardado y cómo abrirlo.`;
const HANDOFF_NOTE = 'PASAR A UN HUMANO: tenés la herramienta request_human. Usala cuando no sepas algo y no deba inventarse, cuando la persona pida hablar con alguien, esté molesta, haya un reclamo, un pago o una decisión importante, o algo que no podés resolver. Al usarla el dueño recibe el aviso y quizás este chat queda en pausa; avisale a la persona con naturalidad que alguien la va a atender, sin tecnicismos.';
const APP_TOOLS = ['publish_app', 'unpublish_app', 'list_apps'].map((t) => `mcp__kiri__${t}`);
const APPS_NOTE = `DOCKER Y APPS: tenés un Docker propio y aislado (los comandos "docker" y "docker compose" ya apuntan a él): podés crear los contenedores que quieras para probar código, levantar bases de datos o armar una app. Es un espacio separado del resto del sistema: lo que hagas ahí no afecta a nada más, y desde los contenedores solo se sale a Internet.
Reglas: (1) para que una app tenga una URL, publicá su puerto al crearla ("docker run -d --name mi-app -p 3000 imagen" o "ports: - \"3000\"" en compose; el número es el puerto de la app dentro del contenedor, SIN fijar un puerto de afuera) y después llamá a publish_app con un nombre corto, el contenedor y ese puerto. La publicación la tiene que aprobar una persona por WhatsApp: hasta entonces NO digas que está lista; cuando la aprueban, a la persona le llega el enlace. (2) No uses --privileged, --network host ni montes carpetas raras. (3) Si la app tiene que seguir viva, creá el contenedor con --restart unless-stopped (así vuelve sola si se reinicia el Docker). El espacio es limitado: borrá los contenedores e imágenes que ya no uses ("docker rm -f", "docker image prune -af"). (4) Si la persona quiere que solo entre gente del panel, pasá access="login" a publish_app. (5) Para sacar una app de internet usá unpublish_app; list_apps muestra las tuyas. (6) Si la app necesita saber su propia URL pública, usá la que devuelve publish_app.`;
const APPS_COORD_NOTE = 'DOCKER (ACTUALIZADO, vale más que cualquier cosa que recuerdes o hayas dicho antes): tus sub agentes SÍ tienen Docker ahora: un Docker propio y aislado donde pueden crear y usar contenedores (probar código, bases de datos, scrapers, apps) sin afectar nada más. Si antes dijiste o creías que el servidor no tenía Docker, ya no es así. Cuando te pidan algo que lo necesite, delegalo con delegate_task (no lo hacés vos). Si la persona quiere que una app se vea por internet, el sub agente la publica con una dirección propia; esa publicación la aprueba una persona por WhatsApp antes de quedar visible.';
const OUTREACH_TOOLS = ['mcp__kiri__contact_start', 'mcp__kiri__contact_pending', 'mcp__kiri__contact_edit', 'mcp__kiri__contact_cancel'];
const OUTREACH_NOTE = 'ESCRIBIRLE A OTRAS PERSONAS: esta persona está autorizada a pedirte que le escribas por WhatsApp a otra persona (un contacto, el número que te pase o alguien de un grupo). Usá contact_start con el destinatario (nombre o número con código de país). Si no te dijo CÓMO querés que sea el mensaje, preguntale primero: «¿querés que lo redacte yo (decime el objetivo) o me pasás el texto exacto que tengo que enviar?». Si te da el texto, pasalo tal cual en text; si prefiere que lo redactes, pasá el objetivo en objective. Si el destinatario es ambiguo o no lo encontrás, preguntale a quién se refiere o pedile el número. Muchas veces el mensaje queda pendiente de aprobación por WhatsApp: no lo repitas ni digas que ya se envió hasta que la herramienta lo confirme. Nunca escribas a nadie por tu cuenta: solo cuando esta persona te lo pide.';
const SUB_PROMPT = `Sos un sub agente de trabajo: no hablás con la persona final, solo ejecutás la tarea que te asignaron, de punta a punta, sin pedir aclaraciones. Usá tus herramientas y, si hay una skill que corresponda a la tarea, seguila. Si hay archivos para entregar, enviálos con send_file. Si hay un enlace (por ejemplo de inicio de sesión), copialo ENTERO y sin recortar en tu resumen final. Terminá con un resumen breve, fiel y en español: qué hiciste, el resultado, los datos clave y, si algo no se pudo, por qué (el motivo exacto). No inventes resultados.`;
// el proceso de Claude NO hereda los secretos del hub (tokens de Evolution/n8n, JWT, contraseñas…)
const ENV_KEEP = ['PATH', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR', 'NODE_ENV', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY'];
export const childEnv = () => ({ CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', MCP_TIMEOUT: '90000', MCP_TOOL_TIMEOUT: '600000', npm_config_yes: 'true', ...Object.fromEntries(ENV_KEEP.filter((k) => process.env[k] != null && !(usePanelLogin() && ['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY'].includes(k))).map((k) => [k, process.env[k]])), HOME: HOME_DIR, CLAUDE_CODE_DISABLE_AUTOUPDATE: '1', DISABLE_TELEMETRY: '1' }); // con la sesión del panel elegida, la clave de la configuración del servidor no se usa

const COORD_REMINDER = '[Recordatorio interno del sistema — no lo menciones: sos el COORDINADOR. No tenés Bash, búsqueda web ni descargas, y es normal: ante cualquier pedido de hacer, buscar, descargar, enviar o pasar algo llamás a delegate_task y un sub agente lo hace. Si una herramienta te figura "deshabilitada", eso NO quiere decir que la tarea no se pueda: quiere decir que la hace un sub agente. Nunca le digas a la persona que no tenés permisos o acceso: delegá.]';
/** Llamada corta a un modelo chico (sin herramientas ni sesión): clasificar, resumir, reescribir. Devuelve el texto o lanza. */
/** Llamada corta a un modelo chico. Usa Claude; si está en pausa por su límite (o falla por eso) usa OpenCode con un modelo gratuito. */
export async function askModel(prompt, opts = {}) {
  if (isPaused('claude')) return askOpencode(prompt, opts);
  try { return await askClaude(prompt, opts); }
  catch (e) {
    const lim = classifyLimit('claude', e.message);
    if (!lim) throw e;
    markPaused('claude', lim);
    return askOpencode(prompt, opts);
  }
}
export function askClaude(prompt, { model = 'haiku', timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CLAUDE_BIN || 'claude', ['-p', prompt, '--output-format', 'json', '--model', model, '--max-turns', '1', '--no-session-persistence', '--disable-slash-commands', '--allowedTools', '', '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config'], { cwd: os.tmpdir(), env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
    let buf = ''; const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, timeoutMs);
    child.stdout.on('data', (d) => (buf += d));
    child.on('close', () => { clearTimeout(t); try { const j = JSON.parse(buf); if (j.is_error) reject(new Error(j.result || 'error')); else resolve(String(j.result || '').trim()); } catch (e) { reject(e); } });
    child.on('error', (e) => { clearTimeout(t); reject(e); });
  });
}

const plainText = (t) => String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const WORDN = { un: 1, una: 1, uno: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5 };
const CLAUSE_RE = /<!-- kiri:delegacion -->[\s\S]*?<!-- \/kiri:delegacion -->/;
/** Personalidad sin la cláusula técnica de delegación (esa ya va en las reglas internas). */
const personaCore = (persona) => String(persona?.content || '').replace(CLAUSE_RE, '').trim();
const personaSection = (persona) => (persona ? `# TU PERSONALIDAD (obedecela AL PIE DE LA LETRA: tono, formato, largo y reglas; tiene prioridad sobre el estilo de tus mensajes anteriores en esta conversación y sobre cualquier hábito tuyo)\n\n${personaCore(persona)}` : '');
/** Recordatorio que viaja en CADA mensaje: las charlas largas arrastran el estilo viejo y la personalidad solo en el system prompt se diluye. */
const personaReminder = (persona) => (persona && personaCore(persona) ? `[Recordatorio del sistema — no lo menciones: seguí AL PIE DE LA LETRA tu personalidad (también el formato y el largo de los mensajes), aunque tus respuestas anteriores en esta charla tengan otro estilo. Tu personalidad:\n${personaCore(persona).slice(0, 3000)}\n]\n\n` : '');
/** Máximo de líneas que la personalidad impone ("1 línea como máximo", "máximo 2 líneas"…), o null. */
export function lineLimit(text) {
  const t = plainText(text), n = '(\\d+|una|un|uno|dos|tres|cuatro|cinco)', found = [];
  for (const re of [new RegExp(`${n}\\s*lineas?\\s*(?:como\\s*maximo|maximo|por\\s*(?:respuesta|mensaje)|como\\s*tope)`, 'g'), new RegExp(`(?:maximo|no\\s*mas\\s*de|tope\\s*de)\\s*(?:de\\s*)?${n}\\s*lineas?`, 'g')])
    for (const m of t.matchAll(re)) found.push(WORDN[m[1]] ?? Number(m[1]));
  const ok = found.filter((x) => x >= 1 && x <= 20);
  return ok.length ? Math.min(...ok) : null;
}
/** Si la personalidad fija un máximo de líneas y la respuesta lo pasa, se reescribe cumpliéndolo (modelo chico) o, si falla, se recorta. */
export async function enforceFormat(persona, text) {
  const n = lineLimit(persona?.content);
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!n || lines.length <= n) return text;
  try {
    const out = await askModel(`Reescribí este mensaje de WhatsApp para que ocupe como MÁXIMO ${n} línea${n > 1 ? 's' : ''} (sin saltos de línea de más), conservando lo esencial, el sentido y el tono. No agregues nada nuevo. Respondé SOLO con el mensaje reescrito.\n\nMensaje:\n${text}`, { model: 'haiku', timeoutMs: 40000 });
    const fixed = out.split('\n').map((l) => l.trim()).filter(Boolean);
    if (fixed.length && fixed.length <= n) return fixed.join('\n');
  } catch (e) { console.error(`[formato] no pude reescribir: ${e.message}`); }
  return lines.slice(0, n).join('\n');
}

/** Anota un aviso del sistema en el chat (y, si el administrador lo pidió, avisa al dueño por WhatsApp) cuando cambia el motor. */
function engineNote(c, text) {
  if (!c?.jid || c.jid.startsWith('playground:')) { if (c?.jid) db.prepare("INSERT INTO messages (jid, role, content) VALUES (?, 'system', ?)").run(c.jid, text); return; }
  db.prepare("INSERT INTO messages (jid, role, content) VALUES (?, 'system', ?)").run(c.jid, text);
  if (readEngineSettings().notifySwitch) alertOwners(c.jid, `🔀 ${text}`).catch(() => {});
}
/**
 * Ejecuta un turno con el motor de la personalidad. Si ese motor llegó a su límite de uso y hay respaldo, el MISMO turno se reintenta con el otro motor;
 * mientras el principal siga en pausa se usa el respaldo, y cuando vence la pausa se vuelve solo al principal.
 */
export async function runClaude(c, message, settings, persona, opts = {}) {
  const plan = planFor(settings), first = pickRun(plan);
  const attempt = (sel) => runClaudeRaw(c, message, { ...settings, engine: sel.engine, model: sel.model }, persona, opts).then((r) => {
    clearPause(sel.engine);
    logUsage({ jid: c.jid, kind: opts.sub ? 'tarea' : 'charla', engine: sel.engine, model: sel.model, tokens: r.tokens, cost: r.cost, ms: r.ms, fallback: sel.engine !== plan.primary.engine });
    return { ...r, engine: sel.engine, model: sel.model };
  });
  const onFb = (v) => { if (!opts.sub && c.jid) db.prepare('UPDATE contacts SET on_fallback = ? WHERE jid = ?').run(v ? 1 : 0, c.jid); };
  if (!opts.sub && c.session_started) { // aviso solo cuando cambia de verdad el motor que atiende este chat (de principal a respaldo y de vuelta)
    if (first.engine !== plan.primary.engine && !c.on_fallback) engineNote(c, `${ENGINE_LABEL[plan.primary.engine]} está en pausa por su límite de uso: este chat sigue con ${ENGINE_LABEL[first.engine]}.`);
    else if (first.engine === plan.primary.engine && c.on_fallback) engineNote(c, `${ENGINE_LABEL[first.engine]} volvió a estar disponible: este chat vuelve a usarlo.`);
  }
  let r, onBackup = first.engine !== plan.primary.engine;
  try { r = await attempt(first); }
  catch (e) {
    const lim = classifyLimit(first.engine, e.message);
    if (lim) markPaused(first.engine, lim);
    if (lim && plan.fallback && first.engine !== plan.fallback.engine && !isPaused(plan.fallback.engine)) {
      if (!opts.sub) engineNote(c, `${ENGINE_LABEL[first.engine]} llegó a su límite de uso${lim.kind === 'limit' ? ` (hasta ${untilText(lim.until, readSettings().timezone)})` : ''}: sigo con ${ENGINE_LABEL[plan.fallback.engine]}.`);
      console.error(`[motor] ${first.engine} → ${plan.fallback.engine}: ${lim.reason}`);
      logEvent('cambio', first.engine, `${ENGINE_LABEL[first.engine]} → ${ENGINE_LABEL[plan.fallback.engine]}`);
      r = await attempt(plan.fallback); // si el respaldo también falla, el error sube
      onBackup = true;
    } else throw e;
  }
  onFb(onBackup);
  if (!opts.sub && persona && r.text) r = { ...r, text: await enforceFormat(persona, r.text) };
  return r;
}
function runClaudeRaw(c, message, settings, persona, opts = {}) {
  const sub = !!opts.sub;
  if (!sub) message = `${personaReminder(persona)}${COORD_REMINDER}\n\n${message}`;
  const outboxKey = opts.outboxKey || c.jid;
  const panelsOn = sub ? !!opts.panels : panelsOnFor(persona);
  const voiceOn = sub ? !!opts.voice : voice.enabledFor(persona); // notas de voz (ElevenLabs): el coordinador y el sub agente pueden mandarlas
  const appsCoord = !sub && apps.enabledFor(persona); // el coordinador no usa Docker, pero tiene que saber que sus sub agentes sí
  const appsOn = sub && !!opts.apps && apps.available(); // Docker aislado + publicar apps: solo el sub agente (el coordinador no tiene Bash)
  const att = readAttentionSettings();
  const handoff = !sub && att.enabled && (!Array.isArray(att.personas) || (!!persona && att.personas.includes(persona.id)));
  const oc = sub ? { start: false, decide: false } : outreach.toolsFor(c.jid);
  const args = ['-p', message, '--output-format', 'json', '--model', settings.model,
    '--max-turns', String(settings.maxTurns), '--setting-sources', 'project,local'];
  // Read solo puede abrir lo que el usuario mandó (inbox); nunca el resto del disco (secretos, base de datos…)
  const inboxRead = `Read(/${INBOX}/**)`;
  const files = settings.sendFiles !== false;
  const outbox = outboxDir(outboxKey);
  fs.mkdirSync(outbox, { recursive: true });
  fs.rmSync(path.join(outbox, '.queue.jsonl'), { force: true }); // cola vieja de una corrida que murió
  fs.rmSync(path.join(outbox, '.quote.json'), { force: true });
  const mcp = { mcpServers: { kiri: { command: process.execPath, args: [MCP_SERVER], env: {
    KIRI_OUTBOX: outbox, KIRI_INBOX: inboxDir(c.jid), KIRI_WORK: WORK_DIR, PATH: process.env.PATH || '',
    KIRI_HUB_URL: `http://127.0.0.1:${process.env.PORT || 4961}`, KIRI_HUB_TOKEN: INTERNAL_TOKEN, KIRI_JID: c.jid, ...(sub ? { KIRI_SUB: '1' } : {}), ...(panelsOn ? { KIRI_PANELS: '1' } : {}), ...(handoff ? { KIRI_HANDOFF: '1' } : {}), ...(appsOn ? { KIRI_APPS: '1' } : {}), ...(voiceOn ? { KIRI_VOICE: '1' } : {}), ...(oc.start ? { KIRI_OUTREACH: '1' } : {}), ...(oc.decide ? { KIRI_OUTREACH_DECIDE: '1' } : {}),
    ...(fs.existsSync(COOKIES_FILE) ? { KIRI_COOKIES: COOKIES_FILE } : {}) } } } };
  // MCPs de terceros (panel): solo los usa el sub agente que hace el trabajo. Se leen en cada ejecución → sin reiniciar nada.
  const ext = sub ? activeConfig(opts.mcpAllow || null) : { servers: {}, allow: [] }; // opts.mcpAllow: solo los MCPs de la personalidad de este contacto
  Object.assign(mcp.mcpServers, ext.servers);
  clearNeedsAuth(Object.keys(ext.servers));
  args.push('--mcp-config', JSON.stringify(mcp), '--strict-mcp-config');
  let tools, deny = [];
  if (sub) {
    // sub agente: hace el trabajo con todas las herramientas habilitadas en los ajustes
    tools = [...settings.allowedTools.filter((t) => t !== 'Read' && !t.startsWith('Read(')), inboxRead, ...(files ? FILE_TOOLS : []), ...ext.allow, 'mcp__kiri__add_mcp_server', 'mcp__kiri__mcp_login_link', ...MEMORY_TOOLS, ...(panelsOn ? PANEL_TOOLS : []), ...(appsOn ? APP_TOOLS : []), ...(voiceOn ? voice.VOICE_TOOLS : [])];
  } else {
    // agente principal = coordinador: solo lee lo que le mandan y delega. Se le NIEGA todo lo demás (también en modo bypass)
    tools = [inboxRead, 'mcp__kiri__delegate_task', 'mcp__kiri__quote_message', ...(handoff ? ['mcp__kiri__request_human'] : []), ...(oc.start ? OUTREACH_TOOLS : oc.decide ? OUTREACH_TOOLS.slice(1) : []), ...MEMORY_TOOLS, ...SCHEDULE_TOOLS, ...(panelsOn ? PANEL_TOOLS : []), ...(voiceOn ? voice.VOICE_TOOLS : [])];
    deny = ['Bash', 'WebSearch', 'WebFetch', 'Write', 'Edit', 'NotebookEdit', 'Task', ...FILE_TOOLS];
  }
  // La personalidad va en el system prompt (no en un CLAUDE.md compartido): así cada contacto puede tener la suya
  const mem = memoryBlock(c.jid, c.name, { auto: settings.memoryAuto !== false });
  const systemPrompt = sub ? [SUB_PROMPT, files ? CAPS : '', panelsOn ? PANELS_NOTE(false) : '', appsOn ? APPS_NOTE : '', voiceOn ? voice.voiceNote() : '', mem].filter(Boolean).join('\n\n---\n\n') : [CAPS_DELEGATE, appsCoord ? APPS_COORD_NOTE : '', handoff ? HANDOFF_NOTE : '', oc.start ? OUTREACH_NOTE : '', panelsOn ? PANELS_NOTE(readPanelSettings().suggest) : '', voiceOn ? voice.voiceNote() : '', mem, personaSection(persona)].filter(Boolean).join('\n\n---\n\n'); // la personalidad va AL FINAL: es lo último que lee el modelo antes del mensaje
  args.push('--append-system-prompt', systemPrompt);
  args.push('--allowedTools', tools.join(','));
  if (deny.length) args.push('--disallowedTools', deny.join(','));
  if (!sub) args.push('--disable-slash-commands'); // el coordinador no ve las skills (instrucciones para trabajar): eso es del sub agente
  if (settings.permissionMode && settings.permissionMode !== 'default') args.push('--permission-mode', settings.permissionMode);
  args.push(c.session_started && sessionExists(c.session_id) ? '--resume' : '--session-id', c.session_id); // sin sesión de Claude (p. ej. el chat siempre usó OpenCode) se abre una nueva

  // sub agente con lista propia de skills: trabaja en una carpeta que solo expone esas (null = todas, carpeta normal)
  const runDir = sub && Array.isArray(opts.skillsAllow) ? skillView(opts.skillsAllow) : null;
  const cleanRun = () => { if (runDir) fs.rmSync(runDir, { recursive: true, force: true }); };
  // Motor: Claude Code (por defecto) u OpenCode. Mismo rol, mismas instrucciones, herramientas y MCPs; cambia quién ejecuta.
  const engine = settings.engine === 'opencode' ? 'opencode' : 'claude';
  const switched = !sub && !!c.session_started && (c.last_engine || 'claude') !== engine; // el motor nuevo no tiene el hilo del anterior: se reconstruye desde el historial
  const ctxPrefix = switched ? recoveredContext(c.jid) : '';
  const remember = (r) => { if (!sub && c.jid) db.prepare('UPDATE contacts SET last_engine = ?, oc_session = CASE WHEN ? IS NOT NULL THEN ? ELSE oc_session END WHERE jid = ?').run(engine, r?.session || null, r?.session || null, c.jid); return r; };
  if (engine === 'opencode') {
    const fileNames = FILE_TOOLS.map((t) => t.replace('mcp__kiri__', 'kiri_'));
    const prep = { c, settings, sub, systemPrompt, dockerEnv: appsOn ? apps.dockerEnv() : null, mcp: mcp.mcpServers, runDir, cleanRun, opts, inboxDir: inboxDir(c.jid),
      tools: { allowed: sub ? settings.allowedTools : [], fileDenied: sub && files ? [] : fileNames } };
    const go = (cc, msg) => runOpencode({ ...prep, c: cc, message: msg });
    return go(c, ctxPrefix + message).catch((e) => {
      // la sesión de OpenCode ya no existe (volumen nuevo, limpieza…): se abre una nueva con el contexto reconstruido
      if (!sub && c.oc_session && /session.*(not found|no existe)|not ?found/i.test(e.message)) {
        db.prepare('UPDATE contacts SET oc_session = NULL WHERE jid = ?').run(c.jid);
        return go({ ...c, oc_session: null }, recoveredContext(c.jid) + message);
      }
      throw e;
    }).then(remember);
  }
  if (ctxPrefix) args[1] = ctxPrefix + args[1];
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const child = spawn(process.env.CLAUDE_BIN || 'claude', args, {
      cwd: runDir || AGENT_DIR,
      env: { ...childEnv(), ...(appsOn ? apps.dockerEnv() : {}) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    opts.onChild?.(child);
    let out = '', err = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('Timeout esperando a Claude')); }, settings.timeoutSec * 1000);
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    child.on('error', (e) => { clearTimeout(timer); cleanRun(); reject(e); });
    child.on('close', () => {
      clearTimeout(timer); cleanRun();
      try {
        const j = JSON.parse(out);
        if (j.is_error && j.subtype === 'error_max_turns') // se acabaron los pasos: lo ya hecho (p. ej. archivos encolados) no se pierde
          return resolve({ text: '', truncated: true, cost: j.total_cost_usd ?? null, ms: Date.now() - started });
        if (j.is_error) return reject(new Error(`${j.result || 'Claude devolvió un error'}${j.subtype ? ` (${j.subtype})` : ''}`));
        const u = j.usage || {};
        resolve({ text: String(j.result || '').trim(), cost: j.total_cost_usd ?? null, ms: Date.now() - started, tokens: (u.input_tokens || 0) + (u.output_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0) });
      } catch {
        reject(new Error((err || out || 'Respuesta inválida de Claude').slice(0, 500)));
      }
    });
  }).then(remember);
}

/** Solo para «Probar agente»: fuerza motor/modelo en esta ejecución (sin cambio automático) para poder comparar. */
function overrideSettings(s, jid, ov) {
  if (!ov || !jid.startsWith('playground:')) return s;
  const engine = ov.engine === 'opencode' ? 'opencode' : ov.engine === 'claude' ? 'claude' : s.engine;
  const okModel = engine === 'opencode' ? /^[\w.-]+\/[\w.\[\]\/:@-]{1,100}$/.test(String(ov.model || '')) : /^[\w.\[\]-]{1,60}$/.test(String(ov.model || ''));
  return { ...s, engine, model: okModel ? String(ov.model) : engine === s.engine ? s.model : DEFAULT_MODEL[engine], variant: /^[\w-]{1,20}$/.test(String(ov.variant || '')) ? ov.variant : '', fallbackEnabled: false };
}

/** Si el agente decidió responder citando un mensaje (herramienta quote_message), devuelve la cita en el formato de Evolution. */
function takeQuote(key) {
  const jid = key; // clave del chat (historial); en WhatsApp se usa el jid real
  const wa = splitKey(key).jid;
  const f = path.join(outboxDir(jid), '.quote.json');
  if (!fs.existsSync(f)) return null;
  let ref; try { ref = JSON.parse(fs.readFileSync(f, 'utf8')).ref; } catch { ref = null; }
  fs.rmSync(f, { force: true });
  const m = db.prepare('SELECT id, role, content, wa_id, wa_participant FROM messages WHERE id = ? AND jid = ?').get(Number(ref), jid);
  if (!m) return null;
  const text = String(m.content).replace(/^[🎤🖼️🎬📎🏷️📍👤]\s*/u, '').slice(0, 300);
  const pack = (quote) => ({ quote, ref: m.id, text: String(m.content).replace(/\s+/g, ' ').slice(0, 600) });
  if (m.role === 'user' && m.wa_id) return pack({ key: { remoteJid: wa, fromMe: false, id: m.wa_id, ...(m.wa_participant ? { participant: m.wa_participant } : {}) }, message: { conversation: text } });
  if (m.role === 'assistant') { const s = db.prepare('SELECT wa_id FROM sent_msgs WHERE msg_id = ? ORDER BY idx LIMIT 1').get(m.id); if (s) return pack({ key: { remoteJid: wa, fromMe: true, id: s.wa_id }, message: { conversation: text } }); }
  return null;
}

/** Lee la cola que dejó send_file, valida y registra cada archivo con una URL temporal para que Evolution lo descargue. */
export function collectAttachments(jid, key = jid) {
  const outbox = outboxDir(key), queue = path.join(outbox, '.queue.jsonl');
  if (!fs.existsSync(queue)) return [];
  const lines = fs.readFileSync(queue, 'utf8').split('\n').filter(Boolean);
  fs.rmSync(queue, { force: true });
  const roots = [outbox, inboxDir(jid)].filter((r) => fs.existsSync(r)).map((r) => fs.realpathSync(r));
  const base = (process.env.HUB_PUBLIC_URL || `http://localhost:${process.env.PORT || 4961}`).replace(/\/$/, '');
  const out = [];
  for (const line of lines.slice(0, 5)) {
    try {
      const e = JSON.parse(line);
      const real = fs.realpathSync(e.path);
      if (!roots.some((r) => real.startsWith(r + path.sep)) || !fs.statSync(real).isFile()) continue;
      const d = describe(real, e.name);
      if (d.mediatype === 'video' && fs.statSync(real).size > 16 * 1048576) d.mediatype = 'document'; // WhatsApp solo previsualiza videos chicos; el resto va como archivo
      let fileName = String(e.name || path.basename(real));
      if (!path.extname(fileName) && d.ext && d.ext !== 'bin') fileName += `.${d.ext}`;
      const id = crypto.randomBytes(16).toString('hex');
      db.prepare('INSERT INTO outfiles (id, path, name, mime, expires) VALUES (?, ?, ?, ?, ?)').run(id, real, fileName, d.mime, Date.now() + 3600e3);
      const rel = `/f/${id}/${encodeURIComponent(fileName)}`;
      out.push({ src: real, url: base + rel, path: rel, fileName, mimetype: d.mime, mediatype: d.mediatype, caption: e.caption || '', size: fs.statSync(real).size });
    } catch { /* entrada inválida: se ignora */ }
  }
  return out;
}

// "escribiendo…" mientras se procesa (se renueva hasta que termina)
function startTyping(key) {
  if (key.startsWith('playground:') || !process.env.EVOLUTION_URL) return () => {};
  const { instance, jid } = splitKey(key);
  const tick = () => evo.withInstance(instance, () => evo.sendPresence(jid, 9000)).catch(() => {});
  tick();
  const t = setInterval(tick, 8000);
  return () => clearInterval(t);
}

/** Traduce un fallo interno a un mensaje que le diga a la persona qué pasó (sin detalles técnicos). */
function explainError(msg = '') {
  const lim = classifyLimit('claude', msg);
  if (lim?.kind === 'limit') return `Ahora mismo llegué a mi límite de uso y no puedo responder bien. Se me renueva hacia el ${untilText(lim.until, readSettings().timezone)}. Probá de nuevo más tarde.`;
  const m = msg.toLowerCase();
  if (/timeout|timed out/.test(m)) return 'Me tardé demasiado en procesar tu pedido y se cortó (puede ser algo pesado, como un video largo). ¿Probás con algo más corto o más simple?';
  if (/rate.?limit|usage limit|too many requests|overloaded|529|429/.test(m)) return 'Ahora mismo estoy con mucha demanda y alcancé mi límite de uso. Probá de nuevo en unos minutos.';
  if (/authenticat|invalid (api key|bearer|token)|401|oauth|not logged in|please run \/login/.test(m)) return 'Tengo un problema interno de acceso y no pude procesar tu mensaje. Ya quedó registrado para que lo revisen.';
  if (/fetch failed|enotfound|econn|network|socket/.test(m)) return 'Tuve un problema de conexión al procesar tu pedido. Probá de nuevo en un momento.';
  return 'No pude completar tu pedido por un error interno que ya quedó registrado. ¿Probás de nuevo o me lo pedís de otra forma?';
}

/** Red de seguridad: las referencias internas (#N) nunca deben llegar a la persona. */
export const stripRefs = (t) => String(t ?? '')
  .replace(/\s*\[mensaje #\d+\]\s*/gi, ' ')
  .replace(/\b(mensaje|msg)\s+#\d+\b/gi, '$1')
  .replace(/\b(?:el|ese|del|en el|al)\s+#\d{1,7}\b/gi, '')
  .replace(/(^|[\s(])#\d{2,7}\b/g, '$1')
  .replace(/,\s*,/g, ',').replace(/[ \t]+([,.;:])/g, '$1').replace(/ {2,}/g, ' ').trim();
/** Fecha y hora actuales en la zona del agente: sin esto no puede calcular "mañana a las 9". */
export function nowLine() {
  const tz = readSettings().timezone || 'America/Asuncion';
  const s = new Intl.DateTimeFormat('es', { timeZone: tz, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  return `[Ahora: ${s} (${tz})]`;
}
const kindLabel = { image: '🖼️ Imagen', audio: '🎤 Nota de voz', video: '🎬 Video', document: '📎 Documento', sticker: '🏷️ Sticker', location: '📍 Ubicación', contact: '👤 Contacto' };
/**
 * Modo "por contexto": solo si el agente habló en este grupo hace poco, un modelo chico (Haiku) decide si el mensaje nuevo
 * le sigue la corriente al agente (responde a lo que dijo, agrega datos al tema que venían tratando) o es charla entre otros.
 */
async function continuesConversation(jid, evt, windowMin) {
  const last = db.prepare("SELECT created_at FROM messages WHERE jid = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1").get(jid);
  if (!last || Date.now() - Date.parse(`${last.created_at.replace(' ', 'T')}Z`) > windowMin * 60000) return false;
  const rows = db.prepare("SELECT role, sender, content FROM messages WHERE jid = ? AND role IN ('user', 'assistant') ORDER BY id DESC LIMIT 10").all(jid).reverse();
  const line = (who, t) => `${who}: ${String(t).replace(/\s+/g, ' ').slice(0, 220)}`;
  const text = String(evt.text || '').trim() || (kindLabel[evt.kind] ? `[mandó ${kindLabel[evt.kind].replace(/^\S+\s/, '').toLowerCase()}]` : '');
  if (!text) return false;
  // con quién venía hablando el Agente: el autor del mensaje que contestó por última vez
  const lastAsk = db.prepare("SELECT sender FROM messages WHERE jid = ? AND role = 'user' AND id < (SELECT MAX(id) FROM messages WHERE jid = ? AND role = 'assistant') ORDER BY id DESC LIMIT 1").get(jid, jid);
  const withWho = lastAsk?.sender ? `\nLa última persona con la que habló el Agente es: ${lastAsk.sender}.` : '';
  const prompt = `Sos un filtro. En un grupo de WhatsApp participa un asistente ("Agente"). Decidí si el ÚLTIMO mensaje está dirigido al Agente: le habla directamente, responde a lo que él dijo, o le sigue pasando datos/pedidos del tema que venían tratando entre él y esa persona. Si la misma persona con la que venía hablando el Agente retoma el tema (aunque otros hayan hablado en el medio) o pide/agrega algo sobre lo que el Agente le estaba respondiendo, SÍ. Si es charla entre otras personas, o cambia de tema hacia otros, o no hay relación clara con lo que el Agente venía haciendo, NO.${withWho}\n\nConversación reciente:\n${rows.map((m) => line(m.role === 'assistant' ? 'Agente' : m.sender || 'Alguien', m.content)).join('\n')}\n\nÚLTIMO mensaje:\n${line(evt.name || 'Alguien', text)}\n\nRespondé SOLO con SI o NO.`;
  try {
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.env.CLAUDE_BIN || 'claude', ['-p', prompt, '--output-format', 'json', '--model', 'haiku', '--max-turns', '1', '--no-session-persistence', '--disable-slash-commands', '--allowedTools', '', '--mcp-config', '{"mcpServers":{}}', '--strict-mcp-config'], { cwd: os.tmpdir(), env: childEnv(), stdio: ['ignore', 'pipe', 'ignore'] });
      let buf = ''; const t = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('timeout')); }, 45000);
      child.stdout.on('data', (d) => (buf += d));
      child.on('close', () => { clearTimeout(t); resolve(buf); });
      child.on('error', (e) => { clearTimeout(t); reject(e); });
    });
    return /^\s*S[IÍ]\b/i.test(String(JSON.parse(out).result || ''));
  } catch (e) { console.error(`[contexto ${jid}] no se pudo decidir: ${e.message}`); return false; }
}

/** Mensaje de grupo al que no hay que responder: se guarda tal cual (sin descargar ni transcribir nada) para darle contexto después. */
async function recordListened(jid, evt, pre = null) {
  const label = pre?.transcript ? `🎤 Nota de voz: ${pre.transcript}` : kindLabel[evt.kind] ? `${kindLabel[evt.kind]}${evt.fileName ? ` ${evt.fileName}` : ''}${evt.text ? `\n${evt.text}` : ''}` : evt.text;
  if (!String(label || '').trim()) return;
  const quoted = evt.quoted ? String(evt.quoted).replace(/\s+/g, ' ').trim().slice(0, 600) : null;
  const stash = ['image', 'audio', 'video', 'document', 'sticker'].includes(evt.kind) ? (pre || await stashMedia(evt)) : null; // el archivo se baja ahora (los enlaces de WhatsApp vencen) pero se mira recién si después lo mencionan
  db.prepare('INSERT INTO messages (jid, role, content, quoted, sender, media, wa_id, wa_participant, wa_secret) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(jid, 'user', label, quoted, evt.name || null, stash ? JSON.stringify({ ...stash, caption: evt.text || '' }) : null, evt.key?.id || null, evt.participant || null, evt.secret || null);
  db.prepare("UPDATE contacts SET last_message_at = datetime('now') WHERE jid = ?").run(jid);
}
/** Nombre real del grupo (una sola vez). */
async function nameGroup(c) {
  if (c.group_named) return;
  const subject = await evo.groupSubject(splitKey(c.jid).jid);
  if (subject) db.prepare('UPDATE contacts SET name = ?, group_named = 1 WHERE jid = ?').run(subject, c.jid);
}

/**
 * La persona editó un mensaje suyo. Se descifra la edición, se actualiza el historial y, si el agente ya había respondido a ese mensaje,
 * decide si corresponde corregir su respuesta: devuelve `edit` (editar su mensaje anterior en WhatsApp) o una respuesta nueva citando.
 */
async function handleEdit(jid, evt) {
  const ed = evt.edit || {};
  const orig = db.prepare("SELECT * FROM messages WHERE jid = ? AND wa_id = ? AND role = 'user'").get(jid, ed.targetId);
  if (!orig) return { reply: null, paused: false, ignored: 'edición de un mensaje que no tengo registrado' };
  if (!orig.wa_secret) return { reply: null, paused: false, ignored: 'edición: ese mensaje es anterior a que guardara su clave, no se puede leer' };
  const waJid = splitKey(jid).jid;
  const base = [evt.participant, waJid.endsWith('@s.whatsapp.net') ? waJid : null, ed.alt].filter(Boolean);
  let dec;
  for (const fresh of [false, true]) {
    try { dec = decryptEdit({ secret: orig.wa_secret, encPayload: ed.encPayload, encIv: ed.encIv, targetId: ed.targetId, candidates: [...new Set([...base, ...(await knownLids(fresh))])] }); break; }
    catch (e) { if (fresh) { console.error(`[edición ${jid}] ${e.message}`); return { reply: null, paused: false, ignored: 'edición que no pude descifrar' }; } }
  }
  const oldText = orig.content;
  const newContent = /^[🎤🖼️🎬📎🏷️📍👤]/u.test(oldText) ? `${oldText.split('\n')[0]}${dec.text ? `\n${dec.text}` : ''}` : dec.text;
  if (newContent === oldText) return { reply: null, paused: false, ignored: 'edición sin cambios' };
  db.prepare('UPDATE messages SET content = ?, edited_from = COALESCE(edited_from, ?) WHERE id = ?').run(newContent, oldText, orig.id);
  db.prepare("UPDATE contacts SET last_message_at = datetime('now') WHERE jid = ?").run(jid);

  const sent = db.prepare('SELECT * FROM sent_msgs WHERE jid = ? AND reply_to = ? ORDER BY idx').all(jid, ed.targetId);
  const prev = sent.length ? db.prepare("SELECT * FROM messages WHERE id = ? AND role = 'assistant'").get(sent[0].msg_id) : null;
  const c = getContact(jid, null);
  if (!prev || c.paused) return { reply: null, paused: !!c.paused, ignored: 'edición registrada (no había respuesta que corregir)' };

  const stopTyping = startTyping(jid);
  try {
    const persona = resolveFor(c), settings = settingsFor(persona);
    const prompt = `[EDICIÓN — aviso del sistema, no lo menciones] La persona EDITÓ un mensaje que ya habías respondido.
Antes decía: ${JSON.stringify(String(oldText).replace(/^[^\n]*\n/, (m) => (/^[🎤🖼️🎬📎🏷️📍👤]/u.test(oldText) ? m : '')).slice(0, 1500))}
Ahora dice: ${JSON.stringify(dec.text.slice(0, 1500))}
Tu respuesta anterior fue: ${JSON.stringify(String(prev.content).slice(0, 1500))}
Si el cambio altera lo que corresponde contestar, escribí la respuesta CORREGIDA y COMPLETA: reemplazará tu mensaje anterior (no digas "veo que editaste" salvo que sea natural, y no repitas cosas innecesarias).
Si el cambio no altera nada importante (una errata, puntuación, formato), contestá únicamente [[SIN_CAMBIOS]].`;
    const r = await runClaude(c, recoverIfLost(jid) + prompt, settings, persona);
    const text = stripRefs(r.text);
    if (!text || /\[\[SIN_CAMBIOS\]\]/.test(text)) return { reply: null, paused: false, ignored: 'edición sin cambio relevante: el agente no corrige su respuesta' };
    const single = sent.length === 1 && text.length <= 3500 && !/📎/.test(prev.content);
    db.prepare('UPDATE messages SET content = ?, cost_usd = COALESCE(cost_usd, 0) + ?, edited_from = COALESCE(edited_from, ?) WHERE id = ?').run(text, r.cost || 0, prev.content, prev.id);
    if (single) return { reply: text, paused: false, attachments: [], msgId: prev.id, replyTo: ed.targetId, edit: { key: { remoteJid: waJid, fromMe: true, id: sent[0].wa_id }, text } };
    // la respuesta anterior eran varios mensajes (o con archivos): no se puede reemplazar limpio → se manda una nueva citando el mensaje editado
    const key = { remoteJid: waJid, fromMe: false, id: ed.targetId, ...(orig.wa_participant ? { participant: orig.wa_participant } : {}) };
    return { reply: text, paused: false, attachments: [], msgId: prev.id, replyTo: ed.targetId, quote: { key, message: { conversation: dec.text.slice(0, 300) } } };
  } catch (e) {
    console.error(`[edición ${jid}]`, e.message);
    return { reply: null, paused: false, error: e.message.slice(0, 200) };
  } finally { stopTyping(); }
}

/**
 * evt: { jid, name, kind?, text?, message? (alias de text), key?, mimetype?, fileName?, seconds?, quoted?, location?, contact? }
 * opts.friendly: ante un error devuelve un mensaje amable en vez de lanzar (para WhatsApp).
 */
export function chat(evt, opts = {}) {
  const jid = evt.jid;                               // clave del chat (incluye el número de WhatsApp si no es el principal)
  const { instance, jid: wa } = splitKey(jid);        // wa = jid real de WhatsApp
  if (!jid.startsWith('playground:') && !accountOf(instance)) return Promise.resolve({ reply: null, paused: false, ignored: `número de WhatsApp «${instance}» no registrado en el panel` });
  evt = { ...evt, kind: evt.kind || 'text', text: evt.text ?? evt.message ?? '' };
  if (evt.key?.id && !jid.startsWith('playground:') && db.prepare('INSERT OR IGNORE INTO seen (id) VALUES (?)').run(instance === evo.PRIMARY_INSTANCE() ? evt.key.id : `${instance}:${evt.key.id}`).changes === 0)
    return Promise.resolve({ reply: null, paused: false, ignored: 'mensaje duplicado' });

  return enqueue(jid, () => evo.withInstance(instance, async () => {
    if (!jid.startsWith('playground:') && evt.kind !== 'edit') { try { noteSeen(instance, wa, evt.name); } catch { /* la libreta nunca frena al chat */ } }
    // aprobación por WhatsApp («sí 12» / «no 12»): se resuelve sin pasar por el modelo
    if (!jid.startsWith('playground:') && !jid.endsWith('@g.us') && evt.kind === 'text') {
      const decided = await outreach.handleDecision(jid, evt);
      if (decided) return { reply: decided, paused: false, ignored: 'respuesta a una aprobación' };
      const decidedApp = await apps.handleDecision(jid, evt);
      if (decidedApp) return { reply: decidedApp, paused: false, ignored: 'respuesta a la aprobación de una app' };
    }
    const known = !!db.prepare('SELECT 1 FROM contacts WHERE jid = ?').get(jid);
    // charla que inició el agente: sigue atendiéndola aunque las reglas normales no la atenderían, avisa a quien la pidió y respeta un «no me escribas más»
    const thread = !jid.startsWith('playground:') && !jid.endsWith('@g.us') && evt.kind !== 'edit' ? outreach.activeThread(jid) : null;
    if (thread) { const oi = await outreach.onIncoming(jid, evt); if (oi?.reply) return { reply: oi.reply, paused: false, ignored: 'pidió que no le escriban' }; }
    const ignored = thread ? null : shouldIgnore(wa, known, instance);
    if (ignored) return { reply: null, paused: false, ignored };

    if (evt.kind === 'edit') return handleEdit(jid, evt);

    // Chats individuales: filtro por tipo de mensaje (opcional). Lo ignorado se guarda en el historial pero no se contesta.
    if (!thread && !jid.startsWith('playground:') && !jid.endsWith('@g.us') && !privateTypeAllowed(evt, known, wa, readRules(instance))) {
      await recordListened(jid, evt).catch(() => {});
      return { reply: null, paused: false, ignored: `no responde a este tipo de mensaje (${messageType(evt)})` };
    }

    // Horario de atención del número: fuera de horario puede responder un texto fijo, usar otra personalidad o callar
    const office = jid.startsWith('playground:') ? null : getOffice(instance);
    const closed = !!office?.enabled && (office.groups || !jid.endsWith('@g.us')) && !isOpen(office);
    if (closed && office.mode !== 'persona') {
      const c0 = getContact(jid, evt.name);
      await recordListened(jid, evt);
      if (office.mode === 'silent' || c0.paused) return { reply: null, paused: !!c0.paused, ignored: 'fuera de horario (silencio)' };
      const lastNote = db.prepare("SELECT created_at FROM messages WHERE jid = ? AND role = 'assistant' AND content = ? ORDER BY id DESC LIMIT 1").get(jid, office.message);
      if (lastNote && Date.now() - Date.parse(`${lastNote.created_at.replace(' ', 'T')}Z`) < office.cooldownHours * 3600e3) return { reply: null, paused: false, ignored: 'fuera de horario (ya se avisó hace poco)' };
      const msgId = db.prepare("INSERT INTO messages (jid, role, content) VALUES (?, 'assistant', ?)").run(jid, office.message).lastInsertRowid;
      return { reply: office.message, paused: false, attachments: [], msgId, replyTo: evt.key?.id || null, quote: null };
    }

    // Grupos: con "solo si me mencionan" el agente igual LEE y guarda todo; solo contesta cuando le hablan
    const isGroup = jid.endsWith('@g.us');
    let addressed = null;
    if (isGroup) {
      const rules = readRules(instance);
      // lista de miembros permitidos: los demás se leen (contexto) pero no se les contesta
      if (memberRestricted(wa, rules) && !memberAllowed(wa, await senderNumber({ ...evt, jid: wa }), rules)) {
        const cm = getContact(jid, null);
        await nameGroup(cm);
        await recordListened(jid, evt);
        return { reply: null, paused: false, ignored: 'quien escribe no está en la lista de miembros permitidos' };
      }
      const mode = groupModeFor(wa, rules);
      const filt = filterFor(wa, rules);
      const aevt = { ...evt, jid: wa };
      addressed = await isAddressed(aevt, rules);
      // un audio no puede llevar @: se transcribe para ver si dijeron su nombre o una palabra clave (y la transcripción queda como contexto)
      let pre = null;
      if (mode !== 'all' && !addressed && evt.kind === 'audio' && passesFilter(evt, filt) && (evt.seconds || 0) <= 180) {
        pre = await stashMedia(evt, { transcribe: true });
        if (pre?.transcript) { const hit = await isAddressed({ ...aevt, text: pre.transcript, mentionedJid: [], quotedParticipant: null }, rules); if (hit) addressed = `${hit} en un audio`; }
      }
      // modo contexto: si no lo nombraron, ¿esto continúa una charla que venía teniendo con el agente?
      if (mode === 'context' && !addressed && passesFilter(evt, filt) && await continuesConversation(jid, evt, rules.groupContextMinutes)) addressed = 'continúa la charla con el agente';
      // el filtro de tipos: aunque lo mencionen, solo responde si ese TIPO de mensaje está permitido (ej. no contestar stickers ni 👍)
      if (mode !== 'all' && addressed && !passesFilter(evt, filt)) addressed = null;
      if (mode !== 'all' && !addressed) {
        const c = getContact(jid, null);
        await nameGroup(c);
        await recordListened(jid, evt, pre);
        return { reply: null, paused: false, ignored: 'escucha el grupo (no lo mencionaron)' };
      }
    }

    if (evt.key?.id) evo.markRead({ ...evt.key, remoteJid: wa }).catch(() => {});
    const stopTyping = startTyping(jid);
    try {
      let built;
      try { built = await buildPrompt({ ...evt, jid }); }
      catch (e) {
        if (e instanceof UserFacingError) return { reply: e.message, paused: false };
        throw e;
      }
      if (!built) return { reply: null, paused: false, ignored: `tipo no soportado (${evt.kind})` };

      const recovered = recoverIfLost(jid);
      const c = getContact(jid, evt.name);
      maybeAutoProfile(jid); // en segundo plano: la primera vez que escribe (o si se venció) estudia su historial
      if (isGroup) await nameGroup(c);
      const persona = (closed && office.mode === 'persona' && office.personaId && getPersona(office.personaId)) || resolveFor(c);
      const personaHash = hashOf(persona);
      // ¿Cambió la personalidad de este contacto desde la última vez? Se le avisa al agente, NO a la persona.
      const changed = !!c.session_started && !!c.persona_hash && c.persona_hash !== personaHash;
      if (changed) db.prepare('INSERT INTO messages (jid, role, content) VALUES (?, ?, ?)').run(jid, 'system', `🔄 Personalidad aplicada: ${persona.name}`);
      // si el usuario respondió citando un mensaje, se guarda la cita (y a qué mensaje del chat corresponde) para mostrarla en el panel
      const quoted = evt.quoted ? String(evt.quoted).replace(/\s+/g, ' ').trim().slice(0, 600) : null;
      let quotedId = null;
      if (quoted && quoted.length > 8) {
        const probe = quoted.slice(0, 60);
        quotedId = db.prepare("SELECT id, content FROM messages WHERE jid = ? AND role != 'system' ORDER BY id DESC LIMIT 300").all(jid)
          .find((m) => String(m.content).replace(/\s+/g, ' ').includes(probe))?.id ?? null;
      }
      const curId = db.prepare('INSERT INTO messages (jid, role, content, quoted, quoted_id, sender, wa_id, wa_participant, wa_secret) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').run(jid, 'user', built.display, quoted, quotedId, isGroup ? evt.name || null : null, evt.key?.id || null, evt.participant || null, evt.secret || null).lastInsertRowid;
      db.prepare("UPDATE contacts SET last_message_at = datetime('now') WHERE jid = ?").run(jid);
      if (c.paused) return { reply: null, paused: true };

      const settings = overrideSettings(settingsFor(persona), jid, evt.override);
      // en grupos con mención: se le entrega lo que se habló desde su última intervención (que no leyó porque nadie lo mencionó)
      let groupCtx = '';
      if (isGroup) {
        const lastA = db.prepare("SELECT COALESCE(MAX(id), 0) AS id FROM messages WHERE jid = ? AND role = 'assistant'").get(jid).id;
        const rows = db.prepare("SELECT id, sender, content, media FROM messages WHERE jid = ? AND role = 'user' AND id > ? AND id < ? ORDER BY id DESC LIMIT ?").all(jid, lastA, curId, readRules(instance).groupHistory).reverse();
        // archivos del grupo que ahora sí interesan: los de este tramo + los de los últimos 30 min (por si hablan de "la imagen de recién")
        const recent = db.prepare("SELECT id, sender, content, media FROM messages WHERE jid = ? AND role = 'user' AND media IS NOT NULL AND id < ? AND created_at > datetime('now', '-30 minutes') ORDER BY id DESC LIMIT 6").all(jid, curId);
        const seenIds = new Set(); const files = [];
        for (const m of [...rows.filter((x) => x.media).reverse(), ...recent]) if (!seenIds.has(m.id)) { seenIds.add(m.id); files.push(m); }
        const described = files.length ? await describeStashed(jid, files.slice(0, 6).reverse().map((m) => { const md = JSON.parse(m.media); return { sender: m.sender, caption: md.caption, media: md }; })) : [];
        if (described.length) groupCtx += `[ARCHIVOS DEL GRUPO que se mandaron mientras no te hablaban (ahora sí podés verlos; si hace falta para responder, abrí con Read las rutas indicadas)]\n${described.join('\n')}\n[FIN DE LOS ARCHIVOS]\n\n`;
        if (rows.length) groupCtx += `[CONTEXTO DEL GRUPO — lo que se escribió desde tu última intervención, del más viejo al más nuevo. No les respondiste porque nadie te hablaba a vos; usalo para entender de qué se trata y respondé a lo que te piden ahora.]\n${rows.map((m) => `#${m.id} [${m.sender || 'alguien'}]: ${String(m.content).replace(/\s+/g, ' ').slice(0, 400)}`).join('\n')}\n[FIN DEL CONTEXTO]\n\n`;
        if (!addressed) groupCtx += '[Estás en un grupo configurado para que respondas a todos los mensajes. Respondé a lo que dice esta persona, breve y natural, como un integrante más.]\n\n';
        if (addressed) groupCtx += `[Esta persona te habló directamente en el grupo (${addressed}). Respondele a ella de forma breve, como un integrante más del grupo.]\n\n`;
      }
      // índice de los últimos mensajes con su referencia interna: así puede citar cualquiera (también los suyos) sin adivinar
      const idx = db.prepare("SELECT id, role, sender, content FROM messages WHERE jid = ? AND role IN ('user', 'assistant') AND id < ? ORDER BY id DESC LIMIT 8").all(jid, curId).reverse()
        .map((m) => `#${m.id} ${m.role === 'assistant' ? 'Vos' : m.sender || 'Persona'}: «${String(m.content).replace(/\s+/g, ' ').slice(0, 90)}»`);
      const recentIdx = idx.length ? `[Mensajes recientes con su referencia interna, por si querés citar alguno con quote_message (nunca escribas estos números en tu respuesta):\n${idx.join('\n')}]\n` : '';
      // empujón determinista: consultas sobre "qué/dónde/cuándo lo dije", "no veo el mensaje", "pasame ese mensaje"…
      const askAboutMsg = /(d[oó]nde|cu[aá]ndo|en qu[eé] mensaje|qu[eé] (n[uú]mero|cosa|palabra)?\s*(te )?(dije|escrib[ií]|mand[eé])|no (lo )?veo|pasame|mostrame|ese mensaje|el mensaje|ese que|el que (te )?(dije|mand[eé]|envi))/i.test(String(evt.text || ''));
      const nudge = askAboutMsg || evt.quoted ? '[La persona se refiere a un mensaje puntual (o te está citando uno): CITALO con quote_message antes de responder.]\n' : '';
      const prompt = recovered + outreach.contextNote(jid) + groupCtx + recentIdx + nudge + voice.nudge(persona, { kind: evt.kind, text: built.display }) + `${nowLine()}\n[mensaje #${curId}]\n` + (changed
        ? `[AVISO INTERNO DEL SISTEMA — no lo menciones, no lo repitas ni anuncies el cambio: a partir de este mensaje tu personalidad es «${persona.name}», con las instrucciones de tu system prompt. Aunque tus respuestas anteriores en esta conversación tengan otro tono o estilo, respondé desde ya con la nueva personalidad, sin avisar nada a la persona. Conservá el contexto y los datos de la conversación.]\n\n${built.prompt}`
        : built.prompt);
      let r;
      try {
        r = await runClaude(c, prompt, settings, persona);
      } catch (e) {
        if (!c.session_started && /already in use/i.test(e.message)) {
          // un intento previo falló tras registrar la sesión: retomarla
          r = await runClaude({ ...c, session_started: 1 }, prompt, settings, persona);
        } else if (c.session_started && /no conversation found|session/i.test(e.message)) {
          // la sesión no existe o quedó corrupta: arrancar una nueva
          resetSession(jid);
          r = await runClaude(getContact(jid), prompt, settings, persona);
        } else throw e;
      }
      r.text = stripRefs(r.text);
      db.prepare('UPDATE contacts SET session_started = 1, persona_hash = ? WHERE jid = ?').run(personaHash, jid);
      const attachments = (settings.sendFiles !== false || voice.enabledFor(persona)) ? collectAttachments(jid) : [];
      autoSaveDocs(jid, persona, attachments);
      if (r.truncated && !r.text) {
        console.error(`[chat ${jid}] se alcanzó el máximo de pasos (${settings.maxTurns}); se entrega lo que había (${attachments.length} archivo(s))`);
        r.text = attachments.length ? 'Acá tenés lo que pude conseguir 👆' : 'Me quedé a medias: tu pedido necesitaba más pasos de los que puedo hacer de una vez (llegué al límite de pasos). ¿Me lo pedís de a partes o con más detalle?';
      }
      if (voice.audioOnly(persona, attachments)) r.text = ''; // el audio va solo: no se repite ni se anuncia por escrito
      if (!isGroup && !evt.override) { // ¿esta respuesta necesita aprobación antes de salir?
        const held = await outreach.maybeHold(jid, { evt, text: r.text, attachments });
        if (held) return { reply: null, paused: false, ignored: `respuesta pendiente de aprobación (#${held.id})` };
      }
      const shown = [r.text, ...attachments.map((a) => `📎 ${a.fileName}`)].filter(Boolean).join('\n');
      const qt = takeQuote(jid); // si citó un mensaje, se guarda para mostrarlo también en el panel
      const msgId = db.prepare('INSERT INTO messages (jid, role, content, cost_usd, duration_ms, quoted, quoted_id) VALUES (?, ?, ?, ?, ?, ?, ?)').run(jid, 'assistant', shown, r.cost, r.ms, qt?.text || null, qt?.ref || null).lastInsertRowid;
      return { reply: r.text, paused: false, attachments, msgId, replyTo: evt.key?.id || null, quote: qt?.quote || null };
    } catch (e) {
      console.error(`[chat ${jid}]`, e.message);
      if (opts.friendly) return { reply: explainError(e.message), paused: false, error: e.message.slice(0, 200) };
      throw e;
    } finally {
      stopTyping();
    }
  }));
}

// enlaces del módulo «conversaciones que inicia el agente» (se registran acá para evitar importaciones circulares)
outreach.bind({
  askModel,
  getContact,
  contextFor: (key, name) => ({ persona: resolveFor({ jid: key, ...(db.prepare('SELECT persona_id FROM contacts WHERE jid = ?').get(key) || {}) }), memory: memoryBlock(key, name, { auto: false, tools: false }) }),
});
