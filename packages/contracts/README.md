# @kaxolax/contracts

Schémas zod et types partagés entre les services et les interfaces (API, realtime, web, admin,
compile-gateway, compile-agent, compile-worker, `functions/*`, `packages/collab`). Chaque service
valide avec ces schémas les messages qu'il reçoit ; un module par domaine, tous réexportés par
`index.ts`.

| Module                   | Contenu                                                                                                   |
| ------------------------ | --------------------------------------------------------------------------------------------------------- |
| `common.ts`              | Compilateurs, statuts de compilation, sha256, en-tête `x-internal-token`                                  |
| `names.ts`               | Règles des noms d'entités et des chemins relatifs sûrs                                                    |
| `files.ts`               | Règles « document texte ou fichier binaire »                                                              |
| `log.ts`                 | Entrée de log LaTeX parsée                                                                                |
| `compile.ts`             | Demande de compilation, réponses de l'agent, du gateway et de l'API, `/health`, arrêt, cache, préfixes S3 |
| `builds.ts`              | Compilation asynchrone (Worker) : états, `buildId`, demande dans R2, rappels signés, `GET …/builds/:id`   |
| `compile-worker-auth.ts` | Jetons API → Worker et signature HMAC des rappels (WebCrypto, Node.js et Workers)                         |
| `synctex.ts`             | Requêtes et réponses SyncTeX dans les deux sens                                                           |
| `word-count.ts`          | Comptage de mots (texcount) : demande, plafonds, résultat                                                 |
| `realtime.ts`            | Routes internes du service temps réel (snapshot, fermeture, déconnexion, membres), jeton de connexion     |
| `events.ts`              | Événements du projet sur le document meta (`tree.changed`, `compile.updated`…), `banner.changed`          |
| `presence.ts`            | Présence (awareness Yjs) : identité, document ouvert, curseur, couleurs                                   |
| `permissions.ts`         | Matrice des permissions d'un projet par rôle (owner, editor, reviewer, viewer)                            |
| `projects.ts`            | Langues du correcteur orthographique d'un projet                                                          |
| `workspaces.ts`          | Types et rôles de workspace, workspace renvoyé par `GET /workspaces`                                      |
| `sharing.ts`             | Membres, invitations, transfert de propriété, liens de partage                                            |
| `comments.ts`            | Commentaires ancrés : fils, messages, routes du panneau Review, `comment.thread-updated`                  |
| `chat.ts`                | Chat du projet : messages, mentions, références de fichier, pagination                                    |
| `history.ts`             | Historique : versions, diff attribué, label, restauration, manifeste, routes internes                     |
| `search.ts`              | Recherche dans un projet (texte ou expression régulière), résultats                                       |
| `preferences.ts`         | Préférences de l'utilisateur (éditeur, onglets ouverts, symboles récents)                                 |
| `billing.ts`             | Clerk Billing : plans, features, limites, `GET /me/plan`, refus `E_PLAN_LIMIT`, message `plan.storage`    |
| `admin.ts`               | Admin : utilisateurs, projets, bannières système, statistiques, journal (`/api/v1/admin/*`)               |
| `templates.ts`           | Catalogue `templates.json` v1, fiches et routes de la galerie, recherche `filterTemplates`                |
| `texlive.ts`             | Index des packages TeX Live (`texlive/<année>/packages.json`), recherche et suggestions                   |

Le paquet est compilé vers `dist/` (ESM + déclarations). Commandes :

```bash
pnpm --filter @kaxolax/contracts build
pnpm --filter @kaxolax/contracts test
```
