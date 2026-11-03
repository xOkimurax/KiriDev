<h1 align="center">KiriDev</h1>
<p align="center"><b>Un agente de IA que atiende WhatsApp como una persona, con un panel web para moldearlo sin tocar código.</b></p>

KiriDev es un **Claude Code aislado** (con su propia personalidad, memoria, skills y herramientas) conectado a un número de WhatsApp mediante **Evolution API** y **n8n**. Un panel web (usuario y contraseña) sirve para conectar el número escaneando un QR, escribir la personalidad, decidir a quién y cuándo responde, revisar las conversaciones y supervisar el trabajo que el agente hace en segundo plano.

```
WhatsApp ⇄ Evolution API ──webhook──▶ n8n ──HTTP──▶ KiriDev hub ──▶ Claude Code / OpenCode
                 ▲                      │              │  panel web + API + SQLite
                 └──────sendText────────┘              └─ /data: personalidades, skills, memoria, sesiones
```

![Panel de KiriDev](docs/screenshots/01-inicio.png)

## Instalación en un comando

Requisitos: **Docker** con Compose v2 y ~3 GB libres. Nada más.

```bash
git clone https://github.com/xOkimurax/KiriDev.git
cd KiriDev
./install.sh
```

El instalador crea un `.env` con contraseñas y secretos aleatorios (te muestra la clave del panel), construye las imágenes y levanta todo: el panel, Evolution API (+ PostgreSQL y Redis) y n8n con el flujo de WhatsApp **ya importado y publicado**. Cuando termina abrí **http://localhost:4961** y seguí estos pasos:

1. Entrá con `admin` y la contraseña que mostró el instalador (queda en `.env`).
2. **Cuentas y motores** → conectá el «cerebro» del agente (ver [Motor de IA](#motor-de-ia)).
3. **WhatsApp** → *Generar QR* y escanealo con el número que va a atender el agente (WhatsApp → Dispositivos vinculados).
4. **Probar agente** → conversá sin usar WhatsApp para comprobar que responde.
5. **Personalidades** y **Reglas de respuesta** → ajustá el tono y a quién contesta. Conviene empezar con «solo lista permitida» y tu propio número.

> Para volver a levantarlo: `docker compose up -d`. Para actualizar: `git pull && docker compose up -d --build`. Para apagarlo: `docker compose down` (los datos quedan en volúmenes; `down -v` los borra).

## Qué hace el agente

| | |
|---|---|
| 💬 **Conversa** | Chats individuales y grupos (por mención, nombre, palabra clave o contexto), varias personalidades por contacto o por número, respuestas citando mensajes, «escribiendo…», demora «humana», horario de atención y pase a un humano. Varios números de WhatsApp a la vez. |
| 🎧 **Entiende** | Notas de voz (transcripción con Whisper/Groq), imágenes, stickers, PDF, Word, Excel, PowerPoint, ZIP, texto/código (detecta el tipo por contenido), videos (fotogramas + audio), ubicaciones, contactos y mensajes citados. |
| 📄 **Crea archivos** | PDF, Word, Excel, ZIP, CSV, JSON, HTML y código, y los envía por WhatsApp. Catálogos, propuestas, informes y planillas. |
| 🎬 **Edita medios** | Con FFmpeg y las herramientas que instale en su contenedor: cortar/unir/convertir/comprimir video, extraer audio, GIFs y miniaturas, redimensionar y retocar imágenes, capturas de páginas con Chromium. |
| 🔎 **Investiga** | Busca y lee la web, compara precios y fuentes, resume y arma informes. Descarga archivos y medios (yt-dlp: TikTok, Instagram, X, Vimeo, SoundCloud…). |
| 🧩 **Delega** | Los trabajos largos van a sub agentes en segundo plano que avisan al terminar y envían los archivos. |
| ⏰ **Programa** | Recordatorios a una hora exacta o rutinas con cron («cada día hábil a las 9»), y conversaciones iniciadas por el agente (opcional, con aprobación). |
| 🧠 **Recuerda y aprende** | Memoria global y por contacto, perfil de comunicación por chat y *skills* que se crean o mejoran solas tras resolver tareas. |
| 🗂️ **Paneles de datos** | Tablas, calendarios, tableros, notas y documentos para cada persona, con enlace personal sin contraseña. |
| 🔌 **MCP** | Se conecta a cualquier servidor MCP (correo, calendario, bases de datos…) agregándolo desde el panel; login OAuth sin navegador en el servidor. |
| 🔊 **Voz** | Notas de voz con ElevenLabs y respaldo gratuito de voces de Edge. |
| 🐳 **Docker propio** | (Opcional) crea contenedores y publica apps con URL, con tu aprobación. |
| 🔁 **Motores** | Claude Code u OpenCode (200+ proveedores, con modelos gratuitos); cambio automático al llegar a un límite. |

## Qué necesita cada pieza (y qué tenés que darle)

KiriDev no incluye credenciales: cada servicio se conecta con las tuyas. Esta tabla resume **todo lo que hay que configurar**:

| Pieza | ¿Obligatoria? | Qué necesita | Dónde se configura |
|---|---|---|---|
| **Docker + Compose v2** | Sí | Instalado en la máquina | — |
| **Secretos internos** (clave del panel, JWT, token n8n→hub, clave de Evolution, contraseña de Postgres) | Sí | Los genera `install.sh` solos | `.env` |
| **Motor de IA** | Sí (uno) | Una cuenta de Claude (suscripción o API key) **o** un proveedor de OpenCode (hay modelos gratis) | Panel → *Cuentas y motores* o `.env` |
| **Número de WhatsApp** | Sí | Un número con WhatsApp para vincular por QR (conviene uno dedicado) | Panel → *WhatsApp* |
| **Groq** (transcribir audios) | No | API key gratuita de [groq.com](https://console.groq.com) | Panel → *Cuentas y motores* o `GROQ_API_KEY` |
| **ElevenLabs** (notas de voz premium) | No | API key de [elevenlabs.io](https://elevenlabs.io). Sin ella usa voces gratis de Edge | Panel → *Voz* o `ELEVENLABS_API_KEY` |
| **MCPs de terceros** | No | Lo que pida cada uno (URL, token, login OAuth) | Panel → *MCPs* |
| **Dominio público + HTTPS** | No | Un dominio apuntando al panel (reverse proxy o túnel) para enlaces de paneles personales y login de MCP | `HUB_BASE_URL` en `.env` |
| **Docker aislado (dind) para apps** | No | Un daemon Docker *rootless* aparte y un dominio comodín | `DOCKER_HOST`, `APPS_HOST_SUFFIX` (ver más abajo) |

### Motor de IA

Elegí uno (se pueden combinar y poner uno de respaldo del otro):

- **Claude con suscripción:** en tu PC ejecutá `claude setup-token` y pegá el token en el panel (*Cuentas y motores*) o en `CLAUDE_CODE_OAUTH_TOKEN`. También podés iniciar sesión desde el panel (muestra el enlace de Anthropic y recibe el código).
- **Claude con API key:** `ANTHROPIC_API_KEY`.
- **OpenCode (gratis):** en el panel, *Cuentas y motores* → conectá un proveedor; sin cuenta ya aparecen modelos gratuitos de OpenCode Zen.

### Variables de entorno

`./install.sh` genera lo obligatorio. Referencia completa en [`.env.example`](.env.example):

| Variable | Para qué |
|---|---|
| `ADMIN_USER` / `ADMIN_PASSWORD` | Usuario inicial del panel (solo se usa la primera vez; después se gestiona en *Usuarios*) |
| `JWT_SECRET` | Firma las sesiones del panel |
| `AGENT_TOKEN` | Token con el que n8n le habla al hub |
| `EVOLUTION_API_KEY` | Clave de Evolution API (hub y n8n) |
| `POSTGRES_PASSWORD`, `N8N_ENCRYPTION_KEY` | Bases de datos y cifrado interno de n8n |
| `EVOLUTION_INSTANCE` | Nombre de la instancia de WhatsApp principal |
| `CLAUDE_CODE_OAUTH_TOKEN` / `ANTHROPIC_API_KEY` | Motor de IA (opcional aquí; se puede hacer desde el panel) |
| `GROQ_API_KEY` / `ELEVENLABS_API_KEY` | Audios entrantes / notas de voz |
| `HUB_BASE_URL` | URL pública https del panel |
| `TIMEZONE` | Zona horaria de recordatorios (por defecto `America/Asuncion`) |
| `AGENT_ROOT` | `1` = el agente puede usar `sudo` *dentro de su contenedor* para instalar paquetes |
| `HUB_PORT`, `EVOLUTION_PORT`, `N8N_PORT` | Puertos publicados (Evolution y n8n solo en `127.0.0.1`) |

## Cómo funciona

1. Alguien escribe al número → Evolution emite el evento `MESSAGES_UPSERT` al webhook de n8n.
2. n8n clasifica el mensaje (texto, audio, imagen, video, documento, ubicación, contacto, sticker, edición…) y llama al hub: `POST /api/agent/chat`.
3. El hub aplica las reglas de respuesta, prepara el contexto (personalidad, memoria, historial) y ejecuta el motor (`claude -p` u OpenCode) en una carpeta y un `HOME` propios.
4. El hub devuelve texto y archivos; n8n los parte en mensajes naturales y los envía con Evolution (`sendText`, `sendMedia`, `sendWhatsAppAudio`).

Más detalle en [`docs/ARQUITECTURA.md`](docs/ARQUITECTURA.md). El flujo de n8n está en [`n8n/kiri-whatsapp.workflow.json`](n8n/kiri-whatsapp.workflow.json) y lee sus claves de variables de entorno (no guarda credenciales).

## Recorrido por el panel

| | |
|---|---|
| ![Conversaciones](docs/screenshots/02-conversaciones.png) | ![Personalidades](docs/screenshots/03-personalidades.png) |
| ![Reglas de respuesta](docs/screenshots/04-reglas.png) | ![MCPs](docs/screenshots/05-mcps.png) |
| ![Tareas](docs/screenshots/06-tareas.png) | ![Probar agente](docs/screenshots/07-probar-agente.png) |


<details>
<summary><b>Más pantallas</b> (Tareas programadas, Paneles, Apps, Voz, WhatsApp, Configuración, Memoria, Motores, Usuarios)</summary>

| | |
|---|---|
| ![Tareas programadas](docs/screenshots/09-tareas-programadas.png) | ![Paneles](docs/screenshots/10-paneles.png) |
| ![Apps](docs/screenshots/11-apps.png) | ![Voz](docs/screenshots/12-voz.png) |
| ![WhatsApp](docs/screenshots/13-whatsapp.png) | ![Configuración de personalidad](docs/screenshots/14-personalidades-config.png) |
| ![Memoria](docs/screenshots/15-memoria.png) | ![Cuentas y motores](docs/screenshots/16-motores.png) |
| ![Usuarios](docs/screenshots/17-usuarios.png) | |

</details>

### Asistente integrado

Un botón flotante abre un chat que **entiende la pantalla en la que estás**: explica cada apartado, señala opciones, abre páginas y propone cambios de configuración mostrando el valor actual y el nuevo. El administrador los aprueba (y puede deshacerlos).

![Asistente integrado](docs/screenshots/08-asistente-integrado.png)

## Seguridad

- El agente corre como usuario sin privilegios en su propio contenedor, con carpeta, credenciales y sesiones propias. El proceso de IA **no hereda los secretos** del hub.
- El agente principal es solo un coordinador: no tiene herramientas peligrosas; el trabajo pesado lo hacen sub agentes. Las herramientas de archivos están confinadas a la carpeta de cada contacto (rutas validadas, sin symlinks ni SSRF).
- Las claves se guardan con permisos `600` y la API nunca las devuelve completas. Los enlaces de descarga son de un solo uso y vencen.
- Panel con login (bcrypt + JWT en cookie `httpOnly`) y límite de intentos. **Cambiá la contraseña inicial** y no expongas el puerto del panel a internet sin HTTPS.
- `AGENT_ROOT=1` da `sudo` al agente *dentro de su contenedor* (no es root del host); dejalo en `0` salvo que lo necesites.
- Activar permisos amplios (`bypassPermissions`, herramienta `Bash`) amplía lo que el agente puede hacer desde WhatsApp: hacelo solo con números de confianza.

## Funciones opcionales

- **Voz:** panel → *Voz*. Sin clave de ElevenLabs usa voces neurales gratuitas de Microsoft Edge (servicio no oficial: el texto pasa por Microsoft).
- **Apps con URL (Docker aislado):** requiere un daemon Docker *rootless* independiente (por TLS) y un dominio comodín que apunte al hub. No va montando el socket del host. Se activa con `DOCKER_HOST`, `DOCKER_CERT_PATH` y `APPS_HOST_SUFFIX`; sin eso la página *Apps* aparece como «no disponible».
- **Varios números:** panel → *WhatsApp* → *Agregar número*.
- **Conversaciones iniciadas por el agente, pase a humano, horario de atención:** panel → *Reglas de respuesta* / *WhatsApp* / *Tareas*.

## Desarrollo

```bash
cp .env.example .env     # completar los valores
npm install
npm run dev:server       # API en :4961
npm run dev:web          # panel en :5173 (proxy a la API)
```

**Modo demo** (sin WhatsApp ni IA, con datos de ejemplo — ideal para diseñar el front):

```bash
node scripts/dev-demo.mjs   # http://localhost:4990   (admin / admin123)
```

Requiere Node 24+. El panel es React + Vite; el servidor, Node.js + Express + SQLite.

## Problemas frecuentes

- **El panel dice «No se pudo consultar la línea de WhatsApp»:** Evolution todavía está arrancando (tarda ~30 s la primera vez) → *Reintentar*.
- **Escaneé el QR y no responde:** en *WhatsApp* comprobá que el *Webhook* esté «Sincronizado»; revisá también *Reglas de respuesta* (por defecto puede estar en «solo lista permitida»).
- **El agente no contesta:** *Cuentas y motores* debe tener un motor conectado; probá primero en *Probar agente*.
- **n8n no tiene el flujo:** `docker compose logs n8n`; el flujo se importa solo la primera vez (si falló, borrá el volumen de n8n con `docker compose down` + `docker volume rm kiridev_n8n-data`).
- **Logs:** `docker compose logs -f hub`.

## Licencia

[MIT](LICENSE) © Matias Vera. Hecho con [Claude Code](https://claude.com/claude-code), [Evolution API](https://github.com/EvolutionAPI/evolution-api) y [n8n](https://n8n.io).
