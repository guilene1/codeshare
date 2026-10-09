# The build stage emits platform-independent JS/CSS, so it runs natively on the
# build machine; only the application and web stages target the server platform.
FROM --platform=$BUILDPLATFORM node:24-bookworm-slim AS build
WORKDIR /app
ENV NODE_OPTIONS=--max-old-space-size=1536
COPY package*.json ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
RUN npm ci
COPY frontend frontend
COPY backend backend
RUN npm run build

FROM node:24-bookworm-slim AS application
ENV NODE_ENV=production PORT=3000 DB_PATH=/data/devshare.sqlite
WORKDIR /app
COPY package*.json ./
COPY frontend/package.json frontend/package.json
COPY backend/package.json backend/package.json
RUN npm ci --omit=dev --workspace backend --include-workspace-root=false && npm cache clean --force && mkdir /data && chown node:node /data
COPY --from=build /app/backend/dist backend/dist
COPY scripts/snapshot.mjs scripts/snapshot.mjs
COPY scripts/recover-editor.mjs scripts/recover-editor.mjs
COPY scripts/issue-password-reset.mjs scripts/issue-password-reset.mjs
COPY scripts/assign-owner.mjs scripts/assign-owner.mjs
COPY scripts/email-outbox.mjs scripts/email-outbox.mjs
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "backend/dist/index.js"]

FROM caddy:2-alpine AS web
COPY --from=build /app/frontend/dist /srv
COPY Caddyfile /etc/caddy/Caddyfile
