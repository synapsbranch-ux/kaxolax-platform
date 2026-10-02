# Déploiement en production : Railway + Cloudflare

Guide pas à pas. Rien n'est déployé automatiquement : chaque étape est lancée par l'opérateur.
L'infrastructure as code (zone Cloudflare, DNS, WAF, buckets et jetons R2, provisionnement du
projet Railway) vit dans **kaxolax-infra** ; sa procédure détaillée, commande par commande, est
`kaxolax-infra/docs/procedure.md`. Ce document décrit l'ensemble, côté plateforme.

## Vue d'ensemble

```
            Cloudflare (DNS, CDN, WAF, TLS)
  app.<domaine>   admin.<domaine>   api.<domaine>   realtime.<domaine>     compile.<domaine>
       │               │                 │                 │                     │
       ▼               ▼                 ▼                 ▼                     ▼
  ┌──────────────── Railway (réseau privé *.railway.internal) ──────────┐  Worker + Durable
  │ web (Next.js)  admin (Next.js)  api (AdonisJS) ──▶ realtime         │  Objects + Containers
  │                                   │  ▲             (Hocuspocus)     │  (une VM par projet)
  │ PostgreSQL ◀──────────────────────┘  │                Redis         │        │
  │ backup (cron) ──▶ R2 kaxolax-backups │ rappels signés (HMAC)        │◀───────┘
  └──────────────────────────────────────┼──────────────────────────────┘
                                          R2 : kaxolax-project-files, kaxolax-compile-outputs
```

- **Railway** : web, admin, api, realtime, PostgreSQL, Redis, job cron `backup`.
- **Cloudflare** : DNS, CDN, WAF, R2 (à la place de S3, même SDK), Worker de compilation
  (`apps/compile-worker`) avec Cloudflare Containers.
- **Compilation asynchrone** (`COMPILE_BACKEND=cloudflare`) : l'API répond 202 avec un
  `buildId`, le Worker compile dans le conteneur du projet et rappelle l'API, le service temps réel
  pousse le résultat au navigateur. Voir `docs/decisions.md`.

## 1. Comptes et outils

| Compte                          | Usage                                                                   |
| ------------------------------- | ----------------------------------------------------------------------- |
| Cloudflare, **Workers Paid**    | Zone, R2, Worker ; Containers et Durable Objects exigent le plan payant |
| Railway, plan **Pro** conseillé | Services, réplicas, IP de sortie statiques (restriction des jetons R2)  |
| Clerk, instance de production   | Comptes, sessions, Billing                                              |
| Fournisseur SMTP (SES ou autre) | Emails d'invitation et de mention                                       |
| GitHub                          | Application Railway installée sur kaxolax-platform                      |

Outils : Terraform 1.16.4, CLI Railway, `jq`, `openssl`, `docker`, `age` ; `wrangler` est une
dépendance de `apps/compile-worker` (`pnpm --filter @kaxolax/compile-worker exec wrangler …`).

## 2. Secrets

Aucun secret dans un dépôt. Les générer une fois et les garder dans le gestionnaire de mots de
passe de l'équipe.

| Secret                                    | Création                           | Où                                   |
| ----------------------------------------- | ---------------------------------- | ------------------------------------ |
| `APP_KEY`                                 | `openssl rand -base64 48`          | api                                  |
| `REALTIME_TOKEN_SECRET`, `INTERNAL_TOKEN` | `openssl rand -base64 48`          | api, realtime                        |
| `COMPILE_WORKER_SECRET` (≥ 32 caractères) | `openssl rand -base64 48`          | api, Worker (`wrangler secret put`)  |
| `CLERK_*`                                 | Dashboard Clerk (production)       | api, web, admin                      |
| `SMTP_*`                                  | fournisseur SMTP                   | api                                  |
| Jetons R2 `app`, `backup`                 | Terraform (`kaxolax-infra`)        | api ; backup                         |
| Clé age des sauvegardes                   | `age-keygen -o kaxolax-backup.key` | clé **publique** seule dans `backup` |

`kaxolax-infra/railway/provision.sh` génère `APP_KEY`, `REALTIME_TOKEN_SECRET`,
`INTERNAL_TOKEN` et `COMPILE_WORKER_SECRET` s'ils manquent et ne les remplace jamais.

## 3. Cloudflare : zone, DNS, WAF, R2

Avec Terraform (`kaxolax-infra/cloudflare`, procédure §1 et §2) :

- **Zone et DNS** : serveurs de noms chez le registraire, DNSSEC. CNAME proxyfiés vers Railway
  pour `app`, `admin`, `api`, `realtime` (cibles données par Railway à l'étape 5). TLS `strict`
  une fois les certificats de Railway émis.
- **WAF** : `/internal/*` bloqué depuis Internet (routes internes du service temps réel, réservées
  au réseau privé de Railway), limitation de débit sur `/api/*` hors webhooks et rappels du
  Worker (`/api/v1/internal/compile-callbacks`, protégés par HMAC). WebSocket autorisé sur
  `realtime`.
- **R2** (juridiction UE) : `kaxolax-project-files`, `kaxolax-compile-outputs`,
  `kaxolax-templates` (public en lecture sur `templates.<domaine>`), `kaxolax-backups` (privé,
  verrou 7 jours, expiration à 45 jours en filet de sécurité de la rétention du job). CORS : `app.<domaine>` pour les URL présignées.
- **Jetons R2** au moindre privilège : `app` (fichiers et sorties), `backup`, `templates_publish`.

### Client S3 sur R2

L'API (et l'agent de l'étape 1) utilisent le SDK S3 existant ; variables pour R2 :

| Variable                                   | Valeur                                                 |
| ------------------------------------------ | ------------------------------------------------------ |
| `S3_REGION`                                | `auto`                                                 |
| `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`        | `https://<compte>.eu.r2.cloudflarestorage.com`         |
| `S3_FORCE_PATH_STYLE`                      | `true`                                                 |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | jeton R2 `app` (sorties Terraform `railway_variables`) |

Le code n'envoie ni ACL, ni chiffrement SSE, ni classe de stockage (non pris en charge par R2) ;
les checksums ne sont calculés que lorsqu'ils sont exigés (`WHEN_REQUIRED`). Test :
`apps/api/tests/unit/object_storage.spec.ts`.

## 4. Worker et conteneurs de compilation

Depuis la racine de kaxolax-platform :

1. `apps/compile-worker/wrangler.jsonc` : remplacer `kaxolax.com` par le domaine (route
   `compile.<domaine>`, `API_CALLBACK_URL`), vérifier les noms de buckets (sortie Terraform
   `r2_buckets`). wrangler crée l'enregistrement DNS du domaine personnalisé.
2. Image TeX Live : `TEXLIVE_IMAGE` de `apps/compile-worker/container/Dockerfile` (variante
   `medium` aujourd'hui) ; l'épingler par empreinte (`…@sha256:`) avant la mise en production.
3. Jeton de déploiement Cloudflare **personnalisé, au moindre privilège** (pas le modèle « Edit
   Cloudflare Workers », qui donne aussi la gestion des buckets R2 et de KV sur tout le compte :
   un jeton volé pourrait retirer le verrou de `kaxolax-backups` puis tout effacer). Limité au
   compte et à la zone : compte → Workers Scripts : Edit, Containers : Edit (et Account
   Settings : Read si wrangler le demande) ; zone → Workers Routes : Edit. Ni « Workers R2
   Storage », ni KV : déclarer un binding R2 n'exige pas de gérer les buckets, dont la création,
   le verrou et le cycle de vie restent à Terraform (son propre jeton). Dans
   `CLOUDFLARE_API_TOKEN` et `CLOUDFLARE_ACCOUNT_ID`.
4. Secret partagé (même valeur que `COMPILE_WORKER_SECRET` de l'api) :

   ```bash
   pnpm --filter @kaxolax/compile-worker exec wrangler secret put COMPILE_WORKER_SECRET
   ```

5. Déploiement (construit et pousse l'image linux/amd64 du conteneur, puis le Worker) :

   ```bash
   pnpm --filter @kaxolax/compile-worker build    # vérification à blanc
   pnpm --filter @kaxolax/compile-worker deploy
   ```

6. Vérifier `https://compile.<domaine>/health` → `{"status":"ok"}`.

Réglages : `instance_type` (`standard-4` : disque suffisant pour TeX Live complet),
`max_instances` (plafond de conteneurs simultanés, donc de coût), `sleepAfter` (15 min,
`src/container.ts`).

## 5. Railway : services

Avec `kaxolax-infra/railway/provision.sh` (procédure §4), ou à la main :

1. Projet Railway, bases **PostgreSQL** et **Redis** (modèles Railway).
2. Un service par application, depuis le dépôt kaxolax-platform, chacun avec son fichier de
   configuration (Settings → Config-as-code) :

   | Service        | Fichier                                | `KAXOLAX_SERVICE` | Domaine public       |
   | -------------- | -------------------------------------- | ----------------- | -------------------- |
   | `web`          | `/deploy/railway/web.json`             | `web`             | `app.<domaine>`      |
   | `admin`        | à ajouter avec apps/admin              | `admin`           | `admin.<domaine>`    |
   | `api`          | `/deploy/railway/api.json`             | `api`             | `api.<domaine>`      |
   | `realtime`     | `/deploy/railway/realtime.json`        | `realtime`        | `realtime.<domaine>` |
   | `backup`       | `/deploy/railway/pg-backup.json`       | —                 | aucun                |
   | `restore-test` | `/deploy/railway/pg-restore-test.json` | —                 | aucun (facultatif)   |

   Image : `docker/Dockerfile`, étape finale choisie par l'argument de build `KAXOLAX_SERVICE`
   (variable du service). Healthchecks, migrations au déploiement (`preDeployCommand` de l'api :
   `node build/ace.js migration:run --force`) et réplicas sont dans les fichiers.

3. Variables : tableaux par service dans `deploy/railway/README.md`. Points clés : api en
   `COMPILE_BACKEND=cloudflare` avec `COMPILE_WORKER_URL=https://compile.<domaine>` ;
   `REALTIME_INTERNAL_URL` sur le réseau privé ; `TRUSTED_PROXY_HOPS=2`. `API_INTERNAL_URL` du
   web est lue **au build** (réécritures `/api/*` figées par `next build`, `ARG` de l'étape
   `builder` du Dockerfile) : la changer exige un nouveau build.
4. Domaines personnalisés de chaque service, puis cibles CNAME reportées dans Cloudflare
   (`railway_targets` de Terraform) ; attendre les certificats, puis TLS `strict`.
5. Clerk : domaine de production, URL du webhook `https://api.<domaine>/api/v1/webhooks/clerk`.

Réplicas de realtime : 1 dans `realtime.json` tant que l'extension Redis de Hocuspocus (tâche 5)
n'existe pas : sans elle, deux clients d'un même document sur deux instances ne se voient pas, et
un événement de compilation n'atteint que les connexions de l'instance appelée. Passer à 2 avec
la tâche 5.

## 6. Sauvegardes PostgreSQL

- Job `backup` (cron 03:17 UTC) : `scripts/backup/pg-backup.sh` — `pg_dump` compressé sur un
  instantané, vérifié, chiffré avec age, manifeste (sha256, nombres de lignes des tables clés),
  envoi dans `kaxolax-backups/postgres/<horodatage>/`, rétention 35 jours (au moins 7 gardées).
- Variables : `DATABASE_URL`, `AGE_RECIPIENT` (clé publique), `BACKUP_S3_*` (jeton R2 `backup`).
- Premier passage : « Run now » dans Railway, puis contrôle du journal (« sauvegarde envoyée »).
- **Test de restauration** chaque mois et après tout changement de version de PostgreSQL :
  `scripts/backup/pg-restore-test.sh` dans un PostgreSQL jetable, avec la clé privée (commande
  complète : `kaxolax-infra/docs/procedure.md` §6). Il restaure dans une base temporaire et
  exige l'égalité exacte des nombres de lignes avec le manifeste ; échec si la sauvegarde a plus
  de 26 h. Il lit avec le jeton R2 `backup_read` (lecture seule, sortie Terraform
  `railway_variables.restore_test`), jamais avec le jeton `backup` : il détient la clé privée.
- Test local de bout en bout (CI, job `backup`) : `scripts/backup/test-local.sh`.

## 7. Vérifications après déploiement

1. `https://api.<domaine>/api/v1/health`, `https://compile.<domaine>/health`.
2. Connexion, création d'un projet, `POST /api/v1/projects/:id/compiler/warm` (appelé par
   l'éditeur à son ouverture une fois l'interface adaptée ; journal du Worker : réveil du
   conteneur).
3. Compilation : 202 puis états `preparing`/`running`/`success` (événement temps réel, ou
   `GET /api/v1/projects/:id/builds/:buildId`), PDF servi depuis R2.
4. Deux compilations rapprochées : la seconde reçoit 409 `E_COMPILE_IN_PROGRESS`.
5. Journal du job `backup` le lendemain, puis un test de restauration.

**Limite actuelle** : l'interface web (apps/web) attend encore la réponse synchrone de
l'étape 1 ; son passage à la compilation asynchrone (`buildId`, événement `compile`, appel de
`compiler/warm`) se fait après la nouvelle interface (tâche 3). D'ici là, la production ne peut
pas basculer en `COMPILE_BACKEND=cloudflare` pour les utilisateurs du web.

Retour arrière de la compilation : `COMPILE_BACKEND=gateway` exige un compile-gateway et des
agents Docker (étape 1) qui ne sont pas déployés sur Railway ; en production, corriger plutôt le
Worker (`wrangler rollback`).

## 8. Coûts estimés

Ordres de grandeur (grilles publiques de septembre 2026, non revérifiées depuis l'environnement
de développement ; détail : `kaxolax-infra/docs/couts.md`). Dollars US par mois, hors taxes.

| Poste                                     | Mois                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------ |
| Railway Pro (services, PostgreSQL, Redis) | ~25 à 30 $                                                                     |
| Cloudflare Workers Paid                   | 5 $                                                                            |
| Conteneurs de compilation (`standard-4`)  | ~0,11 $ par heure éveillée : ~65 $ (20 projets actifs 1 h/jour) à ~325 $ (100) |
| R2 (50 Go, sortie gratuite)               | ~1 $                                                                           |
| Zone Cloudflare                           | 0 $ (Free) ou ~20 $ (Pro)                                                      |
| **Total au lancement**                    | **~95 à 385 $**                                                                |

Le poste qui monte avec l'activité est le temps d'éveil des conteneurs : `sleepAfter`,
`instance_type` et `max_instances` sont les réglages à surveiller.
