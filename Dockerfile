# One image: the collector and the built dashboard in a single process.
FROM node:22-alpine AS build
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build

FROM node:22-alpine AS runtime
RUN corepack enable
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4100 \
    DASHBOARD_DIR=/app/public \
    GEOIP_DIR=/app/data/geo

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/tracker/package.json ./packages/tracker/
COPY packages/server/package.json ./packages/server/
COPY packages/dashboard/package.json ./packages/dashboard/
COPY packages/store-mongo/package.json ./packages/store-mongo/
COPY packages/geo/package.json ./packages/geo/
COPY packages/sdk-node/package.json ./packages/sdk-node/
RUN pnpm install --frozen-lockfile --prod --filter @chokh/server...

COPY --from=build /app/packages/server/dist ./packages/server/dist
COPY --from=build /app/packages/geo/dist ./packages/geo/dist
COPY --from=build /app/packages/dashboard/dist ./public

# The geo refresh job writes here, so it belongs to the user the server runs as.
RUN mkdir -p /app/data/geo && chown -R node:node /app/data

EXPOSE 4100
USER node

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4100)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "packages/server/dist/server.js"]
