# syntax=docker/dockerfile:1
# Official node:24.16 image already provides user/group `node` (uid/gid 1000).
FROM node:24.16.0-bookworm-slim

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json ./
RUN npm install --omit=dev --ignore-scripts

COPY server.mjs ./
COPY server ./server
COPY dist ./dist
COPY tools ./tools
COPY README-DEPLOY.md ./README-DEPLOY.md

ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=3000
ENV DATA_DIR=/var/lib/bai-nha
ENV SECURE_COOKIE=1

RUN mkdir -p /var/lib/bai-nha && chown -R node:node /app /var/lib/bai-nha

USER node
EXPOSE 3000
VOLUME ["/var/lib/bai-nha"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server.mjs"]
