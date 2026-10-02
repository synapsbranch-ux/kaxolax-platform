# @kaxolax/realtime

Service d'édition collaborative (Hocuspocus + Yjs). Chaque document texte est un `Y.Doc` qui
contient un seul `Y.Text` nommé `content`, sous le nom `project:{projectId}:doc:{documentId}`
(voir `@kaxolax/collab`). Chaque projet a aussi un document meta, `project:{projectId}:meta`
(`metaDocumentName`), sans contenu : présence globale et événements du projet.

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

## Persistance

L'état Yjs complet et le sha256 du texte sont écrits dans `documents` (`yjs_state`,
`content_sha256`) au plus tard `STORE_MAX_DEBOUNCE_MS` après la première modification, puis la
date du projet est mise à jour. Un arrêt propre (SIGINT, SIGTERM) enregistre les documents en
attente avant de quitter.

## Routes HTTP

| Route                                                 | Rôle                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /health`                                         | État du service et nombre de documents ouverts                                         |
| `GET /internal/projects/:id/snapshot`                 | Texte courant de chaque document (ouverts : mémoire ; autres : connexion directe)      |
| `POST /internal/documents/:id/close`                  | Ferme les connexions d'un document supprimé                                            |
| `POST /internal/users/:id/disconnect`                 | Ferme toutes les connexions d'un compte (banni, supprimé, sessions révoquées)          |
| `POST /internal/projects/:id/members/:userId/changed` | Applique le rôle relu en base aux connexions du membre (`memberChangedResponseSchema`) |
| `POST /internal/projects/:id/events`                  | Publie `{ event }` (`publishProjectEventRequestSchema`) sur le document meta du projet |
| `POST /internal/events`                               | Publie `{ event }` (`banner.changed`) sur tous les documents meta                      |

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
événement passent de l'une à l'autre ; un membre retiré par l'instance A est déconnecté de
l'instance B en moins de 2 s. `test/meta.test.ts` couvre le document meta (autorisation, rejet
des écritures, événements, identité imposée dans l'awareness).

`REALTIME_TOKEN_SECRET` et `INTERNAL_TOKEN` doivent être identiques dans `apps/api`.
