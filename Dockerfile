FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY public/ public/
COPY scripts/ scripts/
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm AS backend
WORKDIR /app
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3000
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
COPY --from=build --chown=node:node /app/node_modules/ node_modules/
COPY --from=build --chown=node:node /app/public/ public/
COPY --chown=node:node package.json server.mjs ./
COPY --chown=node:node services/ services/
COPY --chown=node:node docs/openapi.yaml docs/openapi.yaml
RUN mkdir -p /ms-playwright /app/.cache && node node_modules/playwright/cli.js install --with-deps chromium && chown -R node:node /ms-playwright /app/.cache
USER node
EXPOSE 3000
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD node -e "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server.mjs"]

FROM nginx:1.28-alpine AS frontend
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist/ /usr/share/nginx/html/
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/ || exit 1