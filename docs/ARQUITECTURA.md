# Arquitectura

## Piezas
| Pieza | Contenedor | Rol |
|---|---|---|
| **Evolution API v2** | `evolution` (+ `postgres`, `redis`) | Conecta el número de WhatsApp (Baileys). Una instancia por número. |
| **n8n** | `n8n` | Orquesta: recibe el webhook de Evolution, clasifica el mensaje, llama al agente y devuelve la respuesta. El flujo está en `n8n/kiri-whatsapp.workflow.json`. |
| **KiriDev hub** | `hub` | Panel web + API + runner del Claude Code (u OpenCode) aislado. |

## Aislamiento del agente
- El hub ejecuta `claude -p` con `HOME=/data/home` y `cwd=/data/agent`: configuración, credenciales, memoria y sesiones propias.
- La personalidad vive en la base del hub (y se materializa como `CLAUDE.md`); las habilidades en `.claude/skills/*/SKILL.md`; los límites en los ajustes por personalidad.
- `--setting-sources project,local` evita cargar configuración de usuario; `--allowedTools` limita lo que puede hacer.
- Una sesión de Claude por contacto, serializada por contacto. Corre como usuario `node` (no root).
- El agente principal es **coordinador**: conversa, lee los archivos recibidos y delega todo trabajo en **sub agentes**.
- El proceso de IA no hereda los secretos del hub; las herramientas propias (archivos, memoria, voz, paneles…) se exponen por un servidor MCP interno (`server/src/agent-mcp.js`) que habla con el hub con un token efímero.

## Flujo de un mensaje
1. Alguien escribe → Evolution emite `MESSAGES_UPSERT` al webhook de n8n.
2. n8n clasifica el mensaje y hace `POST /api/agent/chat` (Bearer `AGENT_TOKEN`).
3. El hub aplica reglas (chats, grupos, listas, filtros, horario), guarda el mensaje, ejecuta el motor y guarda la respuesta → `{reply, attachments, quote, edit, delaySec}`.
4. n8n parte la respuesta en mensajes y los envía a Evolution (`sendText`, `sendMedia`, `sendWhatsAppAudio`, `updateMessage`); luego registra los ids enviados en el hub (`POST /api/agent/sent`) para poder citar o editar después.

## Módulos del servidor (`server/src`)
`agent.js` (runner de Claude) · `opencode.js` + `engines.js` (segundo motor, cambio automático, consumo) · `tasks.js` (sub agentes) · `schedules.js` (tareas programadas) · `memory.js`, `learn.js`, `profile.js` (memoria, skills que se aprenden, perfil de comunicación) · `rules.js`, `office.js`, `attention.js`, `outreach.js` (reglas de respuesta, horario, pase a humano, conversaciones iniciadas) · `panels.js`, `documents.js` (paneles de datos) · `mcp.js`, `mcp-oauth.js` (MCPs) · `voice.js` (notas de voz) · `apps.js` (Docker aislado y apps con URL) · `assistant.js` (asistente integrado) · `accounts.js`, `evolution.js` (números de WhatsApp).

## Panel
Login con usuario/contraseña (bcrypt + JWT en cookie `httpOnly`, límite de intentos). Roles: `admin` (todo) y `viewer` (solo lectura). Secciones: Inicio, Conversaciones, Tareas, Paneles, Apps, Voz, WhatsApp, Personalidades, Memoria, MCPs, Cuentas y motores, Reglas de respuesta, Probar agente, Usuarios, y el Asistente integrado.
