# Cliente de Docker (binarios estáticos) para el Docker aislado del agente; NO hay daemon acá. Digest fijado = el mismo que se probó.
FROM docker:cli@sha256:5e6baf67325a79f64ed3bed6863954d5e05d0f3d4e57cbdb14809346814bbfdb AS dockercli

FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY web web
RUN npm run build

FROM node:24-bookworm-slim
ENV NODE_ENV=production DATA_DIR=/data WORK_DIR=/data/work PORT=4961 CHROME_BIN=/usr/bin/chromium PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium PUPPETEER_SKIP_DOWNLOAD=1
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl git ripgrep unzip ffmpeg sudo chromium fonts-liberation tini && rm -rf /var/lib/apt/lists/* \
 && curl -fsSL https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux -o /usr/local/bin/yt-dlp && chmod 0755 /usr/local/bin/yt-dlp \
 && npm install -g --allow-scripts=@anthropic-ai/claude-code @anthropic-ai/claude-code \
 && npm install -g opencode-ai@1.19.3 && opencode --version
COPY --from=dockercli /usr/local/bin/docker /usr/local/bin/docker
COPY --from=dockercli /usr/local/libexec/docker/cli-plugins/docker-compose /usr/local/libexec/docker/cli-plugins/docker-compose
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev -w server
COPY server server
COPY agent-seed agent-seed
COPY --from=build /app/web/dist web/dist
COPY docker-entrypoint.sh kiri-install /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/kiri-install
EXPOSE 4961
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://localhost:4961/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
# tini como PID 1: recoge los procesos huérfanos (Chromium, ffmpeg, yt-dlp) para que no queden zombis
ENTRYPOINT ["/usr/bin/tini", "-g", "--", "docker-entrypoint.sh"]
CMD ["node", "server/src/index.js"]
