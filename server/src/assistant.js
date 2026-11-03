// Asistente del Hub: responde con el MISMO motor que el administrador configuró (el de la personalidad predeterminada, con su respaldo).
// No tiene herramientas ni sesión: recibe la charla + lo que se ve en pantalla + los ajustes actuales y contesta con texto y,
// opcionalmente, un bloque de acciones (abrir una página, resaltar opciones, proponer un cambio). El navegador ejecuta lo visual;
// los cambios de configuración pasan SIEMPRE por `applyChange`, que solo toca las áreas de la lista y valida con la misma limpieza que el panel.
import { askClaude } from './agent.js';
import { askOpencode } from './opencode.js';
import { defaultPersona, settingsFor } from './personas.js';
import { planFor, pickRun, classifyLimit, markPaused, clearPause, isPaused, ENGINE_LABEL } from './engines.js';
import { readGeneralRules, writeRules } from './rules.js';
import * as outreach from './outreach.js';
import { readAttentionSettings, writeAttentionSettings } from './attention.js';
import { readPanelSettings, writePanelSettings } from './panel-settings.js';
import { readEngineSettings, writeEngineSettings } from './engines.js';
import * as appsMod from './apps.js';

const fail = (status, message) => Object.assign(new Error(message), { status });

export const PAGES = {
  '/': ['Inicio', 'Resumen: estado de WhatsApp, consumo del agente y avisos que necesitan atención.'],
  '/conversaciones': ['Conversaciones', 'Bandeja con todos los chats: leer, responder a mano, pausar al agente o reiniciar su memoria en un chat.'],
  '/tareas': ['Tareas', 'Trabajos largos que el agente delegó a un sub agente y recordatorios programados.'],
  '/paneles': ['Paneles', 'Tablas, calendarios y tableros que el agente arma y mantiene para cada persona.'],
  '/voz': ['Voz', 'Notas de voz del agente con ElevenLabs: cuándo las manda, cómo tiene que hablar, la voz y los topes de gasto.'],
  '/apps': ['Apps', 'Docker aislado del agente: las apps que levanta para probar código o armar cosas, sus URLs públicas y las solicitudes de publicación que esperan aprobación.'],
  '/whatsapp': ['WhatsApp', 'Conectar y gestionar los números de WhatsApp (cuentas), ver su estado y asignarles personalidad.'],
  '/personalidad': ['Personalidades', 'Quién es el agente: tono, reglas y comportamiento. Cada personalidad puede tener su propio motor, modelo y herramientas.'],
  '/memoria': ['Memoria', 'Lo que el agente recuerda de cada chat (perfil de comunicación, notas). Se puede editar o agregar a mano.'],
  '/mcps': ['MCPs', 'Herramientas externas que el agente puede usar (calendario, correo, etc.) y a qué personalidades se las damos.'],
  '/motores': ['Cuentas y motores', 'Con qué «cerebro» trabaja el agente: sesión de Claude Code, proveedores de OpenCode y la clave de Groq para transcribir audios.'],
  '/reglas': ['Reglas de respuesta', 'A quién y cuándo responde el agente: chats individuales, contactos nuevos, grupos, listas permitida y bloqueada, demora, y las conversaciones que inicia el agente.'],
  '/probar': ['Probar agente', 'Chatear con el agente como si fueras un contacto, sin tocar WhatsApp, y comparar motores o modelos.'],
  '/usuarios': ['Usuarios', 'Personas que pueden entrar a este panel y su rol (administrador o solo lectura).'],
};

const GUIDE = `PRIMEROS PASOS recomendados (en este orden):
1. Cuentas y motores → conectar el «cerebro»: iniciar sesión con Claude Code, o conectar un proveedor de OpenCode (hay modelos gratuitos). Sin esto el agente no puede contestar.
2. WhatsApp → conectar un número escaneando el QR.
3. Personalidades → revisar o escribir cómo habla y se comporta el agente.
4. Reglas de respuesta → decidir a quién contesta (chats individuales, contactos nuevos, grupos). Conviene empezar con «solo lista permitida» y tu número en la lista.
5. Probar agente → conversar un rato para ajustar el tono antes de abrirlo al público.
6. Opcionales: Memoria, MCPs, Paneles, avisos para pasar a un humano, y que el agente inicie conversaciones.`;

// Áreas de configuración que el asistente puede cambiar (siempre con las mismas validaciones que el panel). `keys` documenta cada ajuste.
export const AREAS = {
  rules: {
    label: 'Reglas de respuesta (generales)', page: '/reglas',
    read: () => readGeneralRules(), write: (v) => writeRules(v),
    keys: {
      privateChats: 'responde en chats individuales (true/false)', newContacts: 'responde a personas que escriben por primera vez', mode: '«everyone» (a todos) o «allowlist» (solo números de la lista permitida)',
      allowlist: 'números permitidos (solo dígitos con código de país, ej. 595981123456)', blocklist: 'números bloqueados (nunca responde)',
      groups: 'responde en grupos', groupMode: '«all» todo, «mention» solo si lo mencionan, «context» mención o charla en curso', groupContextMinutes: 'minutos que sigue atento tras intervenir (modo context)',
      groupReplyToBot: 'contesta si citan un mensaje suyo', groupUseName: 'contesta si dicen su nombre', groupKeywords: 'palabras que lo invocan en grupos', groupHistory: 'mensajes del grupo que ve al ser mencionado',
      groupMemberMode: '«everyone» o «allowlist» (en grupos solo responde a miembros de groupMembers)', groupMembers: 'números de miembros permitidos en grupos',
      privateFilterOn: 'filtrar por tipo de mensaje en chats individuales', privateFilter: 'tipos permitidos: text, audio, image, video, document, sticker, emojiReply',
      newFilterOn: 'filtro de tipos propio para contactos nuevos', newFilter: 'tipos permitidos para contactos nuevos',
      replyDelay: 'demora antes de responder: {enabled, min, max, unit:«s»|«min»}',
    },
  },
  outreach: {
    label: 'Conversaciones que inicia el agente', page: '/reglas',
    read: () => { const { overview, ...s } = outreach.readSettings(); return s; }, write: (v) => outreach.writeSettings(v),
    keys: {
      enabled: 'función encendida', orderers: 'números que pueden pedirle que escriba a otros', allowKnown: 'puede escribir a contactos conocidos', allowNew: 'puede escribir a números nuevos (verifica que tengan WhatsApp)',
      approvers: 'números que aprueban cada mensaje (vacío = aprueba quien lo pidió)', maxPerDayTotal: 'tope total de mensajes iniciados por día', approvalTtlMin: 'minutos hasta que vence una aprobación',
      defaults: '{approval:«ask»|«notify»|«direct», approvalReplies:bool, maxPerDay, hours:{enabled,from,to}, windowHours, report:«each»|«off»}',
    },
  },
  attention: {
    label: 'Pasar a un humano (avisos al dueño)', page: '/reglas',
    read: () => readAttentionSettings(), write: (v) => writeAttentionSettings(v),
    keys: { enabled: 'el agente puede pedir ayuda humana', pause: 'se pausa en ese chat al pedir ayuda', owners: 'números a los que se avisa por WhatsApp', notifyFailedTasks: 'avisar si falla una tarea', notifyCooldownMin: 'minutos entre avisos del mismo chat' },
  },
  panels: {
    label: 'Paneles del agente', page: '/paneles',
    read: () => readPanelSettings(), write: (v) => writePanelSettings(v),
    keys: { enabled: 'el agente puede armar paneles', suggest: 'sugiere crear paneles por su cuenta', personalLinks: 'puede dar enlaces personales a cada persona', autoSaveDocs: 'guarda los archivos que envía en Documentos' },
  },
  apps: {
    label: 'Apps del agente (Docker aislado)', page: '/apps',
    read: () => appsMod.readSettings(), write: (v) => appsMod.writeSettings(v),
    keys: {
      enabled: 'el agente puede usar su Docker y publicar apps', approval: '«ask» = cada publicación se aprueba por WhatsApp · «direct» = se publica sin preguntar', approvers: 'números que aprueban (vacío = aprueba quien lo pidió)',
      approvalTtlMin: 'minutos hasta que vence una aprobación', maxApps: 'tope de apps publicadas a la vez', maxPerOwner: 'tope de apps por chat', defaultAccess: '«public» o «login» (pide usuario y contraseña del panel)',
    },
  },
  engines: {
    label: 'Motores', page: '/motores',
    read: () => readEngineSettings(), write: (v) => writeEngineSettings(v),
    keys: { notifySwitch: 'avisar por WhatsApp al dueño cuando se cambia de motor por un límite de uso' },
  },
};


// nombre legible de cada ajuste (lo que ve la persona en la tarjeta de cambio)
const NAMES = {
  privateChats: 'Chats individuales', newContacts: 'Contactos nuevos', mode: 'Quién puede escribir', allowlist: 'Lista permitida', blocklist: 'Lista bloqueada',
  groups: 'Responder en grupos', groupMode: 'Cuándo responde en grupos', groupContextMinutes: 'Minutos de atención en grupos', groupReplyToBot: 'Si citan un mensaje suyo', groupUseName: 'Si dicen su nombre', groupKeywords: 'Palabras que lo invocan', groupHistory: 'Mensajes de grupo que ve',
  groupMemberMode: 'Quién lo activa en grupos', groupMembers: 'Miembros permitidos en grupos', privateFilterOn: 'Filtrar por tipo (individuales)', privateFilter: 'Tipos permitidos (individuales)', newFilterOn: 'Filtro propio para nuevos', newFilter: 'Tipos permitidos (nuevos)', replyDelay: 'Demora de respuesta',
  enabled: 'Activado', orderers: 'Quién puede pedírselo', allowKnown: 'Contactos conocidos', allowNew: 'Números nuevos', approvers: 'Quién aprueba', maxPerDayTotal: 'Tope diario total', approvalTtlMin: 'Minutos para aprobar', defaults: 'Valores por defecto',
  pause: 'Pausar el chat al pedir ayuda', owners: 'Números a avisar', notifyFailedTasks: 'Avisar tareas fallidas', notifyCooldownMin: 'Minutos entre avisos',
  approval: 'Cómo se aprueba', maxApps: 'Tope de apps', maxPerOwner: 'Tope por chat', defaultAccess: 'Acceso por defecto',
  suggest: 'Sugerir paneles', personalLinks: 'Enlaces personales', autoSaveDocs: 'Guardar archivos enviados', notifySwitch: 'Avisar al cambiar de motor',
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
/** Aplica un cambio parcial a un área: solo claves conocidas, mezcladas con lo actual y limpiadas por el mismo código que usa el panel. Devuelve qué cambió (antes/después) para poder deshacer. */
export function applyChange(area, changes) {
  const A = AREAS[area];
  if (!A) throw fail(400, `Esa área no se puede cambiar desde el asistente (${String(area).slice(0, 40)}).`);
  if (!changes || typeof changes !== 'object' || Array.isArray(changes) || !Object.keys(changes).length) throw fail(400, 'No hay nada para cambiar.');
  const current = A.read();
  const unknown = Object.keys(changes).filter((k) => !(k in A.keys));
  if (unknown.length) throw fail(400, `No puedo cambiar «${unknown.join('», «')}» desde acá. Hacelo desde ${A.page}.`);
  const written = A.write({ ...current, ...changes });
  const after = A.read();
  const diff = {};
  for (const k of Object.keys(changes)) if (!same(current[k], after[k])) diff[k] = { before: current[k], after: after[k] };
  if (!Object.keys(diff).length) throw fail(400, 'Eso ya estaba así (o el valor no es válido): no cambió nada.');
  return { area, label: A.label, diff, undo: Object.fromEntries(Object.entries(diff).map(([k, v]) => [k, v.before])), written: !!written };
}

const clip = (v, n) => { const s = typeof v === 'string' ? v : JSON.stringify(v); return s.length > n ? `${s.slice(0, n)}…` : s; };
function snapshot() {
  const out = [];
  for (const [id, A] of Object.entries(AREAS)) {
    try {
      const keys = Object.fromEntries(Object.keys(A.keys).map((k) => [k, undefined]));
      const cur = A.read();
      out.push(`### ${id} — ${A.label} (se ve en ${A.page})\nAjustes que podés proponer cambiar:\n${Object.entries(A.keys).map(([k, d]) => `- ${k}: ${d}`).join('\n')}\nValores actuales: ${clip(Object.fromEntries(Object.keys(keys).map((k) => [k, cur[k]])), 2500)}`);
    } catch { /* un área que falla no frena al asistente */ }
  }
  return out.join('\n\n');
}

const ACTIONS_DOC = `ACCIONES (opcionales). Si querés que el panel haga algo, terminá tu respuesta con UN bloque así (JSON válido, una lista):
\`\`\`kiri
[ {"type":"navigate","to":"/reglas"},
  {"type":"highlight","items":["Texto exacto de una opción visible","Otro texto exacto"]},
  {"type":"apply","area":"rules","summary":"Qué cambia, en una frase","changes":{"mode":"allowlist"}} ]
\`\`\`
- navigate: abre esa página del menú (solo las de la lista de páginas). Usalo cuando lo que la persona necesita está en otra página, o si te lo pide.
- highlight: resalta y NUMERA en pantalla las opciones que nombres (en el orden dado). En "items" copiá el texto EXACTO tal como figura en «EN PANTALLA». Si te piden explicar varias cosas, resaltalas y en el texto explicalas con la misma numeración (1., 2., …). Si mandás navigate, NO resaltes en el mismo bloque: no ves esa página todavía; el panel la abre y te vuelve a consultar enseguida con lo que se ve ahí, y entonces sí resaltás y explicás. Con navigate escribí solo una frase corta (ej. «Te llevo a Reglas de respuesta»).
- apply: PROPONE un cambio de configuración; la persona lo aprueba con un botón (o se aplica solo si ella eligió eso). "area" y las claves de "changes" deben ser EXACTAS de la lista de ajustes; el valor reemplaza al actual (en listas, mandá la lista completa final). Un solo cambio claro por acción; podés mandar varias acciones apply. Nunca inventes claves.
Si la persona solo pregunta o no hace falta nada, no mandes bloque. El bloque va al FINAL, después de tu texto, y no lo menciones.`;

function systemPrompt({ user, admin }) {
  return `Sos el asistente del panel «Kiri Hub», que administra a Kiri: un agente de IA que atiende WhatsApp. Ayudás a quien administra el panel a entender las opciones, configurarlas y empezar a usarlo. Hablás en español rioplatense claro y amable, directo y breve (3 a 8 líneas salvo que pidan detalle), sin jerga técnica innecesaria. Usá **negrita** para nombres de opciones y listas con guiones o números cuando enumeres. No inventes opciones que no figuren abajo: si no sabés algo, decilo y sugerí dónde mirar.
La persona que te habla se llama ${user} y ${admin ? 'es ADMINISTRADORA: puede aprobar cambios' : 'tiene rol de SOLO LECTURA: no puede cambiar nada; explicale y guiala, pero no propongas acciones apply'}.
Nunca pidas ni muestres claves, contraseñas o tokens. Los cambios que proponés jamás se aplican sin que la persona lo apruebe, salvo que ella haya activado «aplicar sin preguntar»; igual, proponé solo lo que te pidió o lo que claramente le sirve, y explicale qué cambia. Para cosas que no están en tus áreas de ajustes (conectar WhatsApp, iniciar sesión, escribir la personalidad, claves…) llevala a la página correcta con navigate y resaltá dónde tocar.

PÁGINAS DEL PANEL (ruta — nombre: para qué sirve):
${Object.entries(PAGES).map(([p, [n, d]]) => `- ${p} — ${n}: ${d}`).join('\n')}

${GUIDE}

${ACTIONS_DOC}`;
}

const strip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
/** Prompt completo: instrucciones + ajustes actuales + pantalla + charla reciente. */
export function buildPrompt({ messages, screen, refs, user, admin }) {
  const hist = (Array.isArray(messages) ? messages : []).slice(-14).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && m.text);
  const labels = (screen?.labels || []).slice(0, 140).map((l) => `- [${strip(l.kind, 14)}] ${strip(l.text, 110)}${l.section ? `  (en: ${strip(l.section, 60)})` : ''}`).join('\n');
  const page = PAGES[screen?.path] ? `${screen.path} — ${PAGES[screen.path][0]}` : strip(screen?.path, 60) || 'desconocida';
  const sel = (Array.isArray(refs) ? refs : []).slice(0, 6).map((r, i) => `${i + 1}. «${strip(r.label, 110)}»${r.section ? ` (sección «${strip(r.section, 60)}», página ${strip(r.page, 40)})` : ''}${r.detail ? ` — tocó específicamente «${strip(r.detail, 60)}»` : ''}${r.value ? ` — valor actual: ${strip(r.value, 80)}` : ''}${r.desc ? ` — texto de ayuda en pantalla: «${strip(r.desc, 220)}»` : ''}`).join('\n');
  return [
    systemPrompt({ user, admin }),
    `AJUSTES ACTUALES (para explicar y para proponer cambios):\n${snapshot()}`,
    `PANTALLA ACTUAL: ${page}\nEN PANTALLA (lo que la persona ve ahora, para resaltar con el texto exacto):\n${labels || '(nada legible)'}`,
    sel ? `LA PERSONA SEÑALÓ ESTAS OPCIONES con el puntero y su pregunta se refiere a ellas:\n${sel}` : '',
    `CHARLA (más vieja primero):\n${hist.map((m) => `${m.role === 'user' ? 'Persona' : 'Asistente'}: ${strip(m.text, 1500)}`).join('\n')}\n\nRespondé ahora el último mensaje de la persona.`,
  ].filter(Boolean).join('\n\n=====\n\n');
}

/** Separa el texto visible del bloque ```kiri y valida cada acción (las inválidas se descartan). */
export function parseReply(raw) {
  const m = /```kiri\s*([\s\S]*?)```/.exec(String(raw || ''));
  const text = String(raw || '').replace(/```kiri[\s\S]*?(```|$)/g, '').trim();
  const actions = [];
  if (m) {
    let list; try { list = JSON.parse(m[1]); } catch { list = []; }
    for (const a of Array.isArray(list) ? list.slice(0, 8) : []) {
      if (a?.type === 'navigate' && PAGES[a.to]) actions.push({ type: 'navigate', to: a.to });
      else if (a?.type === 'highlight' && Array.isArray(a.items)) { const items = a.items.map((x) => strip(x, 110)).filter(Boolean).slice(0, 12); if (items.length) actions.push({ type: 'highlight', items }); }
      else if (a?.type === 'apply' && AREAS[a.area] && a.changes && typeof a.changes === 'object' && !Array.isArray(a.changes)) {
        const bad = Object.keys(a.changes).filter((k) => !(k in AREAS[a.area].keys));
        if (!bad.length && Object.keys(a.changes).length) actions.push({ type: 'apply', area: a.area, label: AREAS[a.area].label, summary: strip(a.summary, 200), changes: a.changes, names: Object.fromEntries(Object.keys(a.changes).map((k) => [k, NAMES[k] || k])), current: Object.fromEntries(Object.keys(a.changes).map((k) => [k, AREAS[a.area].read()[k]])) });
      }
    }
  }
  return { text, actions };
}

async function run(sel, prompt) {
  const timeoutMs = 150000;
  return sel.engine === 'opencode' ? askOpencode(prompt, { timeoutMs, ocModel: sel.model }) : askClaude(prompt, { model: sel.model, timeoutMs });
}
/** Contesta con el motor de la personalidad predeterminada; si llegó a su límite de uso y hay respaldo, sigue con el otro motor. */
export async function ask(body, { user, admin }) {
  const prompt = buildPrompt({ ...body, user, admin });
  const plan = planFor(settingsFor(defaultPersona())), first = pickRun(plan);
  let raw, used = first;
  try { raw = await run(first, prompt); clearPause(first.engine); }
  catch (e) {
    const lim = classifyLimit(first.engine, e.message);
    if (lim) markPaused(first.engine, lim);
    if (lim && plan.fallback && first.engine !== plan.fallback.engine && !isPaused(plan.fallback.engine)) { used = plan.fallback; raw = await run(plan.fallback, prompt); }
    else if (lim) throw fail(503, `${ENGINE_LABEL[first.engine]} llegó a su límite de uso y no hay un motor de respaldo activo. Probá más tarde o activá el respaldo en Personalidades.`);
    else throw fail(502, `El motor no pudo responder (${strip(e.message, 160)}). Revisá Cuentas y motores.`);
  }
  const out = parseReply(raw);
  if (!out.text && !out.actions.length) throw fail(502, 'El motor no devolvió respuesta. Probá de nuevo.');
  return { ...out, engine: used.engine };
}
