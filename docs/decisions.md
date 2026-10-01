# Décisions

Chaque décision non triviale : contexte, décision, alternatives écartées (cinq lignes au maximum).

## 2026-09-30 · SeaweedFS remplace MinIO en local

- Contexte : MinIO ne publie plus d'images, son code est archivé et `minio/minio` renvoie 404 sur Docker Hub depuis septembre 2026.
- Décision : SeaweedFS 4.48 (Apache-2.0), testé pour les buckets, CORS, lifecycle et PUT présigné. Les clients S3 locaux utilisent `forcePathStyle: true` et `requestChecksumCalculation: 'WHEN_REQUIRED'`, car SeaweedFS rejette le checksum que le SDK v3 ajoute par défaut aux URL présignées.
- Écartées : Garage (AGPL, configuration initiale plus lourde), RustFS (trop jeune), une image MinIO figée (plus de correctifs de sécurité).

## 2026-09-30 · Node 24 LTS, TypeScript 6.0, pnpm 11

- Node 24.21.0 : LTS active (Node 26 ne passe LTS qu'en octobre 2026). AdonisJS 7 exige Node ≥ 24.
- TypeScript 6.0.3 et non 7.0 : TypeScript 7 (compilateur natif) n'est pas encore accepté par typescript-eslint (`<6.1`).
- pnpm 11.28.2 : la version 12 a un mois. Versions exactes via le `catalog` de `pnpm-workspace.yaml`, versions publiées depuis moins de 24 h refusées (`minimumReleaseAge`).

## 2026-09-30 · Paquets internes compilés

- Contexte : les paquets de `packages/` sont consommés par Next.js, AdonisJS, des services Node et plus tard des Lambdas.
- Décision : chaque paquet compile avec `tsc` vers `dist/` (ESM + `.d.ts`), et les tâches Turborepo dépendent de `^build`.
- Écartée : exporter directement les sources TypeScript, car chaque consommateur devrait alors savoir les transpiler (et Node refuse de retirer les types dans `node_modules`).

## 2026-09-30 · Noms limités à 255 octets UTF-8

- Contexte : la spécification dit « plus de 255 caractères », mais ext4 limite un nom de fichier à 255 octets.
- Décision : la limite est de 255 octets UTF-8 (identique pour un nom ASCII). Les chemins relatifs sont limités à 1 024 octets.
- Écartée : compter en caractères, qui laisserait passer des noms que l'agent ne pourrait pas écrire sur disque.

## 2026-09-30 · Contrats de compilation plus stricts que l'exemple

- Le préfixe de sortie doit valoir exactement `outputs/{projectId}/{buildId}/`, et la clé S3 d'une ressource binaire doit commencer par `projects/{projectId}/`. Un agent ne peut donc ni écrire ailleurs, ni lire les fichiers d'un autre projet.
- La réponse de l'agent inclut `buildId` et `timings` (synchronisation, exécution, upload), pour mesurer les compilations à chaud. `logUrl` est nul seulement si aucun log n'a été produit (statut `error`).

## 2026-09-30 · CORS sur les buckets S3

- Contexte : l'upload présigné (PUT) et la lecture du PDF par pdf.js (requêtes Range) vont du navigateur directement vers S3, donc vers une autre origine.
- Décision : une règle CORS limitée à l'origine de l'application sur les deux buckets (local : `s3-init` ; staging : Terraform). L'API reste sans CORS.

## 2026-09-30 · CI : actions épinglées par SHA, gitleaks

- Les actions GitHub sont épinglées par SHA de commit (le tag n'est qu'en commentaire).
- gitleaks tourne sur tout l'historique à chaque push et PR, via l'image Docker (le CLI ne demande aucune licence).
- commitlint vérifie les commits des PR (Conventional Commits), sans hook git local.

## 2026-09-30 · `latexmk -norc` (écart avec la commande de la spécification)

- Contexte : latexmk exécute, sans aucune restriction TeX, le `latexmkrc` ou `.latexmkrc` (du Perl) d'un projet. Vérifié : il lit `/etc/passwd` malgré `shell_escape = f`.
- Décision : l'agent ajoute `-norc` à la commande. Le reste est identique à la spécification, et un cas de la suite malveillante le vérifie.

## 2026-09-30 · `openin_any` n'a plus d'effet depuis TeX Live 2026

- Contexte : TeX Live a fait de `openin_any` un no-op (décembre 2025). `\input{/etc/passwd}` et `io.open` lisent tout fichier du conteneur.
- Décision : la valeur reste dans `texmf.cnf`, mais la lecture est protégée par l'isolation (seul le projet est monté, environnement vide, `/etc/passwd` illisible pour l'UID 1000). Des cas de test vérifient qu'aucun fichier de l'hôte n'est lisible (voir `kaxolax-texlive-images`).

## 2026-09-30 · Agent : API Docker par le socket, sans dépendance

- Décision : un client minimal (`node:http` sur le socket Unix) pour créer, démarrer, attendre, tuer et supprimer les conteneurs.
- Écartés : la CLI `docker` (un processus par appel, plus lent et plus fragile à parser), dockerode (dépendance lourde pour cinq appels).

## 2026-09-30 · Plafond du répertoire de travail

- `RLIMIT_FSIZE` (101 Mo) borne chaque fichier. Un chien de garde mesure le répertoire toutes les secondes et tue la compilation au-delà de `WORKDIR_MAX_BYTES`.
- Écartés pour l'étape 1 : quotas XFS par projet, image ext4 montée en boucle (indisponibles sous WSL2). Les quotas XFS restent possibles sur le worker de staging.

## 2026-09-30 · État de l'agent hors du montage et entrées synthétiques

- `state.json` (hash, taille et mtime des ressources écrites, document principal) vit à côté de `files/`, jamais dans le répertoire monté : un document ne peut pas le modifier.
- Une ressource écrasée par la compilation (`\openout` sur un `.tex`) est détectée par sa taille ou son mtime, puis réécrite.
- Les erreurs propres à l'agent (timeout, arrêt, plafond dépassé, chemin refusé) sont ajoutées aux `entries` avec `file` et `line` nuls, pour que l'interface les affiche comme les autres.

## 2026-09-30 · Fastify pour les services internes, scripts d'installation refusés

- Fastify 5 (avec pino) pour l'agent et les autres services Node internes : routes JSON typées, logs structurés, `inject` pour les tests sans réseau.
- pnpm 11 refuse les scripts d'installation par défaut. esbuild (via tsx) est déclaré `allowBuilds: false`, car son binaire vient d'une dépendance optionnelle.

## 2026-09-30 · API : sessions, vérification d'email et jetons

- Contexte : la spécification décrit l'ordre « créer un compte, confirmer l'email, se connecter ».
- Décision : la connexion exige un email vérifié (403 `E_EMAIL_NOT_VERIFIED`). Les jetons de vérification (24 h) et de réinitialisation (1 h) sont à usage unique, seul leur sha256 est stocké, et un nouveau jeton invalide les précédents.
- Les réponses de renvoi de vérification et de mot de passe oublié sont identiques que le compte existe ou non. Mots de passe hachés en scrypt (natif, sans dépendance compilée).

## 2026-09-30 · API : modèles Lucid écrits à la main, UUID générés par l'application

- La génération de schéma de Lucid 22 est désactivée : les modèles déclarent leurs colonnes (décorateurs). Les noms de colonnes qui contiennent des chiffres (`content_sha256`, `s3_key`, `sha256`) sont explicites.
- Les UUID sont générés par l'application (`selfAssignPrimaryKey`), avec `gen_random_uuid()` en valeur par défaut côté base.

## 2026-09-30 · API : unicité des noms et verrou du projet

- Les modifications d'arborescence d'un projet se font en transaction, après `SELECT … FOR UPDATE` sur la ligne du projet. L'unicité d'un nom entre dossiers, documents et fichiers d'un même dossier est ainsi vérifiée sans course (un test lance 5 créations simultanées).
- Des index uniques par type (avec `COALESCE` du dossier parent) servent de filet de sécurité.

## 2026-09-30 · API : CSRF en JSON et proxys de confiance

- Shield redirige en cas de jeton CSRF invalide (formulaires HTML). Le gestionnaire d'exceptions répond à la place 403 `E_BAD_CSRF_TOKEN` en JSON.
- L'IP du client (limitation de débit) n'est lue dans `X-Forwarded-For` que pour `TRUSTED_PROXY_HOPS` intermédiaires (1 par défaut : Next.js ou CloudFront), pour qu'elle ne puisse pas être forgée.

## 2026-09-30 · Temps réel : jeton signé par l'API, rôle relu en base

- L'API signe un jeton court (`v1.<charge>.<HMAC-SHA256>`, 5 minutes) avec `REALTIME_TOKEN_SECRET`, partagé avec le service temps réel. Le jeton porte l'utilisateur et le projet, jamais le document.
- À chaque connexion, le service vérifie la signature et l'expiration, puis le projet du document, l'existence du document et le rôle **relu en base**. Viewer et reviewer reçoivent une connexion en lecture seule, dont les modifications sont ignorées.
- Limite connue : un membre retiré garde sa connexion ouverte jusqu'à sa déconnexion. À traiter avec le partage (étape 2).

## 2026-09-30 · Temps réel : persistance de l'état Yjs

- Chaque document est enregistré en entier (`yjs_state`, avec `content_sha256`), 2 s après la dernière modification et au plus 10 s après la première. L'écriture est sautée si le texte n'a pas changé.
- Un arrêt propre (SIGTERM) ferme les connexions et vide les écritures en attente avant de quitter.
- L'instantané interne (`/internal/projects/:id/snapshot`) lit les documents ouverts en mémoire (modifications pas encore enregistrées comprises) ; les autres sont chargés par `openDirectConnection` puis déchargés.

## 2026-09-30 · Temps réel : URL WebSocket

- Le navigateur reçoit l'URL avec le jeton (`REALTIME_PUBLIC_URL`). En local, c'est `ws://localhost:1234` en direct : un WebSocket n'est pas soumis à CORS, et l'authentification se fait par jeton, sans cookie.
- En staging, le chemin `/realtime` de la même origine est routé vers le service. La règle « même origine » vaut donc pour tous les appels HTTP.

## 2026-09-30 · Tests du temps réel sur une base dédiée

- Les tests du service temps réel recréent la base `kaxolax_realtime_test` et y appliquent les migrations de l'API (`node ace migration:run`), qui restent la seule source du schéma.
- Une base distincte de `kaxolax_test` permet de lancer les deux suites en parallèle sous Turborepo. Le cache du test temps réel tient compte des migrations de l'API.

## 2026-09-30 · Uploads : URL présignée avec taille signée

- Le navigateur annonce nom, dossier et taille exacte ; l'API signe un PUT S3 avec `content-length` (15 min). S3 (et SeaweedFS) refuse un corps d'une autre taille. À la complétion, la taille est revérifiée et le sha256 calculé.
- Plafonds : 100 Mio par fichier, 500 Mio par zip compressé. Un nom déjà pris dans le dossier répond 409 dès la création de l'upload (pas d'écrasement silencieux), puis à nouveau à la complétion.
- Clés : `uploads/{uploadId}` (expiration 1 jour), puis `projects/{projectId}/files/{fileId}` pour les binaires. Les objets d'un fichier, d'un dossier ou d'un projet supprimé sont effacés au mieux après la transaction.

## 2026-09-30 · Import zip : tout vérifier avant d'envoyer vers S3

- Le zip est lu en deux phases : validation complète (répertoire central, chemins, doublons, 5 000 fichiers, 500 Mio annoncés, puis taille réelle de chaque entrée), extraction des binaires dans un répertoire temporaire, et seulement ensuite envoi vers S3. Une zip bomb n'envoie rien.
- Raison supplémentaire : le SDK S3 v3 ne rend jamais la main si le flux du corps d'un `PutObject` échoue (constaté). `ObjectStorage.put` annule donc la requête sur erreur du flux.
- Le texte gardé en mémoire est plafonné à 100 Mio par import (documents Yjs créés ensuite), pour protéger l'instance applicative.

## 2026-09-30 · Import zip : document principal et compilateur

- Document principal : `main.tex` à la racine, sinon le premier `.tex` (le moins profond, puis par ordre alphabétique) qui contient un `\documentclass` non commenté.
- Compilateur : un zip exporté ne le dit pas. `fontspec`, `unicode-math`, `polyglossia`, `xeCJK`… donnent XeLaTeX ; `luacode`, `luatexja`, `\directlua`… donnent LuaLaTeX ; sinon pdfLaTeX. Sans cela, un projet XeLaTeX ne compilerait pas « sans retouche ».
- Un zip dont tout le contenu est dans un seul dossier est importé comme si ce dossier était la racine. `__MACOSX/`, `.DS_Store` et `Thumbs.db` sont ignorés. Liens symboliques et entrées chiffrées sont refusés.

## 2026-09-30 · Gateway : verrou, affinité atomique et arrêt de la compilation précédente

- Le verrou est pris d'office (`SET compile:lock:{id} buildId PX … GET`) : l'ancienne valeur signale une compilation en cours, arrêtée avant de lancer la nouvelle. Il est libéré par comparaison (script Lua), jamais celui d'une autre demande.
- L'affinité est posée par compare-and-set : deux premières demandes simultanées vont au même agent, qui sérialise les compilations d'un projet. Vérifié en réel : deux clics à 300 ms d'écart ne font jamais tourner deux conteneurs du même projet.
- ioredis (déjà utilisé par l'API via `@adonisjs/redis`) pour `SET … GET` et les scripts Lua.

## 2026-09-30 · Compilation : ce que l'API construit et garde

- Ressources : instantané temps réel des documents (état en base si le service ne répond pas), fichiers de la table `files`, chemins calculés depuis l'arbre. Tout membre du projet peut compiler.
- La table `compiles` garde statut, durée, agent et préfixe ; les entrées du log sont écrites à côté des sorties (`entries.json`), pour « dernière compilation » sans changer le modèle de données. `last_compiled_at` est mis à jour sans toucher `updated_at` (tri du tableau de bord).
- SyncTeX du PDF vers le code ne renvoie que des documents du projet : une étiquette de citation pointe vers `output.bbl`, que l'éditeur ne peut pas ouvrir.

## 2026-09-30 · Agent : jamais le PDF d'une compilation antérieure

- Le répertoire garde les sorties précédentes (compilation incrémentale). Le PDF n'est envoyé que si latexmk est allé au bout et que la dernière passe du moteur l'a écrit (`Output written on output.pdf|xdv`). Un arrêt, un timeout ou une erreur fatale sans page ne renvoient plus l'ancien PDF.
- Écarté : supprimer `output.pdf` avant chaque compilation, qui obligerait latexmk à tout relancer et ferait perdre la recompilation à chaud.

## 2026-09-30 · Web : une connexion temps réel par projet, routage par session

- Tous les documents ouverts d'un projet partagent un WebSocket (`HocuspocusProviderWebsocket`). Le jeton est une fonction : un jeton frais de 5 minutes à chaque (re)connexion.
- `sessionAwareness` est activé : sans lui, un document refermé puis rouvert aussitôt sur la même connexion (changement de fichier, double montage de React en développement) perdait ses frappes côté serveur. Un test du service temps réel reproduit le cas.
- L'éditeur n'est créé qu'après la première synchronisation, et une compilation attend que les dernières frappes soient acquittées (3 s au plus).

## 2026-09-30 · Web : build « legacy » de pdf.js

- Le build moderne de pdf.js 6 appelle `Map.prototype.getOrInsertComputed`, absent de navigateurs encore répandus (et du Chromium de Playwright) : la page restait blanche. Le build `legacy`, qui embarque les polyfills, est utilisé.
- Les pages sont rendues quand elles approchent de la zone visible ; la couche texte sert à la recherche, à la sélection et au double-clic SyncTeX.

## 2026-09-30 · API : `GET /projects/:id`

- L'en-tête de l'éditeur a besoin du nom, du compilateur et du rôle de l'utilisateur : route ajoutée à la liste de la spécification, avec le même contrôle d'accès (404 hors membres).

## 2026-09-30 · Images Docker des services

- Un seul `docker/Dockerfile` à cibles multiples (web, api, realtime, compile-gateway, compile-agent) : un étage construit tout le monorepo, puis `pnpm deploy --prod` isole chaque service avec ses seules dépendances de production. Next.js tourne en mode `standalone`.
- Les images sont en arm64, comme les instances Graviton du staging, et construites sur des runners arm. Elles vont dans ECR depuis `main` quand le rôle OIDC est configuré.
- L'agent tourne dans un conteneur qui pilote Docker par le socket de l'hôte. Son répertoire de travail est monté au même chemin des deux côtés : les montages des compilations désignent des chemins de l'hôte. Les compilations restent des conteneurs neufs, sans réseau et sans le socket.

## 2026-09-30 · Déploiement du staging par SSM, parcours Playwright ensuite

- Décision : après le push des images dans ECR, la CI lance `kaxolax-deploy` sur les deux instances par SSM Run Command (rôle OIDC `kaxolax-github-deploy`, instances étiquetées `Project=kaxolax`), attend le résultat, puis lance le parcours de la « Définition de terminé » contre l'URL CloudFront.
- Emails de test sur staging : adresses en `@e2e-mail.<domaine>`, reçues par SES et lues dans S3 par `e2e/mail.ts` (Mailpit en local).
- Écartés : SSH (aucun port ouvert, instances sans IP publique) ; CodeDeploy, une pièce de plus pour deux instances.

## 2026-10-01 · Étape 2 : hébergement visé et staging reporté

- Contexte : l'architecture tout-AWS du prompt (ECS, RDS Multi-AZ, ElastiCache, ASG) coûterait environ 500 $/mois avant tout utilisateur.
- Décision : Railway (web, admin, api, realtime, PostgreSQL, Redis), Cloudflare (DNS, CDN, WAF, R2, Containers pour les compilations à la demande), Clerk (comptes, abonnements). Environ 35 à 50 $/mois. Détail et preuve de concept à la tâche 14.
- Pas de staging pour l'instant : validation en local et en CI ; les critères « sur staging » attendent l'hébergement.
- Écartés : tout AWS (coût), Hetzner (KYC), compilations sur Railway (pas d'isolation possible).

## 2026-10-01 · Auth : Clerk vérifié sans réseau, guard AdonisJS

- L'API vérifie le jeton de session Clerk (`Authorization: Bearer`) avec `verifyToken` et `CLERK_JWT_KEY` (PEM), sans appel réseau ; `azp` doit valoir l'origine de `APP_URL`, une session `sts` non `active` est refusée.
- Un guard `clerk` dans `@adonisjs/auth` garde `auth.getUserOrFail()` dans tous les contrôleurs. `AUTH_MODE` (session, dual, clerk) sert de feature flag pendant la migration ; une requête porteuse d'un Bearer ne retombe jamais sur le cookie de session.
- Note : `verifyToken` exporté par `@clerk/backend` renvoie les claims et lève une erreur, contrairement à ses types internes (`{ data, errors }`).

## 2026-10-01 · Auth : miroir users par webhooks, création à la volée

- Les webhooks `user.created|updated|deleted` sont vérifiés sur le corps brut (Standard Webhooks) et traités une fois : `INSERT … ON CONFLICT DO NOTHING` dans `clerk_webhook_events`, dans la même transaction que leur effet.
- Rattachement : `clerk_user_id`, puis `external_id` (compte importé), puis email vérifié d'un compte de l'étape 1.
- Un jeton valide dont le compte n'est pas encore connu (webhook en retard, ou absent en local et en CI) crée le miroir depuis les claims du jeton (`email`, `email_verified`, `name`, `picture`), seulement si l'email est vérifié.
- `user.deleted` : ligne gardée et anonymisée (auteur des compilations et des futurs messages), retrait des projets partagés, suppression de ses projets ; un événement en retard ne la recrée pas.

## 2026-10-01 · Auth : CSRF limité aux sessions de l'étape 1

- Un jeton dans un en-tête n'est jamais envoyé d'office par le navigateur, et l'API n'a pas de CORS : une requête Bearer et le webhook (signé) sont exemptés du CSRF. Le CSRF disparaît avec les sessions.

## 2026-10-01 · Auth : import des comptes de l'étape 1 dans Clerk

- `node ace clerk:import-users` relie chaque compte vérifié à un compte Clerk (`external_id` = id local), en le créant s'il n'existe ni par `external_id` ni par email. Idempotent : un compte relié n'est plus traité, un échec est rejoué au passage suivant ; `--dry-run` ne change rien.
- Mots de passe : AdonisJS hache en scrypt avec un sel binaire ; Clerk n'importe le scrypt qu'aux formats Firebase et Werkzeug, dont le sel est un texte. Un test montre qu'un vérificateur Werkzeug fidèle ne retrouve pas le mot de passe. Les comptes sont donc créés sans mot de passe et le choisissent à la première connexion (« Mot de passe oublié ») ; `--probe-hash` le confirme contre une vraie instance Clerk.
- Les comptes jamais vérifiés ne sont pas importés (ils ne pouvaient pas se connecter).

## 2026-10-01 · Web : Clerk lu à l'exécution, pages protégées par layout

- La clé publishable (passée au `ClerkProvider` et à `clerkMiddleware`), `CLERK_SECRET_KEY` (lue par Clerk) et `CLERK_JWT_KEY` sont lues à l'exécution : la même image sert tous les environnements, et `next build` passe sans clé (layout `force-dynamic`).
- Pas de `createRouteMatcher` (déprécié par Clerk) : le layout serveur du groupe `(app)` exige une session et renvoie vers `/sign-in?redirect_url=…`. Le proxy ne fait que préparer l'état d'auth ; `/api` (vérifié par l'API) et `/healthz` en sont exclus.
- Le client API attend que Clerk soit chargé, puis envoie un jeton frais à chaque requête, sans cookie (`credentials: 'omit'`). Écrans Clerk en français (`@clerk/localizations`), télémétrie Clerk désactivée.
- Zip : `POST /projects/:id/download-url` émet un lien chiffré par `APP_KEY` (60 s, lié à l'utilisateur et au projet, rôle revérifié au téléchargement), car une navigation ne porte pas l'en-tête `Authorization`.
