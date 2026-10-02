# @kaxolax/realtime

Service d'édition collaborative (Hocuspocus + Yjs). Chaque document texte est un `Y.Doc` qui
contient un seul `Y.Text` nommé `content`, sous le nom `project:{projectId}:doc:{documentId}`
(voir `@kaxolax/collab`).

## Connexion

1. Le navigateur demande un jeton à l'API : `POST /api/v1/projects/:id/realtime-token` renvoie
   `{ token, url, expiresAt }` (5 minutes).
2. Il ouvre `url` avec `HocuspocusProvider`, le nom du document et ce jeton.
3. Le service vérifie la signature et l'expiration, puis que le document appartient au projet
   du jeton, qu'il existe et que l'utilisateur est membre. Le rôle est relu en base : owner et
   editor écrivent, viewer et reviewer sont en lecture seule.

## Persistance

L'état Yjs complet et le sha256 du texte sont écrits dans `documents` (`yjs_state`,
`content_sha256`) au plus tard `STORE_MAX_DEBOUNCE_MS` après la première modification, puis la
date du projet est mise à jour. Un arrêt propre (SIGINT, SIGTERM) enregistre les documents en
attente avant de quitter.

## Routes HTTP

| Route                                 | Rôle                                                                              |
| ------------------------------------- | --------------------------------------------------------------------------------- |
| `GET /health`                         | État du service et nombre de documents ouverts                                    |
| `GET /internal/projects/:id/snapshot` | Texte courant de chaque document (ouverts : mémoire ; autres : connexion directe) |
| `POST /internal/documents/:id/close`  | Ferme les connexions d'un document supprimé                                       |
| `POST /internal/users/:id/disconnect` | Ferme toutes les connexions d'un compte (banni, supprimé, sessions révoquées)     |

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
