# syntax=docker/dockerfile:1.7
#
# Conteneur de compilation Cloudflare (une VM par projet, sans réseau) : l'agent de compilation de
# l'étape 1 (apps/compile-agent, point d'entrée container-main) sur l'image TeX Live durcie.
# Construit par `wrangler deploy`, qui impose linux/amd64 ; contexte = racine du monorepo :
#   docker build --platform linux/amd64 -f apps/compile-worker/container/Dockerfile .
# (production : wrangler.jsonc passe TEXLIVE_REQUIRE_PINNED=1 par image_vars, voir plus bas)

ARG NODE_IMAGE=node:24.21.0-trixie-slim@sha256:8ec5d7557396cfe32d21c3f9c13072355ceab22b584578ca4bb28af31120cffe
# Image TeX Live de production (variante medium, décision C.6, linux/amd64), épinglée par son
# empreinte dans cette seule référence : `ghcr.io/…/kaxolax-texlive:2026-medium@sha256:<64 hex>`.
# Après chaque publication par kaxolax-texlive-images, y ajouter l'empreinte donnée par
# `docker buildx imagetools inspect ghcr.io/synapsbranch-ux/kaxolax-texlive:2026-medium` (la même
# que texlive_digest de scripts/build.sh dans kaxolax-templates). Un `--build-arg TEXLIVE_IMAGE=…`
# remplace toute la référence : changer de variante ne garde jamais une empreinte périmée.
ARG TEXLIVE_IMAGE=ghcr.io/synapsbranch-ux/kaxolax-texlive:2026-medium@sha256:46634759857550be0959d22dc54dcb2349e269c7a6e405e0717dd75446d23e15
# Image de production sans empreinte : build refusé, car une étiquette peut désigner une autre
# image sans aucun commit. `wrangler deploy` passe TEXLIVE_REQUIRE_PINNED=1 (image_vars de
# wrangler.jsonc, à ne jamais retirer) ; la CI et le poste local ne le passent pas, et construisent
# donc l'étiquette tant que l'empreinte n'est pas posée.
ARG TEXLIVE_REQUIRE_PINNED=

FROM ${NODE_IMAGE} AS builder
ENV PNPM_HOME=/pnpm \
    PATH=/pnpm:$PATH \
    CI=true \
    TURBO_TELEMETRY_DISABLED=1
WORKDIR /repo
ARG TEXLIVE_IMAGE
ARG TEXLIVE_REQUIRE_PINNED
# Refus d'une image TeX Live non épinglée en production (étape exécutée : l'étape finale copie
# depuis builder).
RUN if [ "$TEXLIVE_REQUIRE_PINNED" = 1 ] \
      && ! expr "$TEXLIVE_IMAGE" : '.*@sha256:[0-9a-f]\{64\}$' >/dev/null; then \
      echo "TEXLIVE_IMAGE=${TEXLIVE_IMAGE} is not pinned: append @sha256:<digest> (docker buildx imagetools inspect) before deploying" >&2; \
      exit 1; \
    fi
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
# Init en PID 1 (tini 0.19.0, binaire statique officiel, empreinte publiée par la release) : Node
# ne réclame pas les orphelins d'une compilation tuée, qui resteraient zombies et compteraient
# dans la limite de processus de l'UID du sandbox.
ADD --checksum=sha256:c5b0666b4cb676901f90dfcb37106783c5fe2077b04590973b885950611b30ee --chmod=0755 \
    https://github.com/krallin/tini/releases/download/v0.19.0/tini-static-amd64 /usr/local/bin/tini
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
ENTRYPOINT ["/usr/local/bin/tini", "--"]
CMD ["node", "dist/container-main.js"]
