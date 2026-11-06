FROM node:22-bookworm-slim

WORKDIR /app

COPY package*.json ./
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir 'yt-dlp[default,curl-cffi]' \
    && npm ci --omit=dev \
    && npm cache clean --force

COPY . .

ENV NODE_ENV=production
ENV YT_DLP_PATH=/opt/yt-dlp/bin/yt-dlp
EXPOSE 3000

RUN mkdir -p /app/downloads /app/data \
    && chown -R node:node /app

USER node

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3000/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
