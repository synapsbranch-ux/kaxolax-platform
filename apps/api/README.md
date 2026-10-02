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
  - Compte banni (`users.banned_at`, migration `…0023`, posé par l'admin ou par le webhook
    `user.updated` qui porte `banned`) : ses jetons encore valides sont refusés (401
    `E_ACCOUNT_BANNED`). Un webhook daté d'avant l'état reflété (`ban_state_updated_at`) est
    ignoré.
  - Les jetons émis pour l'admin (origine `ADMIN_URL`) sont aussi acceptés (claim `azp`).
- **Préférences** : `GET /me/preferences` renvoie les préférences complètes (thème, tailles des
  colonnes, barre Tools, auto-compilation, options de compilation, onglets ouverts par projet,
  paramètres de l'éditeur réservés à la tâche 10), valeurs par défaut appliquées
  (`DEFAULT_PREFERENCES`, @kaxolax/contracts). `PATCH /me/preferences` fusionne une modification
  partielle (fusion profonde, tableaux remplacés, clé inconnue ou valeur invalide : 422) dans
  `user_preferences` (`INSERT … ON CONFLICT DO NOTHING` puis `FOR UPDATE` : modifications
  simultanées sans perte). Seules les clés changées sont stockées ; JSON borné à 32 Kio, onglets
  mémorisés pour les 20 derniers projets modifiés (numéro d'ordre `usedSeq` posé par l'API). Une
  clé stockée devenue invalide est écartée seule à la lecture, sans effacer les autres.
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
- **Recherche dans tout le projet** : `GET /projects/:id/search?q=&caseSensitive=&wholeWord=&regex=`
  (rôle viewer) cherche dans le texte courant de chaque document (instantané temps réel, sinon
  état enregistré, comme la compilation). Au plus 500 occurrences `{ documentId, path, line,
column, length, preview, previewStart }` (ligne à partir de 1, colonne en unités UTF-16 à
  partir de 0), triées par chemin, avec `truncated`. `q` : 200 caractères au plus ; en mode
  `regex`, expression JavaScript avec le flag `u` (syntaxe invalide : 422
  `E_INVALID_SEARCH_PATTERN`). La boucle tourne dans `vm` avec un délai de 500 ms, dans un
  `worker_threads` (4 au plus par processus, sinon 429 `E_TOO_MANY_SEARCHES`) : une expression
  catastrophique (ReDoS) est interrompue sans bloquer l'API, et la réponse porte `timedOut`. Une
  nouvelle recherche du même utilisateur annule la précédente (409 `E_SEARCH_SUPERSEDED`).
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

- **Compilation** : `POST /projects/:id/compile`, corps facultatif
  `{ options: { draft?, haltOnFirstError? } }` validé par zod (mode brouillon, arrêt à la
  première erreur, transmis tels quels au gateway puis à l'agent) (instantané temps réel + table `files`, envoyé
  au compile-gateway ; résultat enregistré dans `compiles`, URL présignées du PDF et du log),
  `POST /projects/:id/compile/stop`, `GET /projects/:id/compile/last`,
  `POST /projects/:id/compile/clear-cache`.
- **SyncTeX** : `GET /projects/:id/synctex/code` (`file`, `line`, `column`) et
  `GET /projects/:id/synctex/pdf` (`page`, `h`, `v`).
- **Export** : `GET /projects/:id/download.zip`, en streaming, réimportable tel quel ; ou
  `POST /projects/:id/download-url`, un lien chiffré de 60 s pour télécharger par simple
  navigation (`GET /downloads/:token`, rôle revérifié au téléchargement).

- **Bannière système** : `GET /banners/active` (tout compte connecté) renvoie les bannières
  commencées et pas encore terminées, maintenance d'abord. Le web la relit toutes les 60 s et au
  retour sur l'onglet ; `RealtimeClient.notifyBannerChanged`, appelée à chaque création,
  modification ou suppression, sera branchée sur le document meta des projets (tâche 5).
- **Admin** (`/admin/*`, pour `apps/admin`) : middleware `auth` puis `admin`
  (`app/middleware/admin_middleware.ts`) : claim `metadata.role` = `admin` (sinon 403
  `E_ADMIN_REQUIRED`), second facteur vérifié dans la session (claim `fva[1] !== -1`) et MFA
  activée confirmée par l'API Backend de Clerk (`twoFactorEnabled`, rôle relu aussi), en cache
  60 s (sinon 403 `E_ADMIN_MFA_REQUIRED`). Le guard expose les claims vérifiés
  (`auth.use('clerk').getClaimsOrFail()`). Contrats zod : `packages/contracts/src/admin.ts`.
  - Utilisateurs : `GET /admin/users?q=&page=&perPage=` (email, nom, uuid ou id Clerk),
    `GET /admin/users/:id` (plan et limites, projets possédés et partagés, stockage = fichiers
    de ses projets, dernière connexion lue chez Clerk), `POST …/ban`, `…/unban`,
    `…/revoke-sessions`, `DELETE /admin/users/:id` (supprimé chez Clerk puis anonymisé tout de
    suite ; le webhook `user.deleted` qui suit n'a plus d'effet). Bannir : Clerk révoque les
    sessions, `banned_at` est posé et les connexions temps réel fermées
    (`RealtimeClient.disconnectUser`) ; un lien de téléchargement déjà émis ne sert plus.
    Révoquer les sessions : Clerk les révoque, `sessions_revoked_at` est posé (l'API refuse les
    jetons Clerk émis avant, le service temps réel les jetons temps réel émis avant) et les
    connexions temps réel sont fermées. Un admin n'agit pas sur son propre compte (409).
  - Projets : `GET /admin/projects?q=&view=` (nom, email du propriétaire, uuid du projet ou du
    propriétaire), `GET /admin/projects/:id` (tailles, nombres de fichiers, documents et
    dossiers, membres, dernière compilation, workspace ; aucun nom de fichier ni contenu),
    `POST …/transfer` (`newOwnerId`, compte ni supprimé ni banni, sinon 422
    `E_INVALID_NEW_OWNER` : l'ancien propriétaire devient éditeur, le projet rejoint le workspace
    personnel du nouveau), `…/archive`, `…/unarchive`, `…/trash`, `…/restore`,
    `DELETE /admin/projects/:id` (depuis la corbeille).
  - Bannières : `GET/POST /admin/banners`, `PATCH/DELETE /admin/banners/:id` (message, `level`
    info|warning|maintenance, `startsAt` par défaut maintenant, `endsAt` facultative et après
    le début ; dates ISO avec fuseau), `POST /admin/banners/:id/end` (fin à l'heure du serveur ;
    sans effet si déjà terminée, 422 si pas encore commencée).
  - Statistiques : `GET /admin/stats?from=&to=` (30 derniers jours par défaut, 366 au plus) :
    inscriptions par jour UTC, utilisateurs actifs sur 7 et 30 jours (compilation lancée, auteur
    d'une version ou propriétaire d'un projet modifié), abonnés par plan (`active`, `past_due`),
    compilations (volume, statuts, durée moyenne, taux d'échec = statut autre que `success`,
    par agent).
  - Journal : chaque action écrit `admin_audit_log` dans la transaction de son effet ; un échec
    significatif (Clerk en erreur, erreur interne) de toute action (comptes, projets, bannières)
    est journalisé avec `outcome: failure`. Les actions sur un compte n'y gardent que ses
    identifiants (uuid, id Clerk), jamais l'email, que la suppression anonymise. Bannir,
    révoquer les sessions et supprimer un compte ferment ensuite ses connexions temps réel :
    le résultat est une entrée `user.realtime_disconnect` à part (`connectionsClosed`, échec si le
    service n'a pas répondu) et `realtimeDisconnected` dans la réponse (avertissement dans l'admin).
    `GET /admin/audit-log` filtre par `adminId`, `action`, `targetType`, `targetId`, `outcome`,
    `from`, `to`.
  - L'API Backend de Clerk passe par `ClerkBackend` (`app/services/clerk_backend.ts`,
    `CLERK_SECRET_KEY`), résolue par le conteneur : les tests la remplacent par un faux.

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

Admin (`tests/functional/admin_*.spec.ts`, faux Clerk et faux service temps réel dans
`tests/admin.ts`) : refus sans rôle, sans second facteur, sans MFA activée chez Clerk ; journal
de chaque action, échec de Clerk compris ; compte banni refusé (401), webhook `banned` en
retard ignoré ; transfert de propriété ; bannières actives selon leurs dates ; statistiques sur
un jeu de données daté.
