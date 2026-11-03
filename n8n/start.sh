#!/bin/sh
# Importa y publica el flujo "KiriDev WhatsApp" la primera vez, y después arranca n8n normalmente.
set -e
if [ ! -f /home/node/.n8n/.kiri-workflow-imported ]; then
  n8n import:workflow --input=/workflows/kiri-whatsapp.workflow.json
  n8n publish:workflow --id=kiriWhatsApp001 || n8n update:workflow --id=kiriWhatsApp001 --active=true || true
  touch /home/node/.n8n/.kiri-workflow-imported
fi
exec n8n start
