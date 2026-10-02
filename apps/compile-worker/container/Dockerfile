# syntax=docker/dockerfile:1.7
#
# Conteneur de compilation Cloudflare (une VM par projet, sans réseau) : l'agent de compilation de
# l'étape 1 (apps/compile-agent, point d'entrée container-main) sur l'image TeX Live durcie.
# Construit par `wrangler deploy`, qui impose linux/amd64 ; contexte = racine du monorepo :
#   docker build --platform linux/amd64 -f apps/compile-worker/container/Dockerfile .

ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
# medium : seule variante publiée sur GHCR aujourd'hui ; full en production dès sa publication
# (--build-arg ou image_vars). Épingler par empreinte au déploiement.
ARG TEXLIVE_IMAGE=ghcr.io/synapsbranch-ux/kaxolax-texlive:2026-medium

FROM ${NODE_IMAGE} AS builder
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo
COPY . .
# Derrière un proxy TLS (développement), son certificat peut être fourni par le secret « ca ».
RUN --mount=type=secret,id=ca,required=false \
    --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    export NODE_EXTRA_CA_CERTS=/run/secrets/ca \
 && corepack enable \
 && pnpm install --frozen-lockfile --filter "@kaxolax/compile-agent..." \
 && pnpm turbo run build --filter=@kaxolax/compile-agent \
 && pnpm --filter @kaxolax/compile-agent deploy --prod /out/compile-agent

FROM ${TEXLIVE_IMAGE}
# L'agent tourne en root dans la VM pour confiner chaque compilation (prlimit, choom, setpriv) en
# UID 1000 ; l'image TeX Live finit en USER 1000.
# hadolint ignore=DL3002
USER root
# Binaire Node officiel (libstdc++ liée statiquement), même Debian trixie que l'image TeX Live.
COPY --from=builder /usr/local/bin/node /usr/local/bin/node
COPY --from=builder /out/compile-agent /opt/kaxolax/agent
# compiles/ : traversable par l'UID 1000 (son répertoire de projet) ; cache et sorties : root seul.
RUN install -d -m 0711 /srv/kaxolax /srv/kaxolax/compiles \
  && install -d -m 0700 /srv/kaxolax/cache /srv/kaxolax/outputs \
  && chmod 1777 /tmp \
  && node --version \
  && prlimit --version \
  && setpriv --version \
  && choom --version
ENV NODE_ENV=production \
    PORT=8080
WORKDIR /opt/kaxolax/agent
EXPOSE 8080
CMD ["node", "dist/container-main.js"]
