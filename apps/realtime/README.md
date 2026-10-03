# @kaxolax/realtime

Service d'édition collaborative (Hocuspocus + Yjs). Chaque document texte est un `Y.Doc` qui
contient un seul `Y.Text` nommé `content`, sous le nom `project:{projectId}:doc:{documentId}`
(voir `@kaxolax/collab`). Chaque projet a aussi un document meta, `project:{projectId}:meta`
(`metaDocumentName`), sans contenu : présence globale et événements du projet. Chaque compte
connecté a enfin son canal, `user:{userId}` (`userChannelName`), sans contenu ni présence :
événements diffusés à tous (bannière système), sur toutes les pages de l'application.

## Connexion

1. Le navigateur demande un jeton à l'API : `POST /api/v1/projects/:id/realtime-token` renvoie
   `{ token, url, expiresAt }` (5 minutes).
2. Il ouvre `url` avec `HocuspocusProvider`, le nom du document et ce jeton.
3. Le service vérifie la signature et l'expiration, puis que le document appartient au projet
   du jeton, qu'il existe et que l'utilisateur est membre. Le rôle est relu en base (celui du
   jeton n'est pas cru) : selon la matrice de `@kaxolax/contracts` (`canEdit`), owner et editor
   écrivent, viewer et reviewer sont en lecture seule (`connection.readOnly`).

## Permissions sur les connexions ouvertes

Toute la logique est dans `src/access.ts` :

- Chaque message de synchronisation porteur de modifications passe par `beforeSync`. Sur une
  connexion en lecture seule, Hocuspocus rejette la mise à jour ; elle est journalisée et la
  connexion fermée (code 4403) au bout de `MAX_REJECTED_UPDATES` (5) rejets. Pour un rédacteur,
  le rôle est relu en base si la dernière lecture date de plus de `ROLE_RECHECK_MS` (5 s) : un
  rôle abaissé passe la connexion en lecture seule avant que la mise à jour ne s'applique.
- `POST /internal/projects/:id/members/:userId/changed` (appelée par l'API après un changement
  de rôle, un retrait ou un transfert) relit le rôle et l'applique aussitôt aux connexions de
  ce membre sur le projet : fermeture (4403) s'il n'est plus membre, sinon lecture seule ou
  écriture et message sans état `member.role-changed` (`roleChangedMessageSchema`).
- Toutes les `ROLE_SWEEP_MS` (30 s), le rôle de toutes les connexions est relu : filet si une
  notification de l'API s'est perdue ; un balayage ne démarre pas tant que le précédent tourne.
- Lectures concurrentes du rôle (mise à jour, notification, balayage) : chacune prend un numéro
  avant sa requête et n'est appliquée que si elle est plus récente que la dernière appliquée à la
  connexion ; une lecture lancée avant un changement ne peut donc pas rendre l'écriture.
- Plusieurs instances : la route applique le changement sur l'instance appelée puis le publie
  par un `MemberChangeFanout` ; avec Redis, son abonnement appelle `applyMemberChange` sur
  chaque autre instance (voir « Plusieurs instances »).

## Document meta, événements et présence

- Autorisation identique aux documents du projet (jeton du projet, rôle relu en base, tout
  membre) ; la connexion est toujours en lecture seule, même pour owner et editor (un
  changement de rôle n'y change rien) : les clients n'y écrivent que l'awareness. Toute mise à
  jour Yjs de contenu est rejetée et comptée comme ci-dessus (fermeture au 5e rejet). Rien n'est
  jamais enregistré en base pour ce document.
- Événements : messages sans état `projectEventMessageSchema` (`@kaxolax/contracts`, events :
  `{ kind: 'project-event', v: 1, sentAt, event }`) envoyés à chaque connexion des documents
  meta, publiés par l'API (`POST /internal/projects/:id/events`, ou `POST /internal/events`
  pour tous les projets, réservé à `banner.changed`). Les clients les lisent avec
  `parseProjectEventMessage` et ignorent le reste (dont `member.role-changed`). Les changements
  d'état des compilations asynchrones (`compile.updated`, tâche 14) suivent le même chemin ; le
  corps d'une requête interne est limité à 1 Mio (`MAX_PROJECT_EVENT_BYTES`), l'API retirant au
  besoin le résultat de compilation (`resultOmitted`).
- Présence : le hook `beforeHandleAwareness` (`src/presence.ts`) impose dans chaque état reçu
  d'une connexion l'identité `user` de son utilisateur (`presenceUserFor` : id, nom complet et
  photo de profil https lus en base, jamais l'email : « Collaborateur » sans nom complet ;
  couleur dérivée de l'id comme dans packages/ui) ; un état qui n'est pas un objet est ignoré,
  comme un clientId Yjs déjà tenu par une autre connexion de l'instance ou par un autre
  utilisateur sur une autre instance (relayé par Redis) ; un clientId inconnu est accepté. Les clients valident chaque état reçu avec
  `parsePresenceState` (`presenceStateSchema` : `user`, `documentId` sur le meta, `cursor` sur
  un document texte, au format de y-codemirror.next).

## Canal de l'utilisateur

`src/user-channel.ts` : document `user:{userId}` ouvert par la bannière système du web sur toutes
les pages connectées.

- Jeton `POST /api/v1/me/realtime-token` de l'API (`scope: 'user'`, 5 minutes,
  `signUserRealtimeToken` de `@kaxolax/collab/token`) : il n'ouvre que le canal de son titulaire,
  et un jeton de projet n'ouvre jamais un canal (charges utiles disjointes). Compte banni,
  supprimé ou dont les sessions ont été révoquées après l'émission du jeton
  (`DocumentStore.accountActive`) : refusé à l'authentification, revérifié à l'attache et à
  chaque balayage (`ROLE_SWEEP_MS`), fermé (4403) par `POST /internal/users/:id/disconnect`
  (compté dans `connections`).
- Lecture seule, rien n'est enregistré ni journalisé ; toute mise à jour Yjs est refusée et la
  connexion fermée au 5e refus ; l'awareness reçue est ignorée.
- Les événements diffusés à tous (`POST /internal/events`, `banner.changed`) sont envoyés à chaque
  canal ouvert, au format des événements du document meta (`projectEventMessageSchema`), sur
  chaque instance (bus Redis, comme pour les documents meta).

## Plusieurs instances

Avec `REDIS_URL` (`redis://` ou `rediss://`), deux mécanismes, sous le préfixe `REDIS_PREFIX` :

- l'extension Redis de Hocuspocus (`@hocuspocus/extension-redis`) synchronise les documents
  chargés, leur awareness et leurs messages sans état diffusés, et verrouille l'écriture en base
  d'un document ouvert sur plusieurs instances ;
- un bus pub/sub (`src/cluster.ts`, canal `{prefix}:cluster`) relaie ce qui ne dépend pas d'un
  document chargé ici : changements de membres, fermeture des connexions d'un compte ou d'un
  document supprimé, événements du projet, et départ d'une connexion (`awareness-departed` :
  ses clientIds, retirés de l'awareness des autres instances ; l'extension Redis ne transmet pas
  ce retrait, qui attendrait sinon l'expiration de 30 s). L'instance appelée par l'API applique l'effet chez
  elle (le nombre renvoyé ne compte qu'elle) puis publie ; chaque autre instance l'applique à la
  réception et ignore ses propres messages. Les événements sont envoyés connexion par connexion,
  pas par `broadcastStateless`, que l'extension relaierait une seconde fois.

Sans `REDIS_URL`, une seule instance : rien n'est relayé. Le nom affiché, la photo et la couleur
restent imposés par l'instance qui reçoit l'awareness ; un état relayé par Redis n'est pas revérifié.
En production (`NODE_ENV=production`, fixé par l'image Docker), le service refuse de démarrer
sans `REDIS_URL` (message `REDIS_URL: Required in production…`) : deux instances sans Redis
garderaient chacune leur copie des documents ouverts. En développement et en test, une instance
seule sans Redis reste possible.

Instantané (`GET /internal/projects/:id/snapshot`, compilation et recherche) : un document ouvert
sur une autre instance peut avoir des modifications que la copie de l'instance appelée (ou la
base, s'il n'est pas chargé ici) n'a pas encore. L'instance appelée demande aux autres l'état Yjs
de leurs documents du projet (`document-states-request` sur le bus : vecteur d'état et
suppressions, `Y.encodeSnapshot`), charge les documents au besoin, puis attend que sa copie
contienne chacun de ces états, apportés par l'extension Redis (`src/catch-up.ts` ; le vecteur
d'état seul ne voit pas une suppression). Attente bornée : 1 s pour les réponses (envoi sur le
bus compris : Redis indisponible, la demande est abandonnée), 3 s pour tout l'instantané, puis
texte connu (journalisé). Un document chargé pour l'instantané est déchargé
après l'enregistrement différé habituel, sans l'attendre (avec Redis, un déchargement immédiat
coûte environ 2 s par document).

## Limite de stockage du plan

`src/storage.ts` applique aux éditions la limite de stockage du plan du propriétaire du projet
(Clerk Billing ; valeurs dans `plan_limits`). Le stockage d'un compte compte les fichiers et les
états Yjs enregistrés de tous ses projets ; l'API refuse déjà les créations, uploads, imports et
transferts au-delà. Ici :

- Plan du propriétaire lu en base (`DocumentStore.ownerStorage`), même règle que l'API sans
  claims de requête : relevé des claims de son dernier jeton (`users.claimed_plan_*`) s'il est
  plus récent que le miroir `subscriptions` des webhooks, sinon le miroir, sinon `free`.
- À chaque message de synchronisation d'une connexion qui édite (après le contrôle du rôle) :
  si l'usage enregistré atteint la limite, la connexion passe en lecture seule (les mises à jour
  sont refusées, sans compter dans `MAX_REJECTED_UPDATES`) ; quand de la place se libère, elle
  retrouve l'écriture. Chaque changement envoie le message sans état `plan.storage`
  (`storageStateMessageSchema` : `full`, `plan`, `max`, `current`).
- L'état est relu au plus toutes les `STORAGE_CHECK_MS` (10 s) par projet, et après chaque
  enregistrement d'un de ses documents. Base indisponible : l'édition reste permise (journalisé).
- Dépassement possible, borné : ce qui arrive entre deux enregistrements (10 s au plus) et deux
  lectures de l'usage. L'affichage du message `plan.storage` dans l'éditeur reste à brancher avec
  la connexion du web (tâche 5) ; en attendant, l'éditeur voit ses modifications non
  synchronisées et les autres actions affichent le refus `E_PLAN_LIMIT` avec le lien des tarifs.

## Persistance

L'état Yjs complet et le sha256 du texte sont écrits dans `documents` (`yjs_state`,
`content_sha256`) au plus tard `STORE_MAX_DEBOUNCE_MS` après la première modification, puis la
date du projet est mise à jour. Un arrêt propre (SIGINT, SIGTERM) enregistre les documents en
attente avant de quitter.

## Historique : origine des mises à jour

Chaque mise à jour Yjs appliquée à un document texte est journalisée avec son auteur dans
`document_updates` (`src/updates.ts`) : le compte de la connexion qui l'a envoyée, ou celui qui
restaure une version (connexion directe). Une mise à jour relayée par Redis depuis une autre
instance est ignorée (journalisée par l'instance qui l'a reçue) : une seule ligne par mise à jour,
quel que soit le nombre d'instances. Une mise à jour refusée (lecture seule) n'est pas appliquée,
donc pas journalisée. Les mises à jour consécutives d'un même auteur sont fusionnées et écrites
par lots (au plus tard `HISTORY_FLUSH_MS`, 100 ms par défaut), dans l'ordre d'arrivée ; l'API
rejoue ce journal pour créer les versions et attribuer chaque changement à son auteur. Une
écriture perdue est rattrapée à la version suivante depuis l'état enregistré (sans auteur).

## Routes HTTP

| Route                                                  | Rôle                                                                                                                        |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `GET /health`                                          | État du service et nombre de documents ouverts                                                                              |
| `GET /internal/projects/:id/snapshot`                  | Texte courant de chaque document (ouverts : mémoire ; autres : connexion directe), à jour des autres instances              |
| `POST /internal/documents/:id/close`                   | Ferme les connexions d'un document supprimé                                                                                 |
| `POST /internal/users/:id/disconnect`                  | Ferme toutes les connexions d'un compte, son canal compris (banni, supprimé, sessions révoquées)                            |
| `POST /internal/projects/:id/members/:userId/changed`  | Applique le rôle relu en base aux connexions du membre (`memberChangedResponseSchema`)                                      |
| `POST /internal/projects/:id/events`                   | Publie `{ event }` (`publishProjectEventRequestSchema`) sur le document meta du projet                                      |
| `POST /internal/events`                                | Publie `{ event }` (`banner.changed`) sur tous les documents meta et tous les canaux des utilisateurs                       |
| `POST /internal/projects/:id/updates/flush`            | Historique : écrit tout de suite le journal en attente du projet, sur toutes les instances (réponses attendues 2 s au plus) |
| `POST /internal/projects/:id/documents/:docId/replace` | Restauration : remplace le texte (`{ content, userId }`) par une modification minimale                                      |

Les routes `/internal` exigent l'en-tête `X-Internal-Token`. Leurs réponses suivent les schémas
de `@kaxolax/contracts` (`projectSnapshotSchema`, `closeDocumentResponseSchema`,
`disconnectUserResponseSchema`, `publishEventResponseSchema` ; 400 `E_INVALID_EVENT` pour un
événement invalide). Avec Redis, fermetures et événements sont relayés aux autres instances. Un compte banni ou supprimé (`users.banned_at`, `deleted_at`)
n'a plus de rôle pour `onAuthenticate` : sa reconnexion est refusée. De même pour un jeton émis
(`iat`) avant la dernière révocation des sessions par l'admin (`users.sessions_revoked_at`).
Cette vérification est refaite dans le hook `connected`, une fois la connexion attachée au
document : une connexion authentifiée juste avant le bannissement, encore en cours de chargement
du document quand l'API appelle `/internal/users/:id/disconnect`, est fermée à son attache.

## Développement

```bash
docker compose up -d postgres redis
pnpm --filter @kaxolax/api migrate
pnpm --filter @kaxolax/realtime dev     # lit .env.example, puis .env s'il existe
pnpm --filter @kaxolax/realtime test    # recrée la base kaxolax_realtime_test, Redis local
```

`test/cluster.test.ts` lance deux instances derrière le Redis local (`REALTIME_TEST_REDIS_URL`,
par défaut `redis://127.0.0.1:6379`, préfixe aléatoire) : une édition, l'awareness et un
événement (documents meta et canaux des utilisateurs) passent de l'une à l'autre ; un membre
retiré par l'instance A est déconnecté de l'instance B en moins de 2 s ; un instantané demandé à
B contient les modifications faites sur A (document ouvert ou non sur B, suppression comprise).
`test/meta.test.ts` couvre le document meta (autorisation, rejet des écritures, événements,
identité imposée dans l'awareness), `test/user-channel.test.ts` le canal de l'utilisateur,
`test/catch-up.test.ts` l'attente des états Yjs et `test/config.test.ts` la configuration
(Redis obligatoire en production).

`REALTIME_TOKEN_SECRET` et `INTERNAL_TOKEN` doivent être identiques dans `apps/api`.
