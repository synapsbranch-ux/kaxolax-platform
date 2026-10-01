# @kaxolax/api

API REST de Kaxolax (AdonisJS 7, Lucid, VineJS), sous `/api/v1`. Le navigateur l'appelle par la
même origine que l'application (rewrites Next.js en local, CDN en production) : pas de CORS.

## Fonctionnalités

- **Comptes (Clerk)** : inscription, connexion, MFA, sessions et suppression du compte sont gérées
  par Clerk ; Kaxolax ne stocke ni mot de passe ni jeton d'authentification.
  - Chaque requête porte le jeton de session Clerk (`Authorization: Bearer`), vérifié sans appel
    réseau (`CLERK_JWT_KEY`, claim `azp` égal à l'origine de `APP_URL`) par le guard `clerk`
    (`app/auth/clerk_guard.ts`). Pas de cookie, donc pas de CSRF.
  - La table `users` est le miroir local des comptes (id interne pour toutes les clés étrangères,
    `clerk_user_id`, email, nom, avatar), alimenté par les webhooks Clerk
    (`POST /webhooks/clerk` : `user.created`, `user.updated`, `user.deleted`, signature vérifiée,
    chaque événement traité une fois). Un jeton valide arrivé avant le webhook crée le miroir
    depuis ses claims, si l'email est vérifié.
  - Compte supprimé dans Clerk : ligne anonymisée, retrait des projets partagés, suppression de
    ses projets.
  - `GET /me` : l'utilisateur local de la session.
- **Workspaces** : tout projet appartient à un workspace. Chaque compte reçoit un workspace
  personnel (« Personal workspace », un seul par propriétaire, index unique partiel), créé par
  `ensurePersonalWorkspace` (`app/services/workspace_service.ts`, idempotent) à chaque
  `upsertClerkUser` : webhook ou création à la volée. `GET /workspaces` : les workspaces de
  l'utilisateur avec son rôle (`owner`, `admin`, `member` ; seul `owner` à l'étape 2) ; il crée
  le workspace personnel d'un compte qui n'en a pas encore. Un workspace dont il n'est pas
  membre répond 404.
- **Projets** : liste (`view` = active, archived, trashed ; `q` ; `workspaceId`, sinon tous les
  projets dont l'utilisateur est membre, partagés compris), création avec un `main.tex` minimal
  qui compile (dans le workspace `workspaceId` ou, par défaut, le workspace personnel),
  renommage, compilateur, document principal, langue du correcteur (`spellcheckLanguage` : `en`
  ou `fr`, rôle editor), archive, corbeille, suppression depuis la corbeille.
- **Arborescence** : dossiers et documents texte (état Yjs dès l'étape 1), renommage,
  déplacement, suppression récursive. Chemins calculés, jamais stockés. Noms uniques dans un
  dossier, tous types confondus, vérifiés en transaction avec le projet verrouillé.
- **Accès** : toujours par `project_members`. Un projet dont l'utilisateur n'est pas membre
  répond 404. Rôles : owner > editor > reviewer > viewer.
- **Temps réel** : `POST /projects/:id/realtime-token` signe un jeton de 5 minutes pour le
  service `apps/realtime` (`REALTIME_TOKEN_SECRET`, `REALTIME_PUBLIC_URL`). À la suppression
  d'un document, d'un dossier ou d'un projet, l'API demande au service de fermer les connexions
  ouvertes (`REALTIME_INTERNAL_URL`, `INTERNAL_TOKEN`), au mieux et avec un délai de 2 s.

- **Uploads** : `POST /projects/:id/uploads` renvoie une URL de PUT présignée (taille signée),
  puis `POST /projects/:id/uploads/:uploadId/complete` vérifie l'objet et crée un document texte
  ou un fichier binaire (`@kaxolax/upload-processor`). `GET /projects/:id/files/:fileId/url`
  donne une URL de lecture de 5 minutes (`?download=true` pour télécharger).
- **Import zip** : `POST /imports`, puis `POST /imports/:uploadId/complete` crée le projet
  (`@kaxolax/zip-importer`), dans le workspace `workspaceId` (facultatif) ou le workspace
  personnel.

- **Compilation** : `POST /projects/:id/compile` (instantané temps réel + table `files`, envoyé
  au compile-gateway ; résultat enregistré dans `compiles`, URL présignées du PDF et du log),
  `POST /projects/:id/compile/stop`, `GET /projects/:id/compile/last`,
  `POST /projects/:id/compile/clear-cache`.
- **SyncTeX** : `GET /projects/:id/synctex/code` (`file`, `line`, `column`) et
  `GET /projects/:id/synctex/pdf` (`page`, `h`, `v`).
- **Export** : `GET /projects/:id/download.zip`, en streaming, réimportable tel quel ; ou
  `POST /projects/:id/download-url`, un lien chiffré de 60 s pour télécharger par simple
  navigation (`GET /downloads/:token`, rôle revérifié au téléchargement).

## Schéma

Migrations Lucid dans `database/migrations` (jamais de perte de données ; `down` pour chacune).
L'étape 2 ajoute, en plus des workspaces, les tables des tâches suivantes, avec leurs modèles
dans `app/models` : `project_invitations`, `share_links`, `project_versions`, `version_files`,
`comment_threads`, `comments`, `chat_messages`, `chat_reads`, `user_preferences`, `plan_limits`
(valeurs de départ `free` et `pro`), `subscriptions`, `system_banners`, `admin_audit_log`. Ce
qui appartient à un projet part avec lui (CASCADE) ; les auteurs sont en RESTRICT, car un compte
est anonymisé et jamais supprimé (voir `docs/decisions.md`). Les tables d'association
(`project_members`, `workspace_members`, `chat_reads`, `version_files`) ont une clé `id` de
substitution et un couple unique : Lucid ne gère qu'une colonne de clé primaire, et `save()` ou
`delete()` sur une instance ne doivent toucher que sa ligne.

Déploiement de l'étape 2 : les migrations peuvent passer pendant que l'API de l'étape 1 sert
encore. Ses créations de projet (sans `workspace_id`) sont rattachées au workspace personnel du
propriétaire par le déclencheur `projects_default_workspace_id` (migration `…0014`), à retirer
par une migration de la version suivante.

## Développement

Prérequis : la stack locale (`docker compose up -d` à la racine) : PostgreSQL, S3 (SeaweedFS)
et Mailpit ; et les clés d'une instance Clerk de développement dans `.env` (`CLERK_JWT_KEY`,
`CLERK_SECRET_KEY`, `CLERK_WEBHOOK_SIGNING_SECRET`, voir le README racine).

```bash
pnpm --filter @kaxolax/api migrate   # applique les migrations (crée .env depuis .env.example au besoin)
pnpm --filter @kaxolax/api dev       # http://localhost:3333/api/v1/health
```

Les emails de l'application arrivent dans Mailpit : http://localhost:8025 (ceux de l'auth sont
envoyés par Clerk).

Webhooks Clerk en local (facultatif : le miroir est aussi créé depuis les claims du jeton) :
`cloudflared tunnel --url http://localhost:3333`, puis déclarer
`https://<tunnel>/api/v1/webhooks/clerk` dans le Dashboard Clerk.

## Tests

```bash
pnpm --filter @kaxolax/api test      # Japa : unitaires + fonctionnels (base kaxolax_test)
```

Les tests fonctionnels couvrent chaque endpoint, y compris les refus : projet d'un autre
utilisateur, workspace d'un autre utilisateur, nom en double, nom invalide, rôle insuffisant,
jeton Clerk expiré, falsifié ou d'une autre application, webhook mal signé ou rejoué. Ils
signent de vrais jetons au format Clerk avec une paire RSA générée à chaque lancement
(`tests/clerk_keys.ts`), vérifiés par `@clerk/backend` ; `.loginAs(user)` envoie un tel jeton.
`createUser()` crée aussi le workspace personnel, comme en vrai. Des tests vérifient aussi que deux créations simultanées du
même nom ne réussissent jamais toutes les deux, que des appels simultanés ne créent qu'un
workspace personnel, qu'un projet inséré sans `workspace_id` (ancienne API) rejoint le
workspace personnel de son propriétaire, et que `save()` ou `delete()` sur une ligne
d'association ne touche qu'elle.
