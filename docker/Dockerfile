# syntax=docker/dockerfile:1.7
#
# Images des services de la plateforme, construites depuis la racine du monorepo :
#   docker build -f docker/Dockerfile --target api .
# Cibles : web, api, realtime, compile-gateway, compile-agent.

ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe

FROM ${NODE_IMAGE} AS base
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    NEXT_TELEMETRY_DISABLED=1 \
    TURBO_TELEMETRY_DISABLED=1
RUN corepack enable
WORKDIR /repo

# Dépendances puis build de tout le monorepo (Turborepo ordonne les paquets internes).
# Derrière un proxy TLS (développement), son certificat peut être fourni par le secret « ca ».
FROM base AS builder
COPY . .
RUN --mount=type=secret,id=ca,required=false \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    NODE_EXTRA_CA_CERTS=/run/secrets/ca pnpm install --frozen-lockfile
RUN pnpm turbo run build \
      --filter=@kaxolax/web --filter=@kaxolax/api --filter=@kaxolax/realtime \
      --filter=@kaxolax/compile-gateway --filter=@kaxolax/compile-agent
# Un dossier autonome par service : code compilé et dépendances de production seulement.
RUN --mount=type=secret,id=ca,required=false \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    export NODE_EXTRA_CA_CERTS=/run/secrets/ca \
 && for app in realtime compile-gateway compile-agent; do \
      pnpm --filter "@kaxolax/$app" deploy --prod "/out/$app"; \
    done \
 && pnpm --filter @kaxolax/api deploy --prod /out/api \
 && rm -rf /out/api/build && cp -r apps/api/build /out/api/build

FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production
WORKDIR /app
USER node

FROM runtime AS api
COPY --from=builder --chown=node:node /out/api /app
EXPOSE 3333
# Les migrations se lancent avec : node build/ace.js migration:run --force
CMD ["node", "build/bin/server.js"]

FROM runtime AS realtime
COPY --from=builder --chown=node:node /out/realtime /app
EXPOSE 1234
CMD ["node", "dist/main.js"]

FROM runtime AS compile-gateway
COPY --from=builder --chown=node:node /out/compile-gateway /app
EXPOSE 3100
CMD ["node", "dist/main.js"]

# L'agent pilote Docker par son socket (monté par l'hôte) : il tourne en root dans son conteneur,
# les compilations tournent dans des conteneurs neufs, non root et sans réseau.
FROM ${NODE_IMAGE} AS compile-agent
ENV NODE_ENV=production
WORKDIR /app
COPY --from=builder /out/compile-agent /app
EXPOSE 3200
CMD ["node", "dist/main.js"]

# Next.js en mode « standalone » : serveur minimal et fichiers statiques.
FROM runtime AS web
COPY --from=builder --chown=node:node /repo/apps/web/.next/standalone /app
COPY --from=builder --chown=node:node /repo/apps/web/.next/static /app/apps/web/.next/static
ENV HOSTNAME=0.0.0.0 PORT=3000
EXPOSE 3000
CMD ["node", "apps/web/server.js"]
