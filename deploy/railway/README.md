# Railway : configuration des services

Un fichier « config as code » par service Railway. Railway ne lit que `/railway.json` par
défaut : dans chaque service, **Settings → Config-as-code → Railway Config File**, déclarer le
chemin absolu du fichier (`/deploy/railway/api.json`…). La configuration du fichier prime sur
celle du tableau de bord. `kaxolax-infra/railway/provision.sh` pose les mêmes valeurs par la CLI.

| Service Railway | Fichier                                                                         | Image                                                   | Healthcheck      | Réplicas |
| --------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------- | -------- |
| `web`           | `web.json`                                                                      | `docker/Dockerfile`, `KAXOLAX_SERVICE=web`              | `/healthz`       | 2        |
| `admin`         | `admin.json`                                                                    | `docker/Dockerfile`, `KAXOLAX_SERVICE=admin`            | `/healthz`       | 1        |
| `api`           | `api.json`                                                                      | `docker/Dockerfile`, `KAXOLAX_SERVICE=api`              | `/api/v1/health` | 2        |
| `realtime`      | `realtime.json`                                                                 | `docker/Dockerfile`, `KAXOLAX_SERVICE=realtime`         | `/health`        | 1 (\*)   |
| `admin`         | à créer avec la tâche 13 (`KAXOLAX_SERVICE=admin`, cible `admin` du Dockerfile) |                                                         |                  | 1        |
| `backup`        | `pg-backup.json`                                                                | `scripts/backup/Dockerfile` (cron 03:17 UTC)            | —                | —        |
| `restore-test`  | `pg-restore-test.json`                                                          | `scripts/backup/Dockerfile` (cron le lundi, facultatif) | —                | —        |

(\*) Une seule instance tant que l'extension Redis de Hocuspocus (tâche 5) n'existe pas : sans
elle, deux clients d'un même document sur deux instances ne se voient pas, et les événements de
projet (`REALTIME_INTERNAL_URL`, résultat des compilations) n'atteignent qu'une instance. Passer
`numReplicas` à 2 dans `realtime.json` avec la tâche 5.

- **Étape finale du Dockerfile** : Railway ne choisit pas de cible (`--target`). La dernière étape
  de `docker/Dockerfile` reprend celle que désigne l'argument de build `KAXOLAX_SERVICE` ; une
  variable de service du même nom est transmise comme argument de build.
- **Migrations** : `preDeployCommand` de l'api (`node build/ace.js migration:run --force`), une
  fois par déploiement, avant le basculement du trafic. Un échec annule le déploiement.
- **Réseau privé** : les services s'appellent par `<service>.railway.internal` ; `HOST=::` pour
  écouter en IPv4 et IPv6.

## Variables par service

Références Railway entre accolades doubles (`${{Postgres.PGHOST}}`). Secrets : générés une fois
(`openssl rand -base64 48`) ou fournis par Clerk, Cloudflare, le fournisseur SMTP ; jamais dans
le dépôt.

### api

| Variable                                                                  | Valeur                                                                   |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `KAXOLAX_SERVICE`                                                         | `api`                                                                    |
| `NODE_ENV`, `HOST`, `PORT`, `LOG_LEVEL`                                   | `production`, `::`, `3333`, `info`                                       |
| `APP_KEY`                                                                 | secret généré                                                            |
| `APP_URL`                                                                 | `https://app.<domaine>` (claim `azp` des jetons Clerk)                   |
| `TRUSTED_PROXY_HOPS`                                                      | `2` (Cloudflare puis le proxy de Railway)                                |
| `CLERK_JWT_KEY`, `CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`       | instance Clerk de production                                             |
| `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_DATABASE`             | `${{Postgres.PGHOST}}`, `${{Postgres.PGPORT}}`… ; `DB_SSL=false` (privé) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USERNAME`, `SMTP_PASSWORD` | fournisseur SMTP                                                         |
| `MAIL_FROM_ADDRESS`, `MAIL_FROM_NAME`                                     | `no-reply@<domaine>`, `Kaxolax`                                          |
| `REALTIME_TOKEN_SECRET`, `INTERNAL_TOKEN`                                 | secrets générés (partagés avec realtime)                                 |
| `REALTIME_PUBLIC_URL`                                                     | `wss://realtime.<domaine>`                                               |
| `REALTIME_INTERNAL_URL`                                                   | `http://${{realtime.RAILWAY_PRIVATE_DOMAIN}}:1234`                       |
| `S3_REGION`, `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`                          | `auto`, `https://<compte>.eu.r2.cloudflarestorage.com` (les deux)        |
| `S3_FORCE_PATH_STYLE`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`         | `true`, jeton R2 `app` (sorties Terraform de kaxolax-infra)              |
| `S3_BUCKET_PROJECT_FILES`, `S3_BUCKET_COMPILE_OUTPUTS`                    | `kaxolax-project-files`, `kaxolax-compile-outputs`                       |
| `COMPILE_BACKEND`                                                         | `cloudflare`                                                             |
| `COMPILE_WORKER_URL`, `COMPILE_WORKER_SECRET`                             | `https://compile.<domaine>`, secret généré (même valeur dans le Worker)  |

`COMPILE_GATEWAY_URL` n'est pas posée en production (mode `gateway` seulement).

### realtime

| Variable                                  | Valeur                                                      |
| ----------------------------------------- | ----------------------------------------------------------- |
| `KAXOLAX_SERVICE`                         | `realtime`                                                  |
| `HOST`, `PORT`, `LOG_LEVEL`               | `::`, `1234`, `info`                                        |
| `DATABASE_URL`, `DB_SSL`                  | `${{Postgres.DATABASE_URL}}`, `false`                       |
| `REALTIME_TOKEN_SECRET`, `INTERNAL_TOKEN` | `${{api.REALTIME_TOKEN_SECRET}}`, `${{api.INTERNAL_TOKEN}}` |
| `REDIS_URL`                               | `${{Redis.REDIS_URL}}` (extension Redis, tâche 5)           |

### web (et admin)

| Variable                                                     | Valeur                                            |
| ------------------------------------------------------------ | ------------------------------------------------- |
| `KAXOLAX_SERVICE`                                            | `web` (ou `admin`)                                |
| `HOSTNAME`, `PORT`                                           | `::`, `3000`                                      |
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
