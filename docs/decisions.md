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
