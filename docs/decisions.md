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

## 2026-10-01 · Auth : bascule et nettoyage en un seul commit

- La bascule (Clerk seul) et le nettoyage forment un commit : basculer seul aurait cassé les tests de l'auth par session, que le nettoyage supprime.
- Retirés : routes `/auth/*`, guard de session, CSRF, limiteur, Redis côté API, `@adonisjs/session|limiter|redis`, hachage, emails d'auth, `auth_tokens`, `password_hash`, `email_verified_at`, le flag `AUTH_MODE`.
- La migration `…0012` supprime les comptes jamais vérifiés, puis refuse de s'appliquer s'il reste un compte vérifié non relié à Clerk, au lieu de le perdre. Répétée sur une copie de données créées par l'API de l'étape 1 : projets et documents conservés ; sans import préalable, elle s'arrête et annule tout.
- `clerk:import-users` disparaît avec les colonnes qu'il lisait : sur un environnement qui a des comptes de l'étape 1, déployer d'abord le commit 56e4814, lancer l'import, puis déployer la suite.

## 2026-10-01 · Workspaces : modèle et rattachement des projets

- Tables `workspaces` (type `personal` ou `team`, `owner_id`) et `workspace_members` (`owner`, `admin`, `member`) ; un seul workspace personnel par propriétaire, garanti par l'index unique partiel `(owner_id) WHERE type = 'personal'`. Le lien aux Organisations Clerk viendra avec les équipes (étape 3).
- `ensurePersonalWorkspace` (`INSERT … ON CONFLICT DO NOTHING`, puis relecture) est appelé par `upsertClerkUser` : webhook `user.created`/`user.updated` et création à la volée par le guard. Idempotent et sûr en concurrence ; la création de projet et l'import zip l'appellent aussi, et `GET /workspaces` répare un compte qui n'en a pas (miroir créé par l'ancienne version pendant un déploiement, ligne importée en SQL), sans écriture dans le cas courant.
- Migration `…0014` : workspace personnel pour chaque ligne de `users` (comptes anonymisés compris), rattachement de chaque projet à celui de son `owner_id` en SQL, puis `workspace_id` NOT NULL (voir l'entrée suivante pour l'ancienne API). Répétée sur une copie (2 comptes, 3 projets, 6 documents) : comptes et sommes de contrôle inchangés, rollback puis réapplication sans perte.
- `GET /projects?workspaceId=` : projets du workspace dont l'utilisateur est membre (workspace d'autrui : 404) ; sans filtre, tous ses projets, partagés compris. Un projet partagé reste dans le workspace de son propriétaire.

## 2026-10-01 · Migration …0014 : coexistence avec l'API de l'étape 1

- Les migrations passent avant le basculement, pendant que l'API de l'étape 1 sert encore : ses `Project.create` (création, import zip) n'envoient pas `workspace_id` et échouaient sur le NOT NULL.
- Déclencheur `BEFORE INSERT` `projects_default_workspace_id`, seulement si `workspace_id` est NULL : rattache le projet au workspace personnel du propriétaire, créé au besoin avec son appartenance (même logique que `ensurePersonalWorkspace`). Une insertion reçue pendant la migration attend la fin de sa transaction (verrou sur `projects`), puis réussit : vérifié sur la copie, ancienne forme d'insertion comprise.
- À retirer par une migration de la version suivante, quand plus aucune instance de l'étape 1 ne tourne ; le code de l'étape 2 renseigne toujours la colonne, et un `workspace_id` fourni n'est jamais remplacé.
- Écartés : colonne nullable jusqu'à la version suivante (tout le code de l'étape 2 devrait gérer un projet sans workspace) ; arrêter l'ancienne version avant la migration (interruption de service).

## 2026-10-01 · Tables d'association : clé de substitution `id`

- Lucid ne gère qu'une colonne de clé primaire : avec une clé composée, `save()` et `delete()` sur une instance filtraient sur la dernière colonne `isPrimary` (`user_id`, `file_id`), donc touchaient toutes les lignes de l'utilisateur ou du fichier.
- `project_members`, `workspace_members`, `chat_reads`, `version_files` : clé primaire `id uuid` (`UuidModel`) et contrainte unique sur le couple, qui arbitre aussi les `ON CONFLICT`. Migration `…0022` pour `project_members` (étape 1) : un UUID par ligne existante ; répétée sur la copie, `down` compris, sans perte.
- Écarté : garder la clé composée et interdire `save()`/`delete()` par un commentaire ; le piège restait silencieux pour les tâches 4, 6 et 8.

## 2026-10-01 · Schéma de l'étape 2 : règles ON DELETE

- CASCADE pour ce qui appartient à un projet (invitations, liens, versions, fils et commentaires, chat, lectures) ou à un compte (préférences, abonnements, appartenances, workspace personnel).
- RESTRICT pour les auteurs (`invited_by`, `author_id`, `resolved_by`, `created_by`, `admin_id`) : un compte est anonymisé, jamais supprimé, et une suppression accidentelle échoue au lieu d'effacer l'historique. RESTRICT aussi pour `projects.workspace_id` : un workspace qui contient des projets ne se supprime pas.
- Sans clé étrangère : `version_files.file_id` (le fichier peut quitter l'arborescence, la version garde son binaire), les tableaux `uuid[]` de `project_versions`, `subscriptions.plan_slug` (un plan créé dans Clerk avant sa ligne de limites ne bloque pas le webhook).
- Enums en texte + CHECK comme à l'étape 1, sauf `subscriptions.status` (liste tenue par Clerk). Langues du correcteur figées par CHECK (`en`, `fr`) : en ajouter une demande une migration.

## 2026-10-01 · Abonnements : valeurs de départ de plan_limits

- `free` : 20 s de compilation, 1 collaborateur en plus du propriétaire, 1 jour d'historique, 500 Mio. `pro` : 240 s, collaborateurs et historique illimités (NULL), 20 Gio. Tailles en binaire, comme les autres limites du code.
- La clé est le slug du plan Clerk : `free` et `pro` doivent correspondre aux slugs du Dashboard Clerk, à vérifier à la tâche 12.

## 2026-10-01 · Turbo : typecheck du web avant son build

- `next typegen` (typecheck) et `next build` écrivent tous deux dans `apps/web/.next` ; lancés en parallèle sans cache, le build effaçait `.next/types/routes.d.ts` pendant `tsc` (échec intermittent de `pnpm check`).
- `apps/web/turbo.json` : `build` dépend du `typecheck` du même paquet. Même règle pour `apps/admin` à sa création.

## 2026-10-01 · Jetons de design dans packages/ui

- `@kaxolax/ui/tokens.css` (source CSS servie telle quelle) porte couleurs oklch, rayons, tailles de barres et le bloc `@theme inline` de Tailwind 4 ; les applications l'importent au lieu de redéfinir leurs variables.
- Thème choisi par `data-theme` sur `<html>` (sombre par défaut), posé avant le rendu par `ThemeScript` ; la variante `dark:` suit cet attribut et non `prefers-color-scheme`. Un sous-arbre `data-theme="light"` reste clair ; les jetons `pdf-*` sont clairs dans les deux thèmes.
- Huit couleurs de présence (même teinte, luminosité par thème) ; couleur d'un collaborateur = hachage FNV-1a de son id, identique sur tous les clients sans coordination.
- `Command` écrit sans `cmdk` : liste filtrée et navigation clavier suffisent, une dépendance de moins.

## 2026-10-01 · Éditeur : registre d'actions et barre Tools

- `@kaxolax/editor` tient un registre typé (`createActionRegistry`) : une action = id, libellé français, menu, groupe, icône lucide (nom), raccourci CodeMirror, prédicat `when`, `run(ctx)` avec l'`EditorView` et les callbacks de l'application (`ActionHost`). Les outils des tâches 9 et 10 s'y enregistrent ; la barre Tools ne fait que lister `byMenu`.
- Raccourcis liés en `Prec.high` et suivis à chaque (dés)inscription par un Compartment ; une action désactivée laisse passer la touche. Rechercher/remplacer : `Mod-Alt-f` (Cmd+H masque l'application sur macOS).
- Une action = une transaction annotée `isolateHistory` et `userEvent: input.action` : une étape d'annulation, packages requis (amsmath, graphicx) ajoutés au préambule dans la même transaction, sans doublon.

## 2026-10-01 · Éditeur : thème et réglages reconfigurables

- Thème sombre par défaut ; couleurs lues dans les variables de `tokens.css` (`--editor`, `--editor-syntax-*`…) avec palette de repli. `.cm-editor` porte `data-theme` : l'éditeur garde son mode quel que soit le thème de la page.
- Thème, lecture seule et retour à la ligne dans des Compartments (`reconfigureEditor`) : changer un paramètre ne recrée ni l'éditeur ni la connexion Yjs.
- Auto-compilation en extension (`autoCompile`) : seules les modifications locales (avec `userEvent`) relancent l'attente, pas celles des collaborateurs.

## 2026-10-01 · Préférences utilisateur : schéma partiel et fusion profonde

- `userPreferencesSchema` (@kaxolax/contracts) : toutes les clés facultatives, objets stricts ; seules les valeurs changées sont stockées, `resolvePreferences` applique `DEFAULT_PREFERENCES` à la lecture (les défauts peuvent évoluer sans migration).
- `PATCH /me/preferences` : fusion profonde, tableaux remplacés ; `INSERT … ON CONFLICT DO NOTHING` puis `SELECT … FOR UPDATE` pour sérialiser les modifications simultanées.
- Onglets ouverts bornés (20 projets, 30 onglets) : chaque entrée reçoit de l'API un numéro croissant `usedSeq` (jsonb ne garde pas l'ordre des clés), les plus anciens numéros sortent ; JSON limité à 32 Kio. Une clé stockée devenue invalide est écartée seule (`sanitizePreferences`), les autres restent.
- Client : PATCH enchaînés et seule la réponse du dernier envoi appliquée ; à la fermeture de la page, envoi `fetch` `keepalive` avec le dernier jeton Clerk obtenu (gardé en mémoire 45 s).

## 2026-10-01 · Recherche dans tout le projet : expression régulière sous délai

- `GET /projects/:id/search` relit le texte courant via `projectContent` (instantané temps réel), comme la compilation ; pas d'index : un projet tient en mémoire.
- Texte et expression passent par le même `RegExp` (flag `u`, `i` sauf casse respectée, mot entier par lookarounds Unicode). Expression limitée à 200 caractères.
- Contre le ReDoS : boucle exécutée dans `vm.runInNewContext` avec `timeout` de 500 ms (V8 interrompt aussi une regex en retour arrière), dans une réserve de `worker_threads` (4 par processus, 429 au-delà) : la boucle d'événements de l'API n'est jamais bloquée. Une recherche par utilisateur : la suivante annule la précédente (409, worker arrêté). Écarté : heuristique sur les motifs (incomplète).

## 2026-10-01 · Options de compilation : brouillon et arrêt à la première erreur

- `options: { draft?, haltOnFirstError? }` dans le corps de `POST /projects/:id/compile` et dans `CompileRequest` (objet strict : une option inconnue est refusée par l'API, le gateway et l'agent).
- Arrêt à la première erreur : `-halt-on-error` de latexmk. Brouillon : `-usepretex=\PassOptionsToPackage{draft}{graphicx}\PassOptionsToPackage{draft}{hyperref}`, code constant lu avant le document ; aucun fichier du projet modifié.
- La commande reste un tableau d'arguments constants (pas de shell côté Docker), `-norc` conservé, jamais `-shell-escape`.

## 2026-10-01 · Web : page projet en trois colonnes

- `editor-page.tsx` découpé dans `components/workspace/` : `workspace-page` (données, onglets, compilation, SyncTeX), `workspace-layout`, `sidebar/`, `editor/`, `pdf/`, `file-actions` (contexte partagé par l'arbre, le menu + et le menu Fichier de Tools).
- Colonnes react-resizable-panels ; seules les tailles issues d'un geste de l'utilisateur (`isUserInteraction`) vont dans `layout`, la sidebar repliée garde sa dernière largeur. Sous 1024 px : sidebar en tiroir, éditeur et PDF en onglets, tous deux montés (connexion Yjs et rendu PDF conservés).
- Onglets ouverts par projet dans `openTabs` (documents et fichiers prévisualisés) ; dérivés des préférences tant que l'utilisateur n'y touche pas, sans effet de synchronisation.
- Emplacements des tâches suivantes posés sans fonction : `PresenceStack`, `ShareButton` (modale), `ChatsPanel`, `ReviewPanel`, `HistoryDrawer`, `AskSlot`.

## 2026-10-01 · Web : barre Tools, plan et recherche dans le projet

- Barre Tools en `Menubar` Radix (un menu par entrée de `ACTION_MENUS`) plutôt que des `DropdownMenu` isolés : navigation au clavier d'un menu à l'autre ; disponibilité des actions évaluée à l'ouverture.
- Point d'extension des tâches 9 et 10 : `useEditorActions()` (registre partagé, `host`, `run`) et `ACTION_DIALOGS` (boîte de dialogue par id, ouverte par `host.openDialog`). Lecture seule (viewer, reviewer) : `host.readOnly` et callbacks de fichiers absents.
- Plan : document courant relu 250 ms après la frappe ; fichiers inclus du projet lus en direct par des fournisseurs Yjs sans présence sur la connexion partagée (30 au plus, inclusions imbriquées comprises).
- Recherche projet : panneau dans la sidebar (Ctrl+Maj+F), requête 300 ms après la frappe, clic = onglet ouvert et occurrence sélectionnée.

## 2026-10-01 · Web : préférences et thème sans flash

- `PreferencesProvider` dans le layout `(app)` : `GET /me/preferences` une fois, modifications optimistes regroupées 800 ms avant `PATCH`, envoi immédiat quand la page est masquée ; en cas de refus, retour à l'état enregistré.
- Thème recopié dans le cookie `kaxolax-theme` : le layout racine (déjà dynamique) rend `data-theme` dans le HTML ; `ThemeScript` (localStorage) couvre les pages sans cookie.
- Composants Clerk habillés par `appearance.variables` pointant vers les variables CSS des jetons : ils suivent le thème sans `@clerk/themes` (paquet de Core 2, non aligné sur `@clerk/nextjs` 7).
- Logs dans un tiroir au-dessus du PDF (non modal : un clic dans l'éditeur ne le ferme pas) ; compilateur, auto-compilation, brouillon et arrêt à la première erreur dans le menu de la pastille de statut.

## 2026-10-01 · Web : clavier, états et bascule de thème de la page projet

- Arborescence en motif ARIA « tree view » (une ligne dans l'ordre de tabulation, flèches, F2, Suppr, Maj+F10 pour le menu) ; onglets des fichiers et vue Éditeur/PDF en « tabs » (flèches). Logique de navigation pure dans `lib/tree.ts`, testée.
- Sidebar repliée rendue `inert` : sa largeur nulle ne suffit pas à la sortir de l'ordre de tabulation ; le focus passe au bouton inverse après repli ou dépli.
- États explicites : squelettes, page d'erreur du chargement initial, échec du jeton temps réel affiché dans l'éditeur (plus de promesse rejetée sans traitement).
- Bascule sombre/clair dans le pied de sidebar (préférence `theme`) en attendant les paramètres de la tâche 10 : le thème clair reste atteignable dès la tâche 3.

## 2026-10-01 · Éditeur : `happy-dom` pour les tests qui créent une vue CodeMirror

- `happy-dom` 20.14.5 (devDependency de `packages/editor`, version exacte dans le catalog) fournit le DOM aux tests qui instancient une `EditorView` (`configuration.test.ts` : thème, compartiments, auto-compilation). Plus léger que jsdom, activé fichier par fichier (`@vitest-environment happy-dom`) ; les autres tests restent en environnement Node.

## 2026-10-01 · Admin : accès par rôle Clerk et MFA vérifiée deux fois

- Rôle `admin` lu dans le claim `metadata.role` et second facteur vérifié dans la session (`fva[1] !== -1`) : un non-admin est refusé sans appel réseau.
- Puis l'API Backend de Clerk confirme le rôle et `twoFactorEnabled` (MFA retirée ou rôle enlevé depuis l'émission du jeton), en cache mémoire 60 s par instance ; une erreur de Clerk n'est pas mise en cache.
- `ClerkBackend` (service résolu par le conteneur) isole `@clerk/backend` : les tests le remplacent par un faux, sans réseau. Le guard expose les claims vérifiés (`getClaimsOrFail()`).

## 2026-10-01 · Bannissement : `users.banned_at` local en plus de Clerk

- Clerk révoque les sessions d'un compte banni, mais ses jetons déjà émis restent valides jusqu'à 60 s : l'API refuse tout compte avec `banned_at` (401 `E_ACCOUNT_BANNED`, remonté même par `check()`).
- Posé par l'action de l'admin et par le webhook `user.updated` (`banned`) ; `ban_state_updated_at` garde le `updated_at` Clerk de l'état reflété, un webhook plus ancien arrivé en retard est ignoré.
- Le service temps réel ferme toutes les connexions du compte (`POST /internal/users/:id/disconnect`, code 4403) et `memberRole` ignore les comptes bannis ou supprimés : pas de reconnexion. Les liens de téléchargement déjà émis sont refusés aussi.

## 2026-10-01 · Révocation des sessions : coupure locale `users.sessions_revoked_at`

- Clerk révoque les sessions, mais le jeton déjà émis reste valide jusqu'à 60 s et le web demande un jeton temps réel à chaque reconnexion : fermer les connexions ne suffisait pas.
- L'action pose `sessions_revoked_at` ; l'API refuse un jeton Clerk émis avant (`iat`), le service temps réel un jeton temps réel émis avant (nouveau claim `iat`, obligatoire).
- `iat` est à la seconde : un jeton émis dans la seconde de la coupure est refusé (le suivant passe). La colonne n'est jamais remise à zéro.

## 2026-10-01 · Journal de l'admin : même transaction que l'effet

- Chaque action écrit `admin_audit_log` dans la transaction de son effet : l'entrée n'existe que si l'effet a eu lieu. Pour les actions via Clerk, l'appel Clerk précède la transaction locale.
- Un échec significatif (Clerk en erreur, erreur interne) est journalisé hors transaction avec `metadata.outcome = failure` et le code d'erreur ; un refus 4xx (cible absente, action sur soi-même) ne l'est pas. Une action sans effet (projet déjà archivé) n'écrit rien.
- La suppression d'un compte anonymise tout de suite après l'appel Clerk réussi ; le webhook `user.deleted` qui suit ne change plus rien.
- Les entrées des actions sur un compte ne gardent que ses identifiants (uuid, id Clerk), jamais l'email : le journal, sans durée de conservation, ne défait pas l'anonymisation.

## 2026-10-01 · Admin : déconnexion temps réel vérifiée et journalisée

- Bannir, révoquer les sessions, supprimer : la déconnexion temps réel suit la validation en base ; son résultat est une entrée `user.realtime_disconnect` à part (`connectionsClosed`, `failure` si le service n'a pas répondu), l'entrée de l'action restant immuable.
- La réponse porte `realtimeDisconnected` ; l'admin affiche un avertissement et propose « Révoquer les sessions ».
- Le service temps réel revérifie le compte dans `connected` (connexion attachée au document) : une connexion authentifiée juste avant le bannissement n'échappe plus à la fermeture.

## 2026-10-01 · Statistiques de l'admin : définitions

- Utilisateur actif sur N jours : compte non supprimé qui a lancé une compilation, est auteur d'une version, ou possède un projet modifié (`projects.updated_at`) dans la fenêtre ; fenêtres de 7 et 30 jours qui finissent à la fin de la période.
- Échec de compilation : tout statut autre que `success`. Abonnés Pro : comptes distincts avec un abonnement `pro` au statut `active` (`past_due` compté à part).
- Inscriptions par jour UTC ; période de 30 jours par défaut, 366 au plus. Requêtes SQL à la suite (pas de `Promise.all`) : une seule connexion, page peu consultée.

## 2026-10-01 · Bannière système : sondage en attendant le document meta

- `GET /banners/active` (tout compte connecté, `no-store`) ; le web la relit toutes les 60 s et au retour sur l'onglet.
- `RealtimeClient.notifyBannerChanged` est appelée après chaque création, modification ou suppression ; elle ne fait que journaliser et sera branchée sur le document meta des projets (tâche 5).
- Terminer une bannière : `POST /admin/banners/:id/end`, fin à l'heure du serveur (pas celle du navigateur de l'admin). Fermeture côté web mémorisée par id, niveau et message : une bannière modifiée réapparaît.
- Affichage en haut de l'application (bandeau fixe pleine largeur, refermable), sans hauteur ajoutée à l'éditeur plein écran ; la nouvelle interface (tâche 3) pourra lui réserver une place.

## 2026-10-01 · Admin : application Next.js séparée, sans accès direct aux données

- `apps/admin` : Next.js 16 à part (domaine propre, port 3001, image `standalone`), même pile que `apps/web` ; une faille ou une dépendance de l'admin ne touche pas l'application, et inversement.
- Aucune lecture de base : tout passe par `/api/v1/admin/*` (réécriture `/api`), réponses validées par les schémas zod de `@kaxolax/contracts`.
- Layout serveur : session, claim `metadata.role` et `fva[1] !== -1`, sinon page « Accès refusé » identique quelle que soit la raison ; l'API reste seule juge (MFA activée vérifiée chez Clerk).
- Sous-domaine du domaine principal Clerk : session partagée sans instance satellite. Actions irréversibles : confirmation avec texte à recopier.

## 2026-10-01 · Partage : matrice des permissions partagée

- Une seule matrice rôle → permissions dans `packages/contracts/src/permissions.ts` (`read`, `compile`, `comment`, `edit`, `manageMembers`, `manageShareLinks`, `transferOwnership`, `manageProject`, `leave`), fonctions pures testées (`canEdit`, `canManageMembers`…).
- L'API demande une permission à `projectFor` (plus de rangs dispersés) ; le service temps réel décide la lecture seule par `canEdit` ; le web s'en servira pour l'affichage.
- Comportements inchangés : viewer et reviewer lisent et compilent, reviewer commente, editor édite, owner gère tout. La compilation garde provisoirement la forme « rôle minimal » (fichiers de la tâche 14).

## 2026-10-01 · Partage : jetons hachés, liens régénérables

- Invitation : jeton aléatoire de 256 bits envoyé une seule fois par email, seul son sha256 est stocké ; 7 jours ; une relance remplace le jeton et repousse l'échéance (1 envoi par minute, 10 par invitation, 30 créations par heure et par compte).
- Lien de partage : jeton = HMAC-SHA256 (`APP_KEY`) de l'identifiant aléatoire du lien, seul son sha256 est stocké ; le propriétaire peut réafficher son lien sans qu'il soit en base. Changer `APP_KEY` invalide tous les liens.
- Désactiver puis réactiver redonne le même lien ; régénérer remplace la ligne (nouvel identifiant, donc nouveau jeton) et l'ancien lien cesse aussitôt de fonctionner.
- Aperçus publics (`GET /invitations/:token`, `GET /share/:token`) : nom du projet, rôle, nom de l'invitant ; jamais d'email ni d'identifiant.

## 2026-10-01 · Partage : acceptation automatique et limite de collaborateurs

- À la création du miroir Clerk (webhook ou création à la volée, email vérifié), les invitations en attente non expirées pour cet email sont acceptées dans la même transaction ; celles que la limite du plan bloque restent en attente.
- Acceptation manuelle : l'email du compte connecté doit être celui de l'invitation (403 avec indice masqué `a***@domaine`).
- Limite : celle du plan du propriétaire (`plan_limits`, abonnement lu dans `subscriptions`, pas les claims du jeton : la requête peut venir d'un autre compte). Membres hors propriétaire + invitations en attente non expirées, projet verrouillé ; 403 `E_PLAN_LIMIT` avec la limite. Un membre qui rejoint par lien ou invitation garde son rôle le plus élevé.

## 2026-10-02 · Partage : limites d'envoi durables, emails des membres, journal

- Invitation annulée gardée (`cancelled_at`) : réinviter la réactive avec ses compteurs (1 envoi par minute, 10 en tout) ; la limite de 30 créations par heure compte les annulées, sous verrou consultatif par compte. Un email qui ne part pas annule l'envoi (ancien lien valide, envoi non compté).
- Acceptation idempotente pour le compte invité (déjà acceptée → 200 `joined: false`) : la page d'invitation retrouve le projet après l'acceptation automatique à l'inscription ; acceptation automatique invitation par invitation, en point de sauvegarde.
- Verrous toujours dans l'ordre projet puis ligne visée (invitation, lien, membre) : pas d'interblocage entre propriétaire et adhésion par jeton.
- Emails des membres visibles du seul propriétaire (et de chacun pour le sien) : un lien public ne livre pas les adresses des collaborateurs.
- Journal `project_sharing_events` (sans clé étrangère, survit au projet) + ligne de journal structurée par action ; jamais de jeton, d'URL de lien ni d'email.

## 2026-10-01 · Partage : retraits et changements de rôle appliqués en temps réel

- L'API appelle `POST /internal/projects/:id/members/:userId/changed` après validation ; le service relit le rôle et ferme (4403) ou passe en lecture seule ou en écriture les connexions concernées, avec un message sans état `member.role-changed`.
- Filets si la notification se perd : rôle d'un rédacteur relu à sa mise à jour si la dernière lecture date de plus de 5 s, et relecture de toutes les connexions toutes les 30 s.
- Mise à jour forcée par un lecteur : rejetée et journalisée ; connexion fermée au 5e rejet. Logique isolée dans `apps/realtime/src/access.ts`, avec une interface `MemberChangeFanout` pour l'extension Redis (tâche 5).
- Transfert de propriété : logique commune avec l'admin (`project_ownership.ts`), qui notifie désormais aussi le service temps réel.
