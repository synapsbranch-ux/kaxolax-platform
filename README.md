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

## Services locaux (docker compose)

Tous les ports sont ouverts sur `127.0.0.1` seulement. Les identifiants sont des valeurs de dev locales.

| Service        | Adresse                 | Détails                                                                                                |
| -------------- | ----------------------- | ------------------------------------------------------------------------------------------------------ |
| PostgreSQL 18  | `localhost:5432`        | utilisateur et mot de passe `kaxolax` ; bases `kaxolax`, `kaxolax_test` et `kaxolax_realtime_test`     |
| Redis 8        | `localhost:6379`        | persistance AOF                                                                                        |
| S3 (SeaweedFS) | `http://localhost:8333` | clés `kaxolax` / `kaxolax-local-secret` ; buckets `kaxolax-project-files` et `kaxolax-compile-outputs` |
| Mailpit (SMTP) | `localhost:1025`        | accepte tout, n'envoie rien à l'extérieur                                                              |
| Mailpit (UI)   | http://localhost:8025   | boîte de réception des emails envoyés en local                                                         |

Le conteneur `s3-init` crée les buckets au démarrage, applique la règle CORS pour
`http://localhost:3000` et les expirations (sorties de compilation : 7 jours ; uploads en
attente : 1 jour), puis s'arrête. Un client S3 local doit utiliser `forcePathStyle: true` et
`requestChecksumCalculation: 'WHEN_REQUIRED'` (voir `docs/decisions.md`).

## Commandes

| Commande           | Effet                                                         |
| ------------------ | ------------------------------------------------------------- |
| `pnpm dev`         | Lance tous les paquets et apps en mode développement          |
| `pnpm build`       | Compile tout                                                  |
| `pnpm lint`        | ESLint (règles typées strictes)                               |
| `pnpm typecheck`   | Vérification des types                                        |
| `pnpm test`        | Tests (Vitest, Japa) ; PostgreSQL et Redis doivent tourner    |
| `pnpm check`       | lint + typecheck + tests + build, comme la CI                 |
| `pnpm format`      | Formate avec Prettier (`format:check` pour vérifier)          |
| `pnpm stack:up`    | `docker compose up -d --wait`                                 |
| `pnpm stack:check` | Vérifie que la stack locale répond                            |
| `pnpm stack:down`  | Arrête la stack (`docker compose down -v` efface les données) |

## Structure

```
apps/
  api/                API REST AdonisJS (comptes, projets, arborescence)
  compile-agent/      agent de compilation (sandbox Docker, latexmk, SyncTeX)
  realtime/           édition collaborative (Hocuspocus + Yjs, persistance PostgreSQL)
functions/     fonctions pures + handlers Lambda (upload-processor, zip-importer)
packages/
  collab/             conventions Yjs (nom des documents, champ texte)
  config/             tsconfig, ESLint, Prettier
  contracts/          schémas zod partagés entre services
  latex-log-parser/   parsing des logs LaTeX, BibTeX et Biber
docs/          décisions d'architecture (decisions.md)
docker/        configuration des services locaux
scripts/       outils de développement
```

Les autres apps (web, compile-gateway) arrivent au fil des tâches de l'étape 1.

## Image TeX Live

L'agent de compilation utilise l'image `kaxolax-texlive:2026-medium` du repo
`kaxolax-texlive-images`, à construire ou à récupérer depuis GHCR :

```bash
docker pull ghcr.io/synapsbranch-ux/kaxolax-texlive:2026-medium
docker tag ghcr.io/synapsbranch-ux/kaxolax-texlive:2026-medium kaxolax-texlive:2026-medium
```

## Conventions

- TypeScript strict partout ; versions exactes, centralisées dans le `catalog` de `pnpm-workspace.yaml`.
- Messages de commit au format [Conventional Commits](https://www.conventionalcommits.org/) (vérifié en CI).
- Les échanges entre services sont validés avec les schémas de `@kaxolax/contracts`.
- Aucun secret commité : un `.env.example` par app, gitleaks tourne en CI.
- Chaque décision non triviale est notée dans `docs/decisions.md`.
