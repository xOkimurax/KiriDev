#!/usr/bin/env bash
# Instalador de KiriDev: crea .env con secretos al azar y levanta todo con Docker.
#   ./install.sh            → instala y arranca
#   ./install.sh --no-start → solo genera el .env
set -euo pipefail
cd "$(dirname "$0")"

command -v docker >/dev/null || { echo "✗ Falta Docker. Instalalo desde https://docs.docker.com/get-docker/"; exit 1; }
docker compose version >/dev/null 2>&1 || { echo "✗ Falta el plugin «docker compose» (Docker 20.10+ con Compose v2)."; exit 1; }
rand() { if command -v openssl >/dev/null; then openssl rand -hex "$1"; else head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; fi; }

if [ -f .env ]; then
  echo "• Ya existe .env: lo respeto tal cual."
else
  PASS="$(rand 9)"
  cat > .env <<ENV
ADMIN_USER=admin
ADMIN_PASSWORD=$PASS
JWT_SECRET=$(rand 32)
AGENT_TOKEN=$(rand 24)
EVOLUTION_API_KEY=$(rand 24)
POSTGRES_PASSWORD=$(rand 16)
N8N_ENCRYPTION_KEY=$(rand 16)
EVOLUTION_INSTANCE=kiridev
HUB_PORT=4961
TIMEZONE=${TIMEZONE:-America/Asuncion}
# Opcionales: ver .env.example (motor de IA, Groq, ElevenLabs…). También se configuran desde el panel.
CLAUDE_CODE_OAUTH_TOKEN=
ANTHROPIC_API_KEY=
GROQ_API_KEY=
ELEVENLABS_API_KEY=
HUB_BASE_URL=
AGENT_ROOT=0
ENV
  chmod 600 .env
  echo "✓ Creé .env con secretos aleatorios."
  echo "  Usuario del panel: admin   Contraseña: $PASS   (queda guardada en .env)"
fi

[ "${1:-}" = "--no-start" ] && exit 0

echo "• Construyendo y levantando los servicios (la primera vez tarda unos minutos)…"
docker compose up -d --build

PORT="$(grep -E '^HUB_PORT=' .env | cut -d= -f2)"; PORT="${PORT:-4961}"
echo
echo "✓ Listo. Abrí el panel:  http://localhost:${PORT}"
echo "  1) Entrá con admin y la contraseña de .env."
echo "  2) «Cuentas y motores» → conectá el motor de IA (Claude Code u OpenCode)."
echo "  3) «WhatsApp» → generá el QR y escanealo con el número del agente."
echo "  4) «Probar agente» → conversá sin usar WhatsApp para comprobar que todo responde."
