# kaxolax-platform

Monorepo applicatif de **Kaxolax**, plateforme web d'édition LaTeX collaborative.

## Prérequis

Le développement se fait sous Windows, entièrement dans WSL2 :

- WSL2 avec Ubuntu 24.04 ;
- Docker Desktop, avec l'intégration WSL activée pour la distribution Ubuntu ;
- le code cloné dans le système de fichiers Linux (`~/code/...`), **jamais sous `/mnt/c`** ;
- Node.js **24.21.0** (fichier `.nvmrc`), par exemple avec `nvm install` ;
- pnpm **11.28.2** (champ `packageManager`), activé par `corepack enable`.

## Installation

```bash
mkdir -p ~/code && cd ~/code
git clone https://github.com/synapsbranch-ux/kaxolax-platform.git
cd kaxolax-platform
nvm install          # lit .nvmrc
corepack enable      # fournit la version de pnpm du package.json
pnpm install
docker compose up -d
pnpm stack:check     # vérifie PostgreSQL, Redis, S3 et Mailpit
pnpm --filter @kaxolax/api migrate
pnpm dev
```

## Authentification (Clerk)

Comptes, connexion, OAuth, MFA et abonnements passent par [Clerk](https://clerk.com) ; Kaxolax
ne stocke ni mot de passe ni jeton d'authentification. En local et en CI : une **instance de
développement** Clerk (les adresses `+clerk_test` y reçoivent le code `424242`).

Réglages du Dashboard Clerk :

| Où                                         | Réglage                                                                                                                                                                                                                        |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| User & authentication → Email              | Adresse email avec vérification par code ; mot de passe activé                                                                                                                                                                 |
| User & authentication → Social connections | Google et GitHub (identifiants partagés en développement) ; ORCID en fournisseur OAuth personnalisé, à confirmer                                                                                                               |
| User & authentication → Multi-factor       | Application d'authentification (TOTP) et codes de secours                                                                                                                                                                      |
| Sessions → Customize session token         | `{"email": "{{user.primary_email_address}}", "email_verified": "{{user.email_verified}}", "name": "{{user.full_name}}", "picture": "{{user.image_url}}", "metadata": "{{user.public_metadata}}"}` (vérifier l'aperçu du jeton) |
| Webhooks                                   | Endpoint `https://<domaine>/api/v1/webhooks/clerk`, événements `user.created`, `user.updated`, `user.deleted`                                                                                                                  |
| API keys                                   | Clé publishable, clé secrète, et « PEM Public Key » (JWT public key)                                                                                                                                                           |

Variables (sans elles, l'application ne démarre pas l'authentification) :

| Variable                                  | `apps/api/.env` | `apps/web/.env` | Secret GitHub (CI) |
| ----------------------------------------- | --------------- | --------------- | ------------------ |
| `CLERK_PUBLISHABLE_KEY`                   |                 | oui             | oui                |
| `CLERK_SECRET_KEY`                        | oui             | oui             | oui                |
| `CLERK_JWT_KEY` (PEM sur une ligne, `\n`) | oui             | oui             | oui                |
| `CLERK_WEBHOOK_SIGNING_SECRET`            | oui             |                 |                    |

Les webhooks n'atteignent pas une machine locale ni la CI : l'API crée alors le miroir de
l'utilisateur depuis les claims de son jeton (d'où le jeton personnalisé ci-dessus). Pour les
recevoir en local : `cloudflared tunnel --url http://localhost:3333`, puis déclarer l'URL du
tunnel dans le Dashboard.

Admin (`apps/admin`, http://localhost:3001) : un compte devient admin par sa public metadata
`{"role": "admin"}` (Dashboard Clerk → Users → Metadata) et doit avoir la MFA activée ;
`ADMIN_URL` dans `apps/api/.env` (origine de l'admin, acceptée dans le claim `azp`) et, dans
`apps/admin/.env`, les mêmes variables Clerk que `apps/web/.env`. Voir `apps/admin/README.md`.

## Services locaux (docker compose)

Tous les ports sont ouverts sur `127.0.0.1` seulement. Les identifiants sont des valeurs de dev locales.

| Service        | Adresse                 | Détails                                                                                                |
| -------------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| PostgreSQL 18  | `localhost:5432`        | utilisateur et mot de passe `kaxolax` ; bases `kaxolax`, `kaxolax_test` et `kaxolax_realtime_test`     |
| Redis 8        | `localhost:6379`        | persistance AOF                                                                                        |
| S3 (SeaweedFS) | `http://localhost:8333` | clés `kaxolax` / `kaxolax-local-secret` ; buckets `kaxolax-project-files` et `kaxolax-compile-outputs` |
| Mailpit (SMTP) | `localhost:1025`        | accepte tout, n'envoie rien à l'extérieur                                                              |
| Mailpit (UI)   | http://localhost:8025   | boîte de réception des emails de l'application (ceux de l'auth sont envoyés par Clerk)                 |

Le conteneur `s3-init` crée les buckets au démarrage, applique la règle CORS pour
`http://localhost:3000` et les expirations (sorties de compilation : 7 jours ; uploads en
attente : 1 jour), puis s'arrête. Un client S3 local doit utiliser `forcePathStyle: true` et
`requestChecksumCalculation: 'WHEN_REQUIRED'` (voir `docs/decisions.md`).

## Commandes

| Commande                         | Effet                                                         |
| -------------------------------- | ------------------------------------------------------------- |
| `pnpm dev`                       | Lance tous les paquets et apps en mode développement          |
| `pnpm build`                     | Compile tout                                                  |
| `pnpm lint`                      | ESLint (règles typées strictes)                               |
| `pnpm typecheck`                 | Vérification des types                                        |
| `pnpm test`                      | Tests (Vitest, Japa) ; la stack locale doit tourner           |
| `pnpm check`                     | lint + typecheck + tests + build, comme la CI                 |
| `pnpm format`                    | Formate avec Prettier (`format:check` pour vérifier)          |
| `pnpm stack:up`                  | `docker compose up -d --wait`                                 |
| `pnpm stack:check`               | Vérifie que la stack locale répond                            |
| `pnpm stack:down`                | Arrête la stack (`docker compose down -v` efface les données) |
| `pnpm --filter @kaxolax/web e2e` | Parcours Playwright de la « Définition de terminé »           |

## Structure

```
apps/
  api/                API REST AdonisJS (miroir des comptes Clerk, projets, arborescence)
  compile-agent/      agent de compilation (sandbox Docker, latexmk, SyncTeX)
  compile-gateway/    verrous Redis, affinité et bascule entre agents
  web/                application Next.js (Clerk, tableau de bord, éditeur)
  admin/              admin Next.js (utilisateurs, projets, bannière, statistiques, journal)
  realtime/           édition collaborative (Hocuspocus + Yjs, persistance PostgreSQL)
functions/
  upload-processor/   vérification et classement d'un fichier uploadé
  zip-importer/       extraction et validation d'un projet zip
packages/
  collab/             conventions Yjs (nom des documents, champ texte)
  config/             tsconfig, ESLint, Prettier
  contracts/          schémas zod partagés entre services
  editor/             CodeMirror : langage LaTeX, thèmes, registre d'actions, outline, auto-compilation
  ui/                 composants shadcn/ui partagés
  latex-log-parser/   parsing des logs LaTeX, BibTeX et Biber
docs/          décisions d'architecture (decisions.md)
docker/        configuration des services locaux
scripts/       outils de développement
```

## Image TeX Live

L'agent de compilation utilise l'image `kaxolax-texlive:2026-medium` du repo
`kaxolax-texlive-images`, à construire ou à récupérer depuis GHCR :

```bash
docker pull ghcr.io/synapsbranch-ux/kaxolax-texlive:2026-medium
docker tag ghcr.io/synapsbranch-ux/kaxolax-texlive:2026-medium kaxolax-texlive:2026-medium
```

## Images et staging

`docker/Dockerfile` construit une image par service (`--target web|api|realtime|compile-gateway|compile-agent`).
La CI (`.github/workflows/images.yml`) les construit en arm64 à chaque push. Depuis `main`, elle
les pousse dans ECR (`kaxolax/<service>:staging`), déploie le staging par SSM (`kaxolax-deploy`),
puis lance le parcours Playwright sur le staging. L'infrastructure, sa mise en place et les
variables du dépôt à poser sont décrites dans `kaxolax-infra`.

## Conventions

- TypeScript strict partout ; versions exactes, centralisées dans le `catalog` de `pnpm-workspace.yaml`.
- Messages de commit au format [Conventional Commits](https://www.conventionalcommits.org/) (vérifié en CI).
- Les échanges entre services sont validés avec les schémas de `@kaxolax/contracts`.
- Aucun secret commité : un `.env.example` par app, gitleaks tourne en CI.
- Chaque décision non triviale est notée dans `docs/decisions.md`.
