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

| Compte                                          | Usage                                                                   |
| ----------------------------------------------- | ----------------------------------------------------------------------- |
| Cloudflare, **Workers Paid**                    | Zone, R2, Worker ; Containers et Durable Objects exigent le plan payant |
| Railway, plan **Pro** conseillé                 | Services, réplicas, IP de sortie statiques (restriction des jetons R2)  |
| Clerk, instance de production                   | Comptes, sessions, Billing                                              |
| Fournisseur SMTP (port 465, `SMTP_SECURE=true`) | Emails d'invitation et de mention                                       |
| GitHub                                          | Application Railway installée sur kaxolax-platform                      |

Outils : Terraform 1.16.4, CLI Railway, `jq`, `openssl`, `curl`, `docker`, `age` ; `wrangler` est
une dépendance de `apps/compile-worker` (`pnpm --filter @kaxolax/compile-worker exec wrangler …`).

## 2. Secrets

Aucun secret dans un dépôt. Les générer une fois et les garder dans le gestionnaire de mots de
passe de l'équipe.

| Secret                                             | Création                           | Où                                                     |
| -------------------------------------------------- | ---------------------------------- | ------------------------------------------------------ |
| `APP_KEY`                                          | `openssl rand -base64 48`          | api                                                    |
| `REALTIME_TOKEN_SECRET`, `INTERNAL_TOKEN`          | `openssl rand -base64 48`          | api, realtime                                          |
| `COMPILE_WORKER_SECRET` (≥ 32 caractères)          | `openssl rand -base64 48`          | api, Worker (`wrangler secret put`)                    |
| `CLERK_*`                                          | Dashboard Clerk (production)       | api, web, admin                                        |
| `SMTP_*`                                           | fournisseur SMTP                   | api                                                    |
| `ANTHROPIC_API_KEY` (facultative)                  | Console Anthropic, API keys        | api                                                    |
| `ZOTERO_CLIENT_KEY`, `ZOTERO_CLIENT_SECRET` (fac.) | zotero.org/oauth/apps (§2.1)       | api                                                    |
| Jetons R2 `app`, `backup`                          | Terraform (`kaxolax-infra`)        | api ; backup                                           |
| Jetons R2 `templates_publish`, `texlive_publish`   | Terraform (`kaxolax-infra`)        | CI de kaxolax-templates ; CI de kaxolax-texlive-images |
| Clé age des sauvegardes                            | `age-keygen -o kaxolax-backup.key` | clé **publique** seule dans `backup`                   |

`kaxolax-infra/railway/provision.sh` génère `APP_KEY`, `REALTIME_TOKEN_SECRET`,
`INTERNAL_TOKEN` et `COMPILE_WORKER_SECRET` s'ils manquent et ne les remplace jamais.
Sans `ANTHROPIC_API_KEY`, l'IA est désactivée : toute route d'IA répond 503 `E_AI_UNAVAILABLE`.
Sans `ZOTERO_CLIENT_KEY` et `ZOTERO_CLIENT_SECRET`, l'intégration Zotero est désactivée : ses
routes répondent 503 `E_ZOTERO_UNAVAILABLE`, l'interface l'indique, le reste fonctionne.

### 2.1 Application OAuth Zotero

Une application par environnement (production, préproduction, développement local), créée avec
le compte Zotero de l'équipe :

1. Se connecter sur zotero.org, puis ouvrir https://www.zotero.org/oauth/apps → « Register a new
   application ».
2. Nom « Kaxolax » (affiché à l'utilisateur sur la page d'autorisation), type « Browser »,
   site `https://app.<domaine>`, **URL de rappel `https://app.<domaine>/integrations/zotero/callback`**
   (`APP_URL` de l'api suivie de `/integrations/zotero/callback` ; en local
   `http://localhost:3000/integrations/zotero/callback`).
3. Recopier la « Client Key » dans `ZOTERO_CLIENT_KEY` et le « Client Secret » dans
   `ZOTERO_CLIENT_SECRET` (secret) de l'api, puis redéployer l'api.
4. Vérifier : Compte → Intégrations → « Connecter Zotero » mène à zotero.org, qui demande un accès
   en lecture seule (bibliothèque sans les notes, groupes en lecture, aucune écriture), puis
   revient sur Kaxolax « Connecté en tant que … ».

Le secret ne quitte jamais l'api. Les clés d'API des utilisateurs sont chiffrées en base avec
`APP_KEY` (changer `APP_KEY` sans garder l'ancienne clé les rend illisibles : les utilisateurs
reconnectent Zotero). Changer la clé et le secret de l'application n'invalide pas les clés déjà
émises ; les révoquer se fait par utilisateur (déconnexion dans Kaxolax, ou zotero.org/settings/keys).

## 3. Cloudflare : zone, DNS, WAF, R2

Avec Terraform (`kaxolax-infra/cloudflare`, procédure §1 et §2) :

- **Zone et DNS** : serveurs de noms chez le registraire, DNSSEC. CNAME proxyfiés vers Railway
  pour `app`, `admin`, `api`, `realtime` (cibles données par Railway à l'étape 5). TLS `strict`
  une fois les certificats de Railway émis.
- **WAF** : `/internal/*` bloqué depuis Internet. Le service temps réel sert ces routes sur son
  port public (`realtime.<domaine>`) : elles sont protégées par cette règle WAF puis, sans
  `X-Internal-Token` valide, refusées en 401 ; l'API les appelle par le réseau privé de Railway
  (`REALTIME_INTERNAL_URL`). Limitation de débit sur `/api/*` hors webhooks et rappels du
  Worker (`/api/v1/internal/compile-callbacks`, protégés par HMAC). WebSocket autorisé sur
  `realtime`. Railway ne réserve pas l'origine à Cloudflare : une connexion directe à son edge
  échappe au WAF et à la limitation de débit, et fait accepter des `X-Forwarded-*` choisis
  (voir `deploy/railway/README.md`, note ‡). Chaque route sensible a donc sa propre protection
  (jetons Clerk, `X-Internal-Token`, HMAC) et aucune règle ne repose sur l'IP du client.
- **R2** (juridiction UE) : `kaxolax-project-files` (téléversements en attente `uploads/`
  expirés à 1 jour), `kaxolax-compile-outputs` (expiration à 7 jours : les sorties contiennent
  les sources et les PDF), `kaxolax-templates` (public en lecture sur `templates.<domaine>` :
  galerie), `kaxolax-texlive-index` (privé : index des packages TeX Live sous `texlive/`, lu par
  l'API), `kaxolax-backups` (privé,
  verrou 7 jours, expiration à 45 jours en filet de sécurité de la rétention du job). CORS :
  `app.<domaine>` pour les URL présignées ; `app` et `admin` en lecture sur la galerie, avec
  l'en-tête `Range` et les en-têtes de plage exposés (aperçu PDF par pdf.js).
- **Jetons R2** au moindre privilège : `app` (écriture sur les fichiers et les sorties, lecture
  sur l'index TeX Live ; la galerie se lit par HTTPS), `backup`, `backup_read`,
  `templates_publish` (seul rédacteur de la galerie publique), `texlive_publish` (index seul).
  R2 ne limite pas un jeton à un préfixe, d'où un bucket par rédacteur : sur la galerie, le
  jeton de texlive-images pourrait réécrire le catalogue, les zip importés dans les projets (et
  leur sha256) et le contenu de `templates.<domaine>`.

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
   `medium`, décision C.6), seule référence, à épingler par son empreinte :
   `…/kaxolax-texlive:2026-medium@sha256:…` (`docker buildx imagetools inspect <image>`), et la
   même empreinte dans `texlive_digest` de `scripts/build.sh` de kaxolax-templates. Sans
   empreinte, la construction du conteneur par `wrangler deploy` échoue : `image_vars` de
   `wrangler.jsonc` passe `TEXLIVE_REQUIRE_PINNED=1` (à ne jamais retirer) ; la CI et le poste
   local construisent sans cet argument. Changer de variante par `--build-arg TEXLIVE_IMAGE=…` remplace toute la
   référence : l'empreinte suit.
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
   pnpm --filter @kaxolax/compile-worker run deploy
   ```

   `run` est indispensable : `pnpm deploy` seul est une commande intégrée de pnpm (copie d'un
   paquet du workspace), qui passe avant le script `deploy` du paquet et ne déploie rien.

6. Vérifier `https://compile.<domaine>/health` → `{"status":"ok"}`.

Réglages : `instance_type` (`standard-4` : disque suffisant pour l'image TeX Live),
`max_instances` (plafond de conteneurs simultanés, donc de coût), `sleepAfter` (15 min,
`src/container.ts`).

## 5. Railway : services

Avec `kaxolax-infra/railway/provision.sh` (procédure §4), ou à la main :

1. Projet Railway, bases **PostgreSQL** et **Redis** (modèles Railway).
2. Un service par application, depuis le dépôt kaxolax-platform, chacun avec son fichier de
   configuration (Settings → Config-as-code) :

   | Service        | Fichier                                | `KAXOLAX_SERVICE` | Port | Domaine public       |
   | -------------- | -------------------------------------- | ----------------- | ---- | -------------------- |
   | `web`          | `/deploy/railway/web.json`             | `web`             | 3000 | `app.<domaine>`      |
   | `admin`        | `/deploy/railway/admin.json`           | `admin`           | 3001 | `admin.<domaine>`    |
   | `api`          | `/deploy/railway/api.json`             | `api`             | 3333 | `api.<domaine>`      |
   | `realtime`     | `/deploy/railway/realtime.json`        | `realtime`        | 1234 | `realtime.<domaine>` |
   | `backup`       | `/deploy/railway/pg-backup.json`       | —                 | —    | aucun                |
   | `restore-test` | `/deploy/railway/pg-restore-test.json` | —                 | —    | aucun (facultatif)   |

   Image : `docker/Dockerfile`, étape finale choisie par l'argument de build `KAXOLAX_SERVICE`
   (variable du service, obligatoire : sans elle le build échoue). Healthchecks et leurs délais,
   `drainingSeconds`, `watchPatterns`, migrations au déploiement (`preDeployCommand` de l'api :
   `node build/ace.js migration:run --force`) et réplicas sont dans les fichiers ;
   `provision.sh` les lit (`PLATFORM_DIR`, copie de ce dépôt) au lieu de les recopier.

3. Variables : tableaux par service dans `deploy/railway/README.md`. Points clés : api en
   `COMPILE_BACKEND=cloudflare` avec `COMPILE_WORKER_URL=https://compile.<domaine>` ;
   `ADMIN_URL=https://admin.<domaine>` (sans elle, l'API refuse les jetons de l'admin) ;
   `TEMPLATES_CATALOG_URL`, `TEMPLATES_PUBLIC_URL`, `TEXLIVE_INDEX_BUCKET` et
   `TEXLIVE_INDEX_KEY` (sorties Terraform) ; `REALTIME_INTERNAL_URL` sur le réseau privé ;
   `TRUSTED_PROXY_HOPS=2` (IP et `X-Forwarded-*` restent forgeables : note ‡) ;
   `SMTP_PORT=465` avec `SMTP_SECURE=true` ; `ANTHROPIC_API_KEY` facultative (secret, api
   seulement) ; `ZOTERO_CLIENT_KEY` et `ZOTERO_CLIENT_SECRET` facultatives (§2.1, api seulement). Web : `REALTIME_PUBLIC_URL`, `S3_PUBLIC_ENDPOINT`, `TEMPLATES_PUBLIC_URL` et
   `TEMPLATES_CATALOG_URL`, mêmes valeurs que l'api, lues à l'exécution pour la CSP (absentes :
   lues sur `GET /api/v1/client-config`, avertissement au démarrage). Realtime : `REDIS_URL`
   obligatoire en production. `API_INTERNAL_URL` du web et de l'admin est lue **au build**
   (réécritures `/api/*` figées par `next build`, `ARG` de l'étape `builder` du Dockerfile) : la
   changer exige un nouveau build.
4. Domaines personnalisés de chaque service, puis cibles CNAME reportées dans Cloudflare
   (`railway_targets` de Terraform) ; attendre les certificats, puis TLS `strict`.
5. Clerk : domaine de production, URL du webhook `https://api.<domaine>/api/v1/webhooks/clerk`.

Réplicas de realtime : 2 dans `realtime.json`. `REDIS_URL` est obligatoire sur realtime en
production (refus de démarrer sans elle), et nécessaire à plusieurs instances (extension
Redis de Hocuspocus et bus entre instances, `apps/realtime/src/cluster.ts`) : sans elle, deux
clients d'un même document sur deux instances ne se voient pas, et un événement du projet
(compilation comprise) n'atteint que les connexions de l'instance appelée. L'API n'utilise pas
Redis.

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
   l'éditeur à son ouverture ; journal du Worker : réveil du conteneur).
3. Compilation : 202 puis états `preparing`/`running`/`success` (événement temps réel, ou
   `GET /api/v1/projects/:id/builds/:buildId`), PDF servi depuis R2.
4. Deux compilations rapprochées par l'API : la seconde reçoit 409 `E_COMPILE_IN_PROGRESS`.
5. Journal du job `backup` le lendemain, puis un test de restauration.
6. Admin : connexion sur `https://admin.<domaine>` (compte admin avec MFA), liste des
   utilisateurs (un 401 signale un `ADMIN_URL` absent ou faux).
7. Gestionnaire de packages de l'éditeur : la recherche d'un package (session ouverte,
   `GET /api/v1/texlive/packages?q=amsmath`) répond 200 (503 : index absent de `kaxolax-texlive-index`
   (`TEXLIVE_INDEX_BUCKET`/`TEXLIVE_INDEX_KEY`), ou jeton `app` sans lecture sur ce bucket (sortie
   Terraform `texlive_index`)).
8. Galerie : `https://app.<domaine>/templates` affiche les miniatures et l'aperçu PDF des
   templates (bucket R2 public de kaxolax-templates, `TEMPLATES_CATALOG_URL`), puis « Utiliser ce
   template » crée un projet qui compile.

L'interface web suit les deux modes : réponse synchrone (`gateway`), ou 202 `{ buildId, status }`
suivi par l'événement `compile.updated` du document meta, avec un sondage de repli de
`GET …/builds/:buildId` (`apps/web/src/lib/compile-controller.ts`) ; la pastille affiche
« Préparation du compilateur… » pendant le réveil du conteneur et « En attente… » dans la file,
l'éditeur appelle `compiler/warm` à son ouverture (au plus une fois par période), et un second
clic pendant une compilation la laisse finir puis relance (pas de 409 visible).

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
