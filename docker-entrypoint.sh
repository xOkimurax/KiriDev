#!/bin/sh
# /data es un volumen persistente (DB, personalidad, sesiones de Claude). Claude Code no corre como root.
set -e
# /data = volumen dedicado de 40 GB (ext4 en un archivo de tamaño fijo montado por la VPS): datos del hub + descargas (/data/work).
mkdir -p /data /data/work
chown -R node:node /data
# AGENT_ROOT=1 (variable del despliegue): el agente puede usar `sudo` DENTRO de su contenedor (apt install, etc.).
# Es root del contenedor, no de la VPS: no es privilegiado, no tiene el socket de Docker y solo ve su volumen /data.
if [ "${AGENT_ROOT:-0}" = "1" ]; then
  echo 'node ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/kiri-agent && chmod 440 /etc/sudoers.d/kiri-agent
  # Instalaciones permanentes: /data/setup.sh (lo escribe el agente con `kiri-install`) se reaplica en cada arranque, en segundo plano.
  # Solo con AGENT_ROOT=1: sin eso, un archivo escrito por el agente NO se ejecuta como root.
  if [ -f /data/setup.sh ]; then ( bash /data/setup.sh >> /data/setup.log 2>&1 & ); fi
else
  rm -f /etc/sudoers.d/kiri-agent
fi
# Docker aislado del agente (dind rootless en otro contenedor, por TLS): los certificados de CLIENTE llegan montados en /dind-certs (solo lectura).
# Se copian al volumen con permisos solo para `node`. Sin ese montaje la función no existe: se borra cualquier copia vieja.
if [ -f /dind-certs/key.pem ]; then
  mkdir -p /data/docker-certs && cp /dind-certs/ca.pem /dind-certs/cert.pem /dind-certs/key.pem /data/docker-certs/
  chown -R node:node /data/docker-certs && chmod 700 /data/docker-certs && chmod 600 /data/docker-certs/*
else
  rm -rf /data/docker-certs
fi
exec setpriv --reuid=node --regid=node --init-groups "$@"
