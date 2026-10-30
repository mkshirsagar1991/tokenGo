# syntax=docker/dockerfile:1.7
#
# TokenGo admin portal (Next.js). BUILD CONTEXT = REPOSITORY ROOT (pnpm workspace), like apps/api/Dockerfile:
#   docker build -f apps/admin/Dockerfile -t tokengo-admin:local .
#
# The browser only ever talks to this server; the portal's own server side calls the API (API_BASE_URL). Runtime configuration is
# environment only (see apps/admin/.env.example): SESSION_SECRET (32+ chars), API_BASE_URL, ALLOWED_ORIGINS, COOKIE_SECURE, TRUST_PROXY.
# Non-root `node` user, tini as PID 1, no secrets in any layer.

ARG NODE_IMAGE=node:22-bookworm-slim
ARG PNPM_VERSION=9.15.0

FROM ${NODE_IMAGE} AS base
ARG PNPM_VERSION
ENV PNPM_HOME=/pnpm npm_config_store_dir=/pnpm/store CI=true NEXT_TELEMETRY_DISABLED=1
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
WORKDIR /repo

FROM base AS fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
RUN --mount=type=cache,id=tokengo-pnpm-store,target=/pnpm/store pnpm fetch

FROM fetch AS build
COPY apps/admin ./apps/admin
RUN --mount=type=cache,id=tokengo-pnpm-store,target=/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "@tokengo/admin..."
RUN pnpm --filter @tokengo/admin build
RUN --mount=type=cache,id=tokengo-pnpm-store,target=/pnpm/store \
    pnpm --filter @tokengo/admin deploy --prod /out/admin

FROM ${NODE_IMAGE} AS admin
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 HOSTNAME=0.0.0.0
RUN apt-get update && apt-get install -y --no-install-recommends tini && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build --chown=node:node /out/admin/node_modules ./node_modules
COPY --from=build --chown=node:node /out/admin/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/admin/.next ./.next
COPY --from=build --chown=node:node /repo/apps/admin/public ./public
COPY --from=build --chown=node:node /repo/apps/admin/next.config.ts ./next.config.ts
USER node
EXPOSE 3000
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node_modules/.bin/next", "start", "--port", "3000", "--hostname", "0.0.0.0"]
