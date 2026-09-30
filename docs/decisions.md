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
