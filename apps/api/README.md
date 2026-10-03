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
  simultanées sans perte). Seules les clés changées sont stockées ; JSON borné à 64 Kio (au-dessus de la somme des pires cas de chaque clé, vérifiée par les tests des contrats ; 422 `E_PREFERENCES_TOO_LARGE`), onglets
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
  (permission `read`) cherche dans le texte courant de chaque document (instantané temps réel, sinon
  état enregistré, comme la compilation). Au plus 500 occurrences `{ documentId, path, line,
column, length, preview, previewStart }` (ligne à partir de 1, colonne en unités UTF-16 à
  partir de 0), triées par chemin, avec `truncated`. `q` : 200 caractères au plus ; en mode
  `regex`, expression JavaScript avec le flag `u` (syntaxe invalide : 422
  `E_INVALID_SEARCH_PATTERN`). La boucle tourne dans `vm` avec un délai de 500 ms, dans un
  `worker_threads` (4 au plus par processus, sinon 429 `E_TOO_MANY_SEARCHES`) : une expression
  catastrophique (ReDoS) est interrompue sans bloquer l'API, et la réponse porte `timedOut`. Une
  nouvelle recherche du même utilisateur annule la précédente (409 `E_SEARCH_SUPERSEDED`).
- **Accès** : toujours par `project_members`. Un projet dont l'utilisateur n'est pas membre
  répond 404 ; un rôle insuffisant, 403 `E_PROJECT_FORBIDDEN`. Chaque route demande une
  permission de la matrice partagée (`packages/contracts/src/permissions.ts`) à
  `projectFor(user, projectId, permission)` :

  | Permission          | owner | editor | reviewer | viewer |
  | ------------------- | :---: | :----: | :------: | :----: |
  | `read`              |   ✓   |   ✓    |    ✓     |   ✓    |
  | `compile`           |   ✓   |   ✓    |    ✓     |   ✓    |
  | `comment`           |   ✓   |   ✓    |    ✓     |        |
  | `edit`              |   ✓   |   ✓    |          |        |
  | `manageMembers`     |   ✓   |        |          |        |
  | `manageShareLinks`  |   ✓   |        |          |        |
  | `transferOwnership` |   ✓   |        |          |        |
  | `manageProject`     |   ✓   |        |          |        |
  | `leave`             |       |   ✓    |    ✓     |   ✓    |

- **Partage** (contrats zod : `packages/contracts/src/sharing.ts` ; erreurs : `SHARING_ERRORS`).
  Routes connectées sauf mention « public » :

  | Route                                                 | Qui                                          | Corps / réponse                                                                                                                                                                                                                              |
  | ----------------------------------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `GET /projects/:id/members`                           | tout membre                                  | `projectMembersResponseSchema` (invitations, `collaborators` et emails des membres pour le propriétaire seulement ; les autres rôles ne voient que leur propre email, `null` ailleurs)                                                       |
  | `PATCH /projects/:id/members/:userId`                 | owner                                        | `{ role }` (editor, reviewer, viewer) → `memberResponseSchema` ; 409 `E_OWNER_ROLE_LOCKED` sur le propriétaire                                                                                                                               |
  | `DELETE /projects/:id/members/:userId`                | owner, ou le membre lui-même (quitter)       | 204 ; 409 `E_OWNER_CANNOT_LEAVE`                                                                                                                                                                                                             |
  | `POST /projects/:id/transfer`                         | owner                                        | `{ userId }` d'un membre existant → `projectMembersResponseSchema` ; 422 `E_INVALID_NEW_OWNER`, 409 `E_ALREADY_OWNER`, 403 `E_PLAN_LIMIT` (plan du nouveau propriétaire)                                                                     |
  | `GET /projects/:id/invitations`                       | owner                                        | `projectInvitationsResponseSchema`                                                                                                                                                                                                           |
  | `POST /projects/:id/invitations`                      | owner                                        | `{ email, role }` → 201 `invitationResponseSchema` (200 si une invitation en attente pour cet email est mise à jour et renvoyée) ; 403 `E_PLAN_LIMIT`, 409 `E_ALREADY_MEMBER`, 429 `E_TOO_MANY_INVITATIONS`, 502 `E_INVITATION_EMAIL_FAILED` |
  | `POST /projects/:id/invitations/:invitationId/resend` | owner                                        | `invitationResponseSchema` ; 429 `E_TOO_MANY_INVITATIONS` (`retryAfterSeconds`)                                                                                                                                                              |
  | `DELETE /projects/:id/invitations/:invitationId`      | owner                                        | 204                                                                                                                                                                                                                                          |
  | `GET /projects/:id/share-links`                       | owner                                        | `shareLinksResponseSchema` (toujours `view` puis `edit`)                                                                                                                                                                                     |
  | `PUT /projects/:id/share-links/:kind`                 | owner                                        | `{ enabled }` → `shareLinkResponseSchema`                                                                                                                                                                                                    |
  | `POST /projects/:id/share-links/:kind/regenerate`     | owner                                        | `shareLinkResponseSchema` (nouveau lien, activé)                                                                                                                                                                                             |
  | `GET /invitations/:token`                             | public                                       | `invitationPreviewSchema` ; 404 `E_INVITATION_NOT_FOUND`, 410 `E_INVITATION_EXPIRED`                                                                                                                                                         |
  | `POST /invitations/:token/accept`                     | compte dont l'email vérifié est celui invité | `joinProjectResponseSchema` (idempotent : invitation déjà acceptée par ce compte → 200 `joined: false`) ; 403 `E_INVITATION_EMAIL_MISMATCH` (`invitedEmailHint`), 410 `E_INVITATION_EXPIRED`                                                 |
  | `GET /share/:token`                                   | public                                       | `shareLinkPreviewSchema` ; 404 `E_SHARE_LINK_NOT_FOUND`                                                                                                                                                                                      |
  | `POST /share/:token/join`                             | tout compte                                  | `joinProjectResponseSchema` ; 403 `E_PLAN_LIMIT`                                                                                                                                                                                             |
  - Invitations : jeton aléatoire de 256 bits, seul son sha256 est stocké ; valable 7 jours ;
    email français par `@adonisjs/mail` (Mailpit en local), lien `${APP_URL}/invitations/<jeton>`
    (`app/mails/project_invitation_mail.ts`). Une relance remplace le jeton (l'ancien lien cesse
    de fonctionner) et repousse l'échéance ; au plus un envoi par minute et 10 envois par
    invitation, 30 créations par heure et par compte, tous projets confondus (`INVITATION_*`
    dans les contrats ; verrou consultatif par compte). Annuler garde la ligne (`cancelled_at`) :
    réinviter la même adresse la réactive (201) sans remettre ces compteurs à zéro, et les
    annulées comptent dans la limite horaire. Si l'email ne part pas (502
    `E_INVITATION_EMAIL_FAILED`), l'envoi est annulé : invitation nouvelle supprimée, sinon
    jeton, échéance, rôle et compteurs d'avant (le lien précédent refonctionne).
  - Sans compte : à la création du miroir Clerk (webhook `user.created` ou création à la volée
    par le guard), les invitations en attente non expirées pour son email vérifié sont acceptées
    (`acceptPendingInvitationsFor`), dans la limite du plan, chacune dans un point de
    sauvegarde : un échec la laisse en attente sans faire échouer la création du compte.
  - Verrous : toujours le projet d'abord, puis l'invitation, le lien ou le membre visé (les
    adhésions par jeton lisent la ligne sans verrou, verrouillent le projet, puis la relisent).
  - Journal : chaque action de partage (rôle changé, retrait, départ, transfert, invitation
    créée, renvoyée, annulée, acceptée, envoi annulé, lien activé, désactivé, régénéré, adhésion
    par lien) écrit une ligne dans `project_sharing_events` (dans la transaction de l'action) et
    une ligne structurée dans le journal applicatif (`app/services/sharing_audit.ts`), jamais de
    jeton, d'URL de lien ni d'email.
  - Limite de collaborateurs : celle du plan du propriétaire (voir **Abonnements** ;
    `app/services/plans.ts`). Comptent les membres autres que le propriétaire et les invitations
    en attente non expirées ; appliquée à l'invitation, à la relance d'une invitation expirée, à
    l'acceptation et à l'adhésion par lien, projet verrouillé. Refus : 403 `E_PLAN_LIMIT`
    (`limit.name` = `collaborators`, `current` = places occupées).
  - Liens de partage : un lien `view` (viewer) et un lien `edit` (editor) par projet. Jeton =
    HMAC-SHA256 (`APP_KEY`) de l'identifiant aléatoire du lien : seul son hash est stocké, mais
    le propriétaire peut réafficher le lien. Désactiver puis réactiver redonne le même lien ;
    régénérer en crée un nouveau (activé) et l'ancien cesse de fonctionner. Changer `APP_KEY`
    invalide tous les liens. Un membre qui rejoint garde le plus élevé de ses deux rôles.
    Une invitation en attente pour l'email du compte qui rejoint par lien est réglée dans la
    même transaction : valide, elle est acceptée (sa place n'est pas comptée deux fois, son rôle
    compte s'il est plus élevé) ; expirée, elle est annulée.
  - Transfert : même logique que l'admin (`app/services/project_ownership.ts`) : l'ancien
    propriétaire devient éditeur, le projet rejoint le workspace personnel du nouveau.
  - Temps réel : après un changement de rôle, un retrait, un transfert ou un rôle relevé par
    un lien ou une invitation, l'API appelle `POST /internal/projects/:id/members/:userId/changed`
    (`RealtimeClient.membersChanged`) : connexions fermées (retrait) ou passées en lecture seule
    ou en écriture, en moins de 2 s.
  - Pour l'interface (après la tâche 3) : pages `/invitations/[token]` (aperçu public, puis
    acceptation une fois connecté ; afficher `invitedEmailHint` en cas de 403). Après une
    inscription depuis cette page, l'invitation est souvent déjà acceptée automatiquement :
    l'aperçu renvoie `accepted: true` et `POST /invitations/:token/accept` répond quand même
    200 (`joined: false`, `projectId`, rôle actuel) au compte invité ; la page redirige vers
    `/project/<projectId>`. Pour un autre compte, une invitation acceptée donne 404. Et
    `/share/[token]` (aperçu, puis `join`) ; modale de partage sur `members`, `invitations` et
    `share-links`. `E_PLAN_LIMIT` : message avec le maximum et lien vers les tarifs. Message
    sans état `member.role-changed` (`roleChangedMessageSchema`) sur une connexion temps réel :
    passer l'éditeur en lecture seule ou en écriture ; au retour en écriture, rouvrir le
    document (les frappes refusées pendant la lecture seule bloqueraient les suivantes).

- **Chat du projet** (contrats zod : `packages/contracts/src/chat.ts` ; `app/services/chat_service.ts`) :
  tout membre, lecteur compris, lit et écrit (permission `read`).
  - `GET /projects/:id/chat/messages` : les 50 plus récents (`limit` ≤ 100), ou ceux d'avant
    `before` / d'après `after` (id d'un message ; un seul curseur, 404 `E_CHAT_MESSAGE_NOT_FOUND`
    s'il n'est pas dans le projet). Ordre total (date, id), du plus ancien au plus récent,
    `hasMore`, et les non-lus (`unread.count`, `unread.lastReadAt`).
  - `POST /projects/:id/chat/messages` (`{ body }`, 1 à 4000 caractères après `trim`, texte brut) :
    201, puis `chat.message-created` publié sur le document meta. Limite : 20 messages par
    membre et par projet sur 60 s glissantes, sous verrou consultatif du projet ; 429
    `E_CHAT_RATE_LIMITED` (`retryAfterSeconds`, en-tête `Retry-After`).
  - `POST /projects/:id/chat/read` (`{ upTo? }`) : dernière lecture (`chat_reads`) portée au
    message `upTo`, ou à maintenant ; elle ne recule jamais. Non-lus = messages des autres
    postérieurs à la dernière lecture, ou à l'arrivée dans le projet si le chat n'a jamais été
    ouvert.
  - Mentions : `<@uuid>` dans le texte. Email français (`ChatMentionMail`, lien
    `/project/<id>?panel=chat`) aux membres actifs mentionnés, sauf l'auteur, seulement pour la
    première mention non lue depuis leur dernière lecture (au plus un email par visite manquée).
    Envoi après la validation, au mieux : un échec est journalisé, le message reste envoyé.

- **Commentaires ancrés** (contrats zod : `packages/contracts/src/comments.ts` ;
  `app/services/comment_service.ts`) : lecture par tout membre (`read`) ; nouveau fil, réponse,
  résolution et réouverture avec la permission `comment` (owner, editor, reviewer ; 403
  `E_PROJECT_FORBIDDEN` pour un lecteur) ; modification et suppression de son propre message
  seulement (403 `E_COMMENT_NOT_AUTHOR`), tant que son rôle commente.
  - `GET /projects/:id/comment-threads` (`documentId?`, `status` `open` | `resolved` | `all`) et
    `GET …/:threadId` : fils avec leurs messages (du plus ancien au plus récent), ancre en
    base64, citation d'origine, résolution (date, auteur). Un message supprimé garde sa place,
    `body: null`.
  - `POST /projects/:id/comment-threads` (`{ documentId, anchor, quotedText, body }`) : 201.
    L'ancre (deux positions relatives Yjs, `@kaxolax/collab` anchors) est stockée telle quelle
    dans `comment_threads.anchor` après vérification de son format (422
    `E_COMMENT_INVALID_ANCHOR`) ; le document doit appartenir au projet (404
    `E_DOCUMENT_NOT_FOUND`). Citation : 1 à 1000 caractères ; message : 1 à 4000.
  - `POST …/:threadId/comments` (réponse, 201), `PATCH` et `DELETE …/comments/:commentId`
    (texte effacé en base, `deleted_at` ; le fil disparaît avec son dernier message visible),
    `POST …/:threadId/resolve` et `…/reopen` (idempotents). Réponse : le fil à jour, ou
    `{ thread: null }` s'il a été supprimé.
  - Événements après la validation : `comment.created` (nouveau fil ou réponse) et
    `comment.thread-updated` (`change` : `comment-edited`, `comment-deleted`, `resolved`,
    `reopened`, `deleted`). Limite : 30 messages par membre et par projet sur 60 s (429
    `E_COMMENT_RATE_LIMITED`, `retryAfterSeconds`).
  - Mentions `<@uuid>` (format du chat) : email français (`CommentMentionMail`, citation,
    extrait, lien `/project/<id>?comment=<threadId>`) aux membres actifs mentionnés, sauf
    l'auteur ; au plus un email par personne et par projet toutes les 10 minutes (date du dernier
    email dans `project_members.comment_mention_emailed_at`, migration `…0029`). Une mention ajoutée en modifiant un message ne notifie
    pas. Envoi au mieux, après la validation.

- **Historique du projet** (contrats zod : `packages/contracts/src/history.ts` ;
  `app/services/history_service.ts`, `history_restore.ts`, `history_scheduler.ts`) : lecture par
  tout membre (`read`) ; label et restauration avec la permission `edit` (owner, editor).
  - Une version est créée après 2 minutes sans modification du projet (`auto`, balayage du
    processus web toutes les `HISTORY_SWEEP_SECONDS` ; un projet en échec est retenté après
    `HISTORY_RETRY_SECONDS` sans bloquer les autres), à chaque compilation manuelle (`compile`,
    synchrone et asynchrone, d'un owner ou editor, une fois la compilation acceptée ;
    `trigger: 'auto'` n'en crée pas), avant chaque restauration (`restore` : l'état remplacé) et
    juste après une restauration réussie (`restored` : l'état restauré, migration `…0150`). Rien
    n'est créé si rien n'a changé depuis la précédente. Verrou consultatif
    PostgreSQL par projet et condition revérifiée sous ce verrou : une seule version, quel que
    soit le nombre d'instances.
  - Auteurs (`author_ids`) : comptes dont des mises à jour Yjs entrent dans la version, lus dans
    le journal `document_updates` (migration `…0028`) écrit par le service temps réel ; la
    création d'un document par l'API (création, upload, import) y entre au nom de son auteur. La
    version `restored` compte toujours la personne qui restaure (même pour un binaire seul).
  - Stockage objet : manifeste (`history/versions/<id>/manifest.json.gz` : arborescence, document
    principal, changements), diff attribué de chaque document modifié (`diffs/<documentId>.json.gz`)
    et texte compressé adressé par sha256 (`history/texts/<sha256>.gz`, partagé entre versions,
    référencé par `version_documents`, qui cite aussi le dernier texte des documents qu'une
    version montre supprimés : leur diff survit à la purge des versions précédentes). Les binaires restent à leur clé, référencés par
    `version_files` : leur objet n'est supprimé (suppression dans l'arborescence, purge) que si
    plus aucune version ni l'arborescence n'y fait référence.
  - `GET /projects/:id/versions` (`before`, `limit`), `GET …/versions/:versionId` (fichiers et
    changements), `GET …/documents/:documentId/diff` (segments `equal` / `insert` / `delete`
    avec `authorId`), `GET …/files/:fileId/url` (aperçu d'un binaire), `PATCH …/versions/:versionId`
    (`{ label }`), `POST …/restore` (`{ scope: 'project' }` ou `{ scope: 'entry', entryId }`),
    `GET …/download.zip` ou `POST …/download-url` (lien de 60 s, `GET /version-downloads/:token`).
  - Restauration : version de l'état courant d'abord, puis texte des documents existants remplacé
    par le service temps réel (modification Yjs minimale reçue par les clients connectés), puis
    arborescence remise exactement dans l'état de la version (documents et fichiers recréés avec
    leur identifiant, déplacés ou supprimés, dossiers, document principal) ; événement
    `tree.changed` (`reason: 'restore'`), puis version `restored` de l'état restauré, au mieux
    (`restoredVersionId` de la réponse : null si rien n'a changé ou en cas d'échec, que le
    balayage rattrape). Verrou de l'historique pris avant la ligne du projet
    (même ordre que la création d'une version). Si un remplacement de texte ou la transaction de
    l'arborescence échoue, les textes déjà remplacés sont remis dans l'état de la version de
    sauvegarde : 503 `E_HISTORY_REALTIME_UNAVAILABLE`, rien n'est modifié ; si cette remise
    échoue aussi, 503 `E_HISTORY_RESTORE_INCOMPLETE` (projet partiellement restauré : relancer la
    restauration). Fichier seul : recréé à son chemin s'il a disparu ; un document ou un fichier
    qui occupe ce chemin est remplacé (il reste dans la version de sauvegarde), un dossier donne
    409 `E_RESTORE_PATH_TAKEN`. Les fils de commentaires des documents retirés sont supprimés
    (ils ne font pas partie des versions) : le dialogue de restauration le signale. Stockage du
    plan du propriétaire (tâche 12) : un texte restauré plus long que l'état enregistré est
    vérifié avant tout remplacement, et ce que l'arborescence recrée (documents, binaires) dans la
    transaction ; au-delà, 403 `E_PLAN_LIMIT` et rien n'est modifié (textes remis en état).
  - Purge (toutes les `HISTORY_PURGE_SECONDS`) : versions sans label plus anciennes que la
    conservation du plan du propriétaire (`historyRetention(owner)` de
    `app/services/entitlements.ts`, tâche 12), jamais la plus récente ni une version avec label.

- **Temps réel** : `POST /projects/:id/realtime-token` signe un jeton de 5 minutes pour le
  service `apps/realtime` (`REALTIME_TOKEN_SECRET`, `REALTIME_PUBLIC_URL`), valable pour les
  documents du projet et pour son document meta (`project:{id}:meta`). `POST /me/realtime-token`
  (tout compte connecté) signe le jeton du canal du compte (`user:{id}`, `scope: 'user'`,
  `userRealtimeTokenResponseSchema` avec le nom du canal) : il n'ouvre aucun document de projet. À la suppression
  d'un document, d'un dossier ou d'un projet, l'API demande au service de fermer les connexions
  ouvertes (`REALTIME_INTERNAL_URL`, `INTERNAL_TOKEN`), au mieux et avec un délai de 2 s.
- **Événements du projet** (`packages/contracts/src/events.ts`) : après la validation de sa
  transaction, l'API publie sur le document meta du projet (`RealtimeClient.publishProjectEvent`,
  route interne `POST /internal/projects/:id/events`), au mieux (échec journalisé, la requête
  réussit quand même) :
  - `tree.changed` pour chaque écriture de l'arborescence, avec ce qui a changé : création de
    dossier ou de document (`create`), renommage (`rename`), déplacement (`move`), suppression
    (`delete`, le dossier racine supprimé), upload (`upload`), import zip (`import`, projet neuf,
    liste vide) et document principal (`main-document`, `mainDocumentId`) ;
  - `member.added` (arrivée par lien ou invitation, y compris les invitations acceptées d'office
    à l'inscription, par le webhook `user.created` ou le guard), `member.removed` (retrait,
    départ, compte supprimé par le webhook `user.deleted` ou l'admin) et
    `member.role-updated` (changement de rôle, rôle relevé, transfert : deux événements), en
    plus de `RealtimeClient.membersChanged` ;
  - `banner.changed` à tous les clients connectés (`RealtimeClient.broadcastEvent`, route
    `POST /internal/events`), depuis `notifyBannerChanged`.
    Une requête refusée ne publie rien. Les helpers des membres sont dans
    `app/services/project_events.ts`. `chat.message-created` (chat), `comment.created` et
    `comment.thread-updated` (commentaires) sont publiés par leurs contrôleurs ;
  - `compile.updated` (`buildId`, `status`, `result` une fois terminée) à chaque étape d'une
    compilation asynchrone (voir **Compilation**). `RealtimeClient` passe chaque événement par
    `fitProjectEvent` : un résultat qui ferait dépasser 1 Mio au corps de la requête est retiré
    (`resultOmitted: true`), le client le relit par `GET /projects/:id/builds/:buildId`.

- **Uploads** : `POST /projects/:id/uploads` renvoie une URL de PUT présignée (taille signée),
  puis `POST /projects/:id/uploads/:uploadId/complete` vérifie l'objet et crée un document texte
  ou un fichier binaire (`@kaxolax/upload-processor`). `GET /projects/:id/files/:fileId/url`
  donne une URL de lecture de 5 minutes (`?download=true` pour télécharger).
- **Import zip** : `POST /imports`, puis `POST /imports/:uploadId/complete` crée le projet
  (`@kaxolax/zip-importer`), dans le workspace `workspaceId` (facultatif) ou le workspace
  personnel.
- **Configuration du navigateur** : `GET /client-config` (public, `Cache-Control: no-store`,
  `clientConfigSchema`) rend `realtimeUrl` (`REALTIME_PUBLIC_URL`), `storageUrl` (origine des URL
  présignées : `S3_PUBLIC_ENDPOINT`, sinon `S3_ENDPOINT`, sinon point d'accès régional AWS) et
  `templateUrls` (`TEMPLATES_CATALOG_URL`, base des fichiers). Le serveur web y lit les origines
  de sa CSP qu'il n'a pas reçues en variables.
- **Galerie de templates** (contrat : `packages/contracts/src/templates.ts`) : catalogue
  `templates.json` v1 publié par le dépôt kaxolax-templates sur un bucket R2 public (format :
  README de ce dépôt, « Contrat du catalogue »), lu à `TEMPLATES_CATALOG_URL`
  (`app/services/template_catalog.ts`). Validation zod stricte des valeurs (un template invalide
  fait refuser tout le catalogue ; champs inconnus ignorés, comme le prévoit le contrat), copie en
  mémoire servie 60 s puis revalidée par requête conditionnelle (`If-None-Match`,
  `If-Modified-Since`) ; catalogue injoignable ou invalide : dernière copie valide servie jusqu'à
  24 h (nouvel essai toutes les 30 s), sinon 503 `E_TEMPLATES_UNAVAILABLE`. Sans
  `TEMPLATES_CATALOG_URL`, hors production seulement : catalogue de démonstration
  `resources/templates.fixture.json` (métadonnées des dix templates de départ, fichiers non
  publiés : URL nulles, création refusée en 503).
  - `GET /templates?q=&category=&language=&compiler=` (public, `Cache-Control: max-age=60`) :
    fiches (métadonnées, URL publiques de la miniature et du PDF sous `TEMPLATES_PUBLIC_URL`,
    défaut le dossier du catalogue, suffixées de `?v=<sha256 court>`), compteurs par catégorie.
    Recherche par mots (préfixes, sans accents) dans titre, description, mots-clés et id
    (`filterTemplates`, partagée avec le web). `GET /templates/:id` : une fiche (404
    `E_TEMPLATE_NOT_FOUND`).
  - `POST /projects/from-template` `{ templateId, name?, workspaceId? }` (authentifié) :
    workspace et stockage du plan vérifiés avant tout téléchargement, zip téléchargé (60 s au
    plus, lecture interrompue au-delà de la taille annoncée) puis comparé à `bytes` et `sha256`
    du catalogue (502 `E_TEMPLATE_INTEGRITY`, ou `E_TEMPLATE_DOWNLOAD_FAILED`), puis même
    création que l'import zip (`createProjectFromZip` : stockage revérifié sur le contenu
    extrait), nom par défaut le titre du template, compilateur et document principal repris du
    catalogue. 201 `{ project }`, événement `tree.changed`.

- **Compilation** : `POST /projects/:id/compile`, corps facultatif
  `{ options: { draft?, haltOnFirstError? } }` validé par zod (mode brouillon, arrêt à la
  première erreur, transmis tels quels au gateway puis à l'agent) (instantané temps réel + table `files`, envoyé
  au compile-gateway ; résultat enregistré dans `compiles`, URL présignées du PDF et du log),
  `POST /projects/:id/compile/stop`, `GET /projects/:id/compile/last`,
  `POST /projects/:id/compile/clear-cache`. Permissions de la matrice : `compile` pour lancer,
  arrêter, vider le cache, SyncTeX et le réveil du compilateur (tous les rôles aujourd'hui) ;
  `read` pour la dernière compilation et l'état d'une compilation. Mode `COMPILE_BACKEND=cloudflare` (production) :
  `POST /projects/:id/compile` répond 202 `{ buildId, status }` (`queued`, ou `preparing` si le
  conteneur se réveille ; état initial, que le client ignore s'il a déjà reçu un événement du
  même `buildId`), le Worker (`apps/compile-worker`) rappelle
  `POST /internal/compile-callbacks` (HMAC, horodatage, `seq` anti-rejeu) et le service temps
  réel diffuse l'événement `compile.updated` sur le document meta du projet (même route et même
  enveloppe que les autres événements du projet) ; repli par sondage
  `GET /projects/:id/builds/:buildId`, qui clôt aussi en `error` une compilation restée sans
  nouvelles du Worker au-delà de son timeout + 5 min (entrée de log « The compiler did not
  respond in time »). `POST /projects/:id/compiler/warm`
  réveille le conteneur du projet à l'ouverture de l'éditeur. Une compilation active à la fois
  par projet (409 `E_COMPILE_IN_PROGRESS`) ; au plus 5 projets réveillés par utilisateur sur
  15 min (429 `E_TOO_MANY_COMPILERS`) ; le réveil ne refuse jamais et ne prend pas le dernier
  emplacement libre, gardé pour une vraie compilation (`{ status: 'skipped' }`).
  Chaque demande (synchrone et asynchrone) porte `timeoutMs`, la durée maximale du plan du
  propriétaire du projet (20 s Free, 240 s Pro) ; un résultat `timeout` sous une limite qu'un
  plan supérieur lève porte `planLimit` (corps `E_PLAN_LIMIT`, `compile_time`).
- **SyncTeX** : `GET /projects/:id/synctex/code` (`file`, `line`, `column`) et
  `GET /projects/:id/synctex/pdf` (`page`, `h`, `v`).
- **Compteur de mots** : `POST /projects/:id/word-count` (permission `compile`, lecteurs
  compris), corps facultatif `{ documentId }` (défaut : le document principal). texcount tourne
  dans le sandbox de compilation (`-merge -sub=section`) sur ce document et les documents
  `.tex`/`.ltx` du projet qu'il inclut (texte courant, instantané temps réel) : par le gateway
  (mode `gateway`), ou par le Worker et le conteneur du projet (mode `cloudflare`, réveillé au
  besoin, jusqu'à 95 s, compté dans le plafond de compilateurs). Réponse
  (`wordCountResponseSchema`) : `total` (`words` = `text` + `headers` + `captions`, nombre de
  titres, flottants, formules), `sections` (partie, chapitre, section, documents inclus à leur
  place), `warnings` de texcount, `rootResourcePath`, `durationMs`. 422 `E_NO_MAIN_DOCUMENT` ou
  `E_WORD_COUNT_FAILED` (délai de 20 s, document illisible, plus de 16 Mo de texte), 429
  `E_WORD_COUNT_BUSY`, 503 `E_COMPILE_UNAVAILABLE` (dont file d'attente de l'agent pleine). Au
  plus un comptage en cours par utilisateur et projet (la même demande attend le comptage en
  cours et reçoit son résultat, un autre document répond 429) et 2 par utilisateur, par
  instance de l'API.
- **Index des packages TeX Live** (`packages/contracts/src/texlive.ts`, tout compte connecté) :
  - `GET /texlive/packages?q=&category=&topic=&page=&perPage=` : recherche (tous les mots, dans
    le nom, les fichiers `.sty`/`.cls` et la description ; le package qui fournit `<q>.sty` en
    premier), catégorie TeX Live (`Package`, `ConTeXt`, `TLCore`), sujet CTAN (`maths`…),
    pagination (100 au plus). Chaque package : nom, description, catégorie, sujets, liens CTAN et
    texdoc, noms à passer à `\usepackage` (10 premiers) ; avec `q`, `matchingUsepackage` donne
    tous ceux qui contiennent un mot cherché (`typear` → `typearea` de koma-script).
  - `GET /texlive/packages/:name` : fiche complète, par nom TeX Live (`graphics`) ou de fichier
    `.sty` (`graphicx`) ; 404 `E_PACKAGE_NOT_FOUND`.
  - `GET /texlive/suggestions?name=` : noms proches d'un package ou d'une classe introuvable
    (`amsmth`, ou le `missingFile` d'une entrée du log, 255 caractères au plus : `amsmth.sty`, `artcle.cls`) : distance
    de Damerau-Levenshtein (1 à 3 fautes selon la longueur, casse ignorée) ou préfixe, packages
    courants d'abord à distance égale ; `exists` si le fichier est dans TeX Live mais absent de
    l'image de compilation.
  - Source : l'index publié par kaxolax-texlive-images (`texlive/<année>/packages.json`) dans le
    bucket `TEXLIVE_INDEX_BUCKET` (clé `TEXLIVE_INDEX_KEY`, défaut `texlive/2026/packages.json`),
    lu avec les clés `S3_*`, gardé en mémoire et revalidé toutes les heures par une lecture
    conditionnelle sur l'ETag (en arrière-plan ; en cas d'échec, la copie en mémoire sert
    encore). Sans copie en mémoire (clé absente, panne), un échec donne 503
    `E_PACKAGE_INDEX_UNAVAILABLE` sans relire le stockage pendant une minute. Sans bucket : la fixture `resources/fixtures/texlive-packages.json` (73 packages
    réels de TeX Live 2026) en développement et en test, 503 `E_PACKAGE_INDEX_UNAVAILABLE` en
    production. Réponses avec ETag (index + URL) et `Cache-Control: private, max-age=3600` ;
    `If-None-Match` donne 304.
- **Export** : `GET /projects/:id/download.zip`, en streaming, réimportable tel quel ; ou
  `POST /projects/:id/download-url`, un lien chiffré de 60 s pour télécharger par simple
  navigation (`GET /downloads/:token`, rôle revérifié au téléchargement).

- **Bannière système** : `GET /banners/active` (tout compte connecté) renvoie les bannières
  commencées et pas encore terminées, maintenance d'abord. Le web la relit toutes les 60 s, au
  retour sur l'onglet et à chaque reconnexion de son canal temps réel ;
  `RealtimeClient.notifyBannerChanged`, appelée à chaque création, modification ou suppression,
  diffuse aussi `banner.changed` en direct à toutes les pages connectées (canal `user:{id}` de
  chaque compte) et aux documents meta des projets ouverts, sur toutes les instances du service.
- **Abonnements (Clerk Billing)** (contrats : `packages/contracts/src/billing.ts`).
  - Droits (`app/services/entitlements.ts`) : plan et features lus dans les claims `pla`
    (`u:pro`) et `fea` (`u:long_compile,…`) du jeton vérifié (`has({ plan })`/`has({ feature })`,
    même lecture que Clerk, portées `u`/`ou`/`uo`), posés sur l'utilisateur de la requête par le
    guard ; sinon la plus récente de deux sources enregistrées : relevé des claims du dernier
    jeton du compte (`users.claimed_plan_slug`, `claimed_plan_features`, `claimed_plan_at` =
    `iat`, écrit par le guard, ignoré après 35 jours) ou miroir `subscriptions` (élément
    `active` ou `past_due`, ou `canceled` jusqu'à `period_end` ; plan payant d'abord) ; sinon
    `free`. Valeurs chiffrées : `plan_limits` par
    slug (cache de 60 s ; plan inconnu = limites de Free). Une feature absente ramène sa limite
    à la valeur de Free ; sans claims, les features se déduisent des valeurs du plan.
  - Les limites d'une action sur un projet sont celles de son propriétaire : claims du jeton
    s'il agit lui-même, sinon relevé de ses claims ou miroir, le plus récent
    (`app/services/plan_enforcement.ts`). L'invitation (claims du propriétaire) et son
    acceptation (par l'invité) lisent donc le même plan, même si un webhook manque.
  - Limites appliquées : durée de compilation (`timeoutMs` de chaque demande), collaborateurs,
    stockage (fichiers + états Yjs des projets possédés ; création de document, de projet,
    début et fin d'upload, début et fin d'import zip ; verrou
    consultatif par compte ; éditions temps réel : lecture seule tant que le stockage du
    propriétaire est plein, appliquée par `apps/realtime/src/storage.ts`, dépassement borné à
    l'intervalle d'enregistrement), transfert de propriété (propriétaire ou admin : le projet
    doit tenir dans le stockage et la limite de collaborateurs du nouveau propriétaire, ancien
    propriétaire devenu éditeur compris),
    historique (`historyRetention(account)` pour la tâche 8, jours ou null). Refus homogène :
    403 `{ code: 'E_PLAN_LIMIT', message, limit: { name, plan, max }, feature, current?,
upgradeUrl }` (`app/exceptions/plan_limit.ts`).
  - `GET /me/plan` : plan, source (`claims`, `subscription`, `default`), features, limites,
    usage (stockage, plus grand nombre de collaborateurs d'un projet), élément d'abonnement,
    URL des tarifs. Affichage seulement.
  - Webhooks `subscription.*` et `subscriptionItem.*` sur `POST /webhooks/clerk`
    (`app/services/billing_webhooks.ts`) : chaque élément est reflété dans `subscriptions`
    (plan, statut, `period_end`), `updated_at` = horodatage Clerk de l'événement (enveloppe
    `timestamp`) : un événement plus ancien n'écrase pas un état plus récent. Payeur pas encore
    connu : 409 `E_BILLING_PAYER_UNKNOWN` (rien d'enregistré, Clerk réessaie) ; payeur
    organisation ignoré. Emails (`app/mails/billing_mails.ts`, français) après validation, un
    par transition : bienvenue quand un plan payant devient `active` (pas après un retard de
    paiement ni une résiliation annulée), paiement en retard à l'entrée en `past_due`.
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
    personnel du nouveau ; 403 `E_PLAN_LIMIT` si le projet dépasse le stockage ou la limite de
    collaborateurs du plan du nouveau propriétaire), `…/archive`, `…/unarchive`, `…/trash`, `…/restore`,
    `DELETE /admin/projects/:id` (depuis la corbeille).
  - Bannières : `GET/POST /admin/banners`, `PATCH/DELETE /admin/banners/:id` (message, `level`
    info|warning|maintenance, `startsAt` par défaut maintenant, `endsAt` facultative et après
    le début ; dates ISO avec fuseau), `POST /admin/banners/:id/end` (fin à l'heure du serveur ;
    sans effet si déjà terminée, 422 si pas encore commencée).
  - Statistiques : `GET /admin/stats?from=&to=` (30 derniers jours par défaut, 366 au plus) :
    inscriptions par jour UTC, utilisateurs actifs sur 7 et 30 jours (compilation lancée, auteur
    d'une version ou propriétaire d'un projet modifié), abonnés par plan (`active`, `past_due`),
    compilations terminées (volume, statuts finaux, durée moyenne, taux d'échec = statut
    terminé autre que `success`, par agent) ; les compilations asynchrones en cours (`queued`,
    `preparing`, `running`) sont ignorées et les annulations comptées à part (`cancelled`).
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
dans `app/models` : `project_invitations` (+ `last_sent_at`, `send_count`, migration `…0024` ; + `cancelled_at`,
migration `…0025`), `project_sharing_events` (journal du partage, sans clé étrangère, `…0025`), `share_links`, `project_versions`, `version_files`,
`comment_threads`, `comments`, `chat_messages`, `chat_reads`, `user_preferences`, `plan_limits`
(historique : + `document_updates`, `version_documents`, `projects.history_synced_at`, migration `…0028`)
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

Galerie (`tests/functional/templates.spec.ts`) : catalogue de démonstration, recherche et
filtres, faux bucket public (serveur HTTP local) pour la revalidation (304), le repli sur la
dernière copie valide, le 503 sans copie, la création d'un projet (compilateur et document
principal du catalogue) et les refus (zip modifié ou trop long, zip absent, workspace d'un autre
compte, stockage plein, aucun téléchargement pour une demande refusée).

Abonnements (`tests/unit/entitlements.spec.ts`, `tests/functional/billing.spec.ts`) : lecture
des claims `pla`/`fea`, repli sur le miroir, cache de `plan_limits`, chaque limite Free et Pro
(durée de compilation envoyée, y compris par un collaborateur, stockage, collaborateurs,
transfert de propriété, invitation acceptée sous le plan relevé dans les claims du propriétaire),
webhooks rejoués ou désordonnés sans effet, un email par transition, payeur inconnu.

Admin (`tests/functional/admin_*.spec.ts`, faux Clerk et faux service temps réel dans
`tests/admin.ts`) : refus sans rôle, sans second facteur, sans MFA activée chez Clerk ; journal
de chaque action, échec de Clerk compris ; compte banni refusé (401), webhook `banned` en
retard ignoré ; transfert de propriété ; bannières actives selon leurs dates ; statistiques sur
un jeu de données daté.

Événements du projet (`tests/functional/project_events.spec.ts`, faux service temps réel qui
valide chaque événement avec le schéma de la route interne) : un événement par création,
renommage, déplacement, suppression, upload, import et changement de document principal, avec
ce qui a changé ; aucun pour une requête refusée ; événements des membres (rôle, retrait,
transfert, arrivée par lien) ; appels HTTP du vrai client et absence d'échec si le service est
injoignable.
