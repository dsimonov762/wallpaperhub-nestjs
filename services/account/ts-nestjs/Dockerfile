# syntax=docker/dockerfile:1
#
# account-service image. Build with the REPOSITORY ROOT as context (the lockfile and workspace live there):
#   docker build -f services/account/ts-nestjs/Dockerfile -t wallpaper-hub/account-service .
# `docker compose --profile infra --profile apps up --build` (pnpm apps:up) does this for you.
#
# Three stages: tools -> build (install, compile, keep ONLY production dependencies) -> a small runtime image.

ARG NODE_VERSION=24
ARG PNPM_VERSION=12.15.0

# ---- tools: Node + pnpm ---------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS tools
ARG PNPM_VERSION
RUN npm install --global "pnpm@${PNPM_VERSION}"
WORKDIR /repo

# ---- build: install, compile, prune ---------------------------------------------------------------------------------
FROM tools AS build
# 1. Only the files that decide WHICH packages are installed: this layer stays cached until dependencies change.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY services/account/ts-nestjs/package.json services/account/ts-nestjs/
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm install --frozen-lockfile --filter "account-service..." --store-dir /pnpm/store

# 2. The sources, then compile (TypeScript -> dist/, plus i18n bundles, Avro schemas and the .proto file).
COPY services/account/ts-nestjs services/account/ts-nestjs
RUN pnpm --filter account-service build

# 3. Production dependencies only (no TypeScript, test tools or linters) next to the compiled code, in /out.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    pnpm --filter account-service deploy --prod /out --store-dir /pnpm/store

# ---- runtime ---------------------------------------------------------------------------------------------------------
FROM node:${NODE_VERSION}-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=1000:1000 /out/package.json ./package.json
COPY --from=build --chown=1000:1000 /out/node_modules ./node_modules
COPY --from=build --chown=1000:1000 /out/dist ./dist

# Never run as root inside the container. 1000 is the `node` user of the base image (a numeric id lets
# Kubernetes verify `runAsNonRoot`).
USER 1000

# 8080 public HTTP API, 8081 management (health, counters), 9090 internal gRPC.
EXPOSE 8080 8081 9090

# "Healthy" means "ready for traffic": the database is reachable and bootstrap finished.
HEALTHCHECK --interval=10s --timeout=3s --start-period=30s --retries=5 \
  CMD ["wget", "--quiet", "--spider", "http://127.0.0.1:8081/health/ready"]

# Default command: the service. Migrations are the SAME image with another command: `node dist/migrate.js`.
CMD ["node", "dist/main.js"]
