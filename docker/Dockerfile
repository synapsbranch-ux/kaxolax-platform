# syntax=docker/dockerfile:1.7
#
# Images des services de la plateforme, construites depuis la racine du monorepo :
#   docker build -f docker/Dockerfile --target api .
# Cibles : web, admin, api, realtime, compile-gateway, compile-agent.
# Railway ne choisit pas de cible : sans --target, la dernière étape (« service ») reprend celle
# désignée par l'argument KAXOLAX_SERVICE (variable du service Railway, voir deploy/railway/) :
#   docker build -f docker/Dockerfile --build-arg KAXOLAX_SERVICE=api .
# Sans cet argument, le build échoue (étape missing-kaxolax-service) au lieu de construire en
# silence une autre image que celle du service.
# Pas de cache mount (--mount=type=cache) : Railway n'accepte que des identifiants propres à
# chaque service (s/<service-id>-…), inconnus ici ; l'installation reste reproductible
# (--frozen-lockfile, image Node épinglée par empreinte).

ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
# Étape finale : web, admin, api ou realtime. Pas de valeur par défaut (voir plus haut).
ARG KAXOLAX_SERVICE

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
# Cible des réécritures /api de Next.js (apps/web/next.config.ts) : figée par `next build` dans
# routes-manifest.json, elle doit être connue au build. Railway transmet la variable de service du
# même nom comme argument de build ; la valeur par défaut sert en local et en CI.
ARG API_INTERNAL_URL=http://127.0.0.1:3333
COPY . .
RUN --mount=type=secret,id=ca,required=false \
    NODE_EXTRA_CA_CERTS=/run/secrets/ca pnpm install --frozen-lockfile
RUN pnpm turbo run build \
      --filter=@kaxolax/web --filter=@kaxolax/admin --filter=@kaxolax/api --filter=@kaxolax/realtime \
      --filter=@kaxolax/compile-gateway --filter=@kaxolax/compile-agent
# Un dossier autonome par service : code compilé et dépendances de production seulement.
RUN --mount=type=secret,id=ca,required=false \
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

# Admin (apps/admin), même principe que web, sur le port 3001 (celui de `next dev` en local) :
# le domaine admin.<domaine> de Railway vise ce port (PORT=3001, kaxolax-infra/railway/provision.sh).
FROM runtime AS admin
COPY --from=builder --chown=node:node /repo/apps/admin/.next/standalone /app
COPY --from=builder --chown=node:node /repo/apps/admin/.next/static /app/apps/admin/.next/static
ENV HOSTNAME=0.0.0.0 PORT=3001
EXPOSE 3001
CMD ["node", "apps/admin/server.js"]

# Build sans KAXOLAX_SERVICE : échec explicite. Seule l'étape « service » y mène ; les builds par
# --target ne la construisent jamais.
FROM runtime AS missing-kaxolax-service
RUN echo "ERREUR : argument de build KAXOLAX_SERVICE absent. Le poser (web, admin, api ou realtime) : variable du service Railway, ou --build-arg KAXOLAX_SERVICE=<service> (sinon --target <service>)." >&2 \
 && exit 1

# Étape par défaut (Railway) : l'image du service KAXOLAX_SERVICE (web, admin, api ou realtime).
# Une autre valeur désigne une image inexistante : le build échoue en la nommant.
FROM ${KAXOLAX_SERVICE:-missing-kaxolax-service} AS service
