# Railway : configuration des services

Un fichier « config as code » par service Railway, seule source de sa configuration de
construction et de déploiement. Railway ne lit que `/railway.json` par défaut : dans chaque
service, **Settings → Config-as-code → Railway Config File** désigne le chemin absolu du fichier
(`/deploy/railway/api.json`…), et sa configuration prime sur celle du tableau de bord.
`kaxolax-infra/railway/provision.sh` déclare ce chemin (API publique de Railway) et applique les
sections `build` et `deploy` de ces mêmes fichiers par la CLI : modifier un réglage ici, jamais
dans le script.

| Service Railway | Fichier                | Image                                                   | Port | Healthcheck      | Réplicas |
| --------------- | ---------------------- | ------------------------------------------------------- | ---- | ---------------- | -------- |
| `web`           | `web.json`             | `docker/Dockerfile`, `KAXOLAX_SERVICE=web`              | 3000 | `/healthz`       | 2        |
| `admin`         | `admin.json`           | `docker/Dockerfile`, `KAXOLAX_SERVICE=admin`            | 3001 | `/healthz`       | 1        |
| `api`           | `api.json`             | `docker/Dockerfile`, `KAXOLAX_SERVICE=api`              | 3333 | `/api/v1/health` | 2        |
| `realtime`      | `realtime.json`        | `docker/Dockerfile`, `KAXOLAX_SERVICE=realtime`         | 1234 | `/health`        | 2 (\*)   |
| `backup`        | `pg-backup.json`       | `scripts/backup/Dockerfile` (cron 03:17 UTC)            | —    | —                | —        |
| `restore-test`  | `pg-restore-test.json` | `scripts/backup/Dockerfile` (cron le lundi, facultatif) | —    | —                | —        |

(\*) Plusieurs instances exigent `REDIS_URL` (extension Redis de Hocuspocus et bus entre
instances, `apps/realtime/src/cluster.ts`) : sans lui, deux clients d'un même document sur deux
instances ne se voient pas, et les événements de projet (`REALTIME_INTERNAL_URL`, résultat des
compilations compris) n'atteignent que l'instance appelée.

- **Étape finale du Dockerfile** : Railway ne choisit pas de cible (`--target`). La dernière étape
  de `docker/Dockerfile` reprend celle que désigne l'argument de build `KAXOLAX_SERVICE` ; une
  variable de service du même nom est transmise comme argument de build. Sans elle, le build
  échoue avec un message explicite (aucune valeur par défaut).
- **Construction** : pas de cache mount BuildKit (Railway n'accepte que des identifiants
  `s/<service-id>-…`, propres à chaque service) ; `pnpm install --frozen-lockfile` sur le
  lockfile et l'image Node épinglée par empreinte.
- **Port** : chaque service écoute sur `PORT` (tableau ci-dessus) ; le domaine personnalisé vise
  ce port. L'admin garde 3001, le port de son image et de `next dev`.
- **Migrations** : `preDeployCommand` de l'api (`node build/ace.js migration:run --force`), une
  fois par déploiement, avant le basculement du trafic. Un échec annule le déploiement.
- **Réseau privé** : les services s'appellent par `<service>.railway.internal` ; `HOST=::` (ou
  `HOSTNAME=::` pour Next.js) pour écouter en IPv4 et IPv6.

## Variables par service

Références Railway entre accolades doubles (`${{Postgres.PGHOST}}`). Secrets : générés une fois
(`openssl rand -base64 48`) ou fournis par Clerk, Cloudflare, le fournisseur SMTP ; jamais dans
le dépôt.

### api

Variables lues par `apps/api/start/env.ts`. `kaxolax-infra/railway/provision.sh` pose toutes
celles qui ne sont pas marquées « facultative » (sorties Terraform comprises), avec les secrets
Clerk et SMTP fournis par l'opérateur.

| Variable                                                                  | Valeur                                                                                                                 |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `KAXOLAX_SERVICE`                                                         | `api` (argument de build)                                                                                              |
| `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`                                   | `production`, `::`, `3333`, `info`                                                                                     |
| `APP_KEY`                                                                 | secret généré                                                                                                          |
| `APP_URL`                                                                 | `https://app.<domaine>` (claim `azp` des jetons Clerk, liens des emails)                                               |
| `ADMIN_URL`                                                               | `https://admin.<domaine>` (origine de l'admin, acceptée dans le claim `azp` : sans elle, l'admin reçoit 401)           |
| `TRUSTED_PROXY_HOPS`                                                      | `2` (‡)                                                                                                                |
| `CLERK_JWT_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`       | instance Clerk de production                                                                                           |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`             | `${{Postgres.PGHOST}}`, `${{Postgres.PGPORT}}`… ; `DB_SSL=false` (réseau privé)                                        |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USERNAME`, `SMTP_PASSWORD` | fournisseur SMTP ; `SMTP_PORT=465` **et** `SMTP_SECURE=true` (TLS implicite : sans lui, les envois restent bloqués)    |
| `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`                                     | `no-reply@<domaine>`, `Kaxolax`                                                                                        |
| `REALTIME_TOKEN_SECRET`, `INTERNAL_TOKEN`                                 | secrets générés (partagés avec realtime)                                                                               |
| `REALTIME_PUBLIC_URL`                                                     | `wss://realtime.<domaine>`                                                                                             |
| `REALTIME_INTERNAL_URL`                                                   | `http://${{realtime.RAILWAY_PRIVATE_DOMAIN}}:1234`                                                                     |
| `S3_REGION`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`                          | `auto`, `https://<compte>.eu.r2.cloudflarestorage.com` (les deux)                                                      |
| `S3_FORCE_PATH_STYLE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`         | `true`, jeton R2 `app` (sorties Terraform de kaxolax-infra)                                                            |
| `S3_BUCKET_PROJECT_FILES`, `S3_BUCKET_COMPILE_OUTPUTS`                    | `kaxolax-project-files`, `kaxolax-compile-outputs`                                                                     |
| `COMPILE_BACKEND`                                                         | `cloudflare`                                                                                                           |
| `COMPILE_WORKER_URL`, `COMPILE_WORKER_SECRET`                             | `https://compile.<domaine>`, secret généré (même valeur dans le Worker)                                                |
| `TEMPLATES_CATALOG_URL`                                                   | `https://templates.<domaine>/templates.json` (racine du bucket public `kaxolax-templates`) ; sans elle, galerie en 503 |
| `TEMPLATES_PUBLIC_URL`                                                    | `https://templates.<domaine>` (base des PDF, miniatures et zip ; défaut : dossier du catalogue)                        |
| `TEXLIVE_INDEX_BUCKET`, `TEXLIVE_INDEX_KEY`                               | `kaxolax-texlive-index`, `texlive/2026/packages.json` (§)                                                              |
| `HISTORY_SWEEP_SECONDS`                                                   | facultative : balayage des versions automatiques, en secondes (défaut 30 ; 0 désactive), dans chaque réplica           |
| `HISTORY_RETRY_SECONDS`                                                   | facultative : délai avant un nouvel essai de version automatique en échec (défaut 600)                                 |
| `HISTORY_PURGE_SECONDS`                                                   | facultative : purge des versions expirées selon le plan, en secondes (défaut 3600 ; 0 désactive)                       |

`COMPILE_GATEWAY_URL` n'est pas posée en production (mode `gateway` seulement). L'API n'utilise
pas Redis : pas de `REDIS_URL` (le script signale une ancienne valeur restée en place).

(‡) Intermédiaires de confiance comptés depuis l'API, le pair de la connexion compris, pour
`X-Forwarded-For`, `-Proto` et `-Host` : le proxy de Railway (ou, pour `/api` servi par
`app.<domaine>`, le serveur Next.js, qui relaie sans ajouter d'adresse), puis Cloudflare. Cela
suppose que le proxy de Railway ajoute l'adresse de Cloudflare à `X-Forwarded-For`, ce qui reste
à vérifier au premier déploiement. **Ces valeurs restent forgeables** : Railway ne réserve pas
l'origine à Cloudflare, qui ne s'y authentifie pas. Une connexion directe à l'edge de Railway
(`curl --resolve api.<domaine>:443:<IP de l'edge> -H 'X-Forwarded-For: 1.2.3.4' …`) donne
`request.ip()` = `1.2.3.4`, accepte `X-Forwarded-Proto` et `-Host` tels quels, et échappe au WAF
et à la limitation de débit de Cloudflare. L'API ne fonde aujourd'hui aucune règle sur l'IP. Une
règle qui devrait s'y fier (ou sur Cloudflare) exige d'abord d'authentifier l'origine : en-tête
secret ajouté par une Transform Rule de Cloudflare (Terraform de kaxolax-infra), vérifié par un
middleware de l'API, puis lecture de `CF-Connecting-IP` seulement.

(§) Index des packages TeX Live, publié par la CI de kaxolax-texlive-images sous le préfixe
`texlive/` du bucket **privé** `kaxolax-texlive-index` (jeton `texlive_publish`, qui n'a plus
accès à la galerie) ; l'API le lit par l'API S3 avec le jeton `app`, en lecture seule sur ce
bucket (sortie Terraform `texlive_index`). Sans `TEXLIVE_INDEX_BUCKET`, les
routes `/texlive/*` répondent 503 en production.

### realtime

Variables lues par `apps/realtime/src/config.ts`.

| Variable                                     | Valeur                                                                                                                                     |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `KAXOLAX_SERVICE`                            | `realtime` (argument de build)                                                                                                             |
| `HOST`, `PORT`, `LOG_LEVEL`                  | `::`, `1234`, `info`                                                                                                                       |
| `DATABASE_URL`, `DB_SSL`                     | `${{Postgres.DATABASE_URL}}`, `false`                                                                                                      |
| `REALTIME_TOKEN_SECRET`, `INTERNAL_TOKEN`    | `${{api.REALTIME_TOKEN_SECRET}}`, `${{api.INTERNAL_TOKEN}}`                                                                                |
| `REDIS_URL`                                  | `${{Redis.REDIS_URL}}` (obligatoire à 2 réplicas)                                                                                          |
| `REDIS_PREFIX`                               | facultative : préfixe des clés et canaux Redis (défaut `kaxolax-realtime` ; un par environnement sur un même Redis)                        |
| `STORE_DEBOUNCE_MS`, `STORE_MAX_DEBOUNCE_MS` | facultatives : écriture d'un document en base après 2 s sans modification, au plus tard 10 s après la première                             |
| `ROLE_RECHECK_MS`, `ROLE_SWEEP_MS`           | facultatives : rôle relu à la mise à jour d'un rédacteur au-delà de 5 s ; relecture de toutes les connexions toutes les 30 s (0 désactive) |
| `HISTORY_FLUSH_MS`                           | facultative : délai maximal d'écriture du journal des mises à jour (auteurs), 100 ms                                                       |
| `STORAGE_CHECK_MS`                           | facultative : durée de réutilisation de l'état du stockage du propriétaire (limite du plan), 10 s                                          |

### web et admin

Variables lues par `apps/{web,admin}/src/env.ts`, plus celles du serveur Next.js autonome.

| Variable                                                     | Valeur                                            |
| ------------------------------------------------------------ | ------------------------------------------------- |
| `KAXOLAX_SERVICE`                                            | `web` ou `admin` (argument de build)              |
| `NODE_ENV`, `HOSTNAME`                                       | `production`, `::`                                |
| `PORT`                                                       | `3000` (web), `3001` (admin)                      |
| `API_INTERNAL_URL`                                           | `http://${{api.RAILWAY_PRIVATE_DOMAIN}}:3333` (†) |
| `CLERK_PUBLISHABLE_KEY`, `CLERK_SECRET_KEY`, `CLERK_JWT_KEY` | instance Clerk de production (lues à l'exécution) |

(†) Valeur **de build** : `next build` fige la cible des réécritures `/api/*` dans
`routes-manifest.json`. Le Dockerfile la déclare en `ARG` de l'étape `builder`, et Railway
transmet la variable de service comme argument de build. La changer exige un nouveau build (un
simple redémarrage garde l'ancienne cible).

### backup et restore-test

| Variable                                                                     | Valeur                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                                                               | `${{Postgres.DATABASE_URL}}` (backup seulement)                                                                                                             |
| `AGE_RECIPIENT`                                                              | clé publique age (`age1…`) ; la clé privée n'est dans Railway que si le service facultatif `restore-test` est créé                                          |
| `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`                                     | endpoint R2 (UE), `auto`                                                                                                                                    |
| `BACKUP_S3_BUCKET`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | `kaxolax-backups` ; jeton R2 `backup` pour backup, jeton `backup_read` (lecture seule, sortie Terraform `railway_variables.restore_test`) pour restore-test |
| `BACKUP_PREFIX`, `BACKUP_RETENTION_DAYS`, `BACKUP_MIN_KEEP`                  | `postgres`, `35`, `7`                                                                                                                                       |
| `RESTORE_ADMIN_URL`, `AGE_IDENTITY`                                          | restore-test seulement : serveur PostgreSQL **de test**, clé privée                                                                                         |

Le service `restore-test` est facultatif : il a besoin d'un PostgreSQL distinct de la production
et de la clé privée age dans Railway. Il ne reçoit jamais le jeton `backup` (écriture et
suppression) : une compromission donnerait à la fois le déchiffrement et l'effacement des
sauvegardes. Sinon, lancer le test depuis un poste d'opérateur
(`docs/deploy.md`, « Sauvegardes »).
