# syntax=docker/dockerfile:1.7
#
# TokenGo API image. ONE image, TWO entry points (docs/ARCHITECTURE-PROPOSAL.md §P):
#
#   api      (default)  node dist/main.api.js      HTTP, listens on $PORT (3000), HEALTHCHECK on /api/v1/health/ready
#   worker              node dist/main.worker.js   same image, command override: outbox runner, housekeeping, payout tick
#   migrate  (target)   node-pg-migrate up         one-shot job image: forward-only SQL migrations, then exits
#
# BUILD CONTEXT = REPOSITORY ROOT (pnpm workspace):
#   docker build -f apps/api/Dockerfile -t tokengo-api:local .
#   docker build -f apps/api/Dockerfile --target migrate -t tokengo-migrate:local .
#
# Properties: multi-stage, dev dependencies never reach a runtime layer, no .env / key material (see /.dockerignore),
# non-root `node` user, tini as PID 1 (signals + zombie reaping: SIGTERM => graceful shutdown), read-only-root-filesystem safe.
# Secrets are injected at run time (ECS: Secrets Manager -> environment). Nothing secret is a build argument.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=9.15.0

# ------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm \
    npm_config_store_dir=/pnpm/store \
    CI=true
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

# ---- fetch: fill the pnpm store from the LOCKFILE ONLY. This is the slow, network-bound layer and it is cached until
# pnpm-lock.yaml changes (source edits do not invalidate it).
FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=tokengo-pnpm-store,target=/pnpm/store pnpm fetch

# ---- build: install (offline, frozen lockfile), compile, and produce the production-only dependency tree.
FROM fetch AS build
COPY apps ./apps
RUN --mount=type=cache,id=tokengo-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@tokengo/api..."
RUN pnpm --filter @tokengo/api build
# `pnpm deploy --prod`: a self-contained copy of the API's PRODUCTION dependencies only (no eslint/jest/typescript/nest-cli).
RUN --mount=type=cache,id=tokengo-pnpm-store,target=/pnpm/store \
    pnpm --filter @tokengo/api deploy --prod /out/api
# node-pg-migrate is a devDependency (a deploy tool), so it is NOT in /out/api. Extract just its dependency closure.
COPY docker/pnpm-closure.cjs ./docker/pnpm-closure.cjs
RUN node docker/pnpm-closure.cjs apps/api node-pg-migrate /out/migrate

# ------------------------------------------------------------------------------------------------------------------
FROM ${NODE_IMAGE} AS runtime-base
ARG GIT_SHA=unknown
ARG BUILD_DATE=unknown
LABEL org.opencontainers.image.title="tokengo-api" \
      org.opencontainers.image.description="TokenGo backend (API + worker + migrate entry points)" \
      org.opencontainers.image.revision="${GIT_SHA}" \
      org.opencontainers.image.created="${BUILD_DATE}"
ENV NODE_ENV=production \
    PORT=3000 \
    NODE_OPTIONS=--enable-source-maps
# tini: PID 1 that forwards SIGTERM (ECS stop / compose down) to node and reaps zombies.
RUN apt-get update \
 && apt-get install -y --no-install-recommends tini \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENTRYPOINT ["/usr/bin/tini", "--"]

# ---- migrate: one-shot job. Needs DATABASE_URL (a role allowed to create schemas/extensions/tables) and nothing else.
FROM runtime-base AS migrate
COPY --from=build --chown=node:node /out/migrate/node_modules ./node_modules
COPY --chown=node:node apps/api/migrations ./migrations
USER node
CMD ["node", "node_modules/node-pg-migrate/bin/node-pg-migrate.js", "up", "--migrations-dir", "migrations", "--database-url-var", "DATABASE_URL"]

# ---- api (LAST stage => the default target). The worker is this same image with `node dist/main.worker.js`.
FROM runtime-base AS api
COPY --from=build --chown=node:node /out/api/node_modules ./node_modules
COPY --from=build --chown=node:node /out/api/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
COPY --chown=node:node docker/healthcheck.cjs ./docker/healthcheck.cjs
USER node
EXPOSE 3000
# Readiness (includes a database round-trip) — used by `docker compose` depends_on and `docker ps`. ECS ignores this and uses the
# task definition's own check (infra/terraform/modules/ecs-service); the worker has no HTTP port and disables it.
HEALTHCHECK --interval=15s --timeout=4s --start-period=25s --retries=3 \
  CMD ["node", "docker/healthcheck.cjs", "/api/v1/health/ready"]
CMD ["node", "dist/main.api.js"]
