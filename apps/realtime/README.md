# @kaxolax/realtime

Service d'édition collaborative (Hocuspocus + Yjs). Chaque document texte est un `Y.Doc` qui
contient un seul `Y.Text` nommé `content`, sous le nom `project:{projectId}:doc:{documentId}`
(voir `@kaxolax/collab`).

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
- Plusieurs instances (tâche 5) : la route applique le changement sur l'instance appelée puis le
  publie par un `MemberChangeFanout` (aucun relais aujourd'hui) ; l'extension Redis fournira
  une implémentation pub/sub dont l'abonnement appelle `applyMemberChange` sur chaque instance.

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

## Routes HTTP

| Route                                                 | Rôle                                                                                   |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `GET /health`                                         | État du service et nombre de documents ouverts                                         |
| `GET /internal/projects/:id/snapshot`                 | Texte courant de chaque document (ouverts : mémoire ; autres : connexion directe)      |
| `POST /internal/documents/:id/close`                  | Ferme les connexions d'un document supprimé                                            |
| `POST /internal/users/:id/disconnect`                 | Ferme toutes les connexions d'un compte (banni, supprimé, sessions révoquées)          |
| `POST /internal/projects/:id/members/:userId/changed` | Applique le rôle relu en base aux connexions du membre (`memberChangedResponseSchema`) |

Les routes `/internal` exigent l'en-tête `X-Internal-Token`. Leurs réponses suivent les schémas
de `@kaxolax/contracts` (`projectSnapshotSchema`, `closeDocumentResponseSchema`,
`disconnectUserResponseSchema`). Un compte banni ou supprimé (`users.banned_at`, `deleted_at`)
n'a plus de rôle pour `onAuthenticate` : sa reconnexion est refusée. De même pour un jeton émis
(`iat`) avant la dernière révocation des sessions par l'admin (`users.sessions_revoked_at`).
Cette vérification est refaite dans le hook `connected`, une fois la connexion attachée au
document : une connexion authentifiée juste avant le bannissement, encore en cours de chargement
du document quand l'API appelle `/internal/users/:id/disconnect`, est fermée à son attache.

## Développement

```bash
docker compose up -d postgres
pnpm --filter @kaxolax/api migrate
pnpm --filter @kaxolax/realtime dev     # lit .env.example, puis .env s'il existe
pnpm --filter @kaxolax/realtime test    # recrée la base kaxolax_realtime_test
```

`REALTIME_TOKEN_SECRET` et `INTERNAL_TOKEN` doivent être identiques dans `apps/api`.
