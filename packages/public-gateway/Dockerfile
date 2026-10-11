# Build from the repository root, so the lockfile pins the dependencies:
#   docker build -f packages/public-gateway/Dockerfile -t noodle-public-gateway .
FROM node:24.21.0-alpine AS build
WORKDIR /usr/src/app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches ./patches
# only what runs: never the e2e keys and data that may sit next to it in a checkout
COPY packages/public-gateway/package.json ./packages/public-gateway/
COPY packages/public-gateway/src ./packages/public-gateway/src
RUN pnpm --filter @immich/public-gateway deploy --prod /out

FROM node:24.21.0-alpine
WORKDIR /app
COPY --from=build /out/package.json ./
COPY --from=build /out/node_modules ./node_modules
COPY --from=build /out/src ./src
ENV NODE_ENV=production GATEWAY_CONFIG=/etc/public-gateway/gateway.yaml
USER node
EXPOSE 8080
# reads the port from the config, so a custom `listen.port` keeps the check right
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s CMD ["node", "src/healthcheck.ts"]
CMD ["node", "src/main.ts"]
