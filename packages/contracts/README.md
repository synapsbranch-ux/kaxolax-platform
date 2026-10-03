# @kaxolax/contracts

Schémas zod et types partagés entre les services et les interfaces (API, realtime, web, admin,
compile-gateway, compile-agent, compile-worker, `functions/*`, `packages/collab`). Chaque service
valide avec ces schémas les messages qu'il reçoit ; un module par domaine, tous réexportés par
`index.ts`.

| Module                   | Contenu                                                                                                            |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `common.ts`              | Compilateurs, statuts de compilation, sha256, en-tête `x-internal-token`                                           |
| `names.ts`               | Règles des noms d'entités et des chemins relatifs sûrs                                                             |
| `files.ts`               | Règles « document texte ou fichier binaire »                                                                       |
| `log.ts`                 | Entrée de log LaTeX parsée                                                                                         |
| `compile.ts`             | Demande de compilation, réponses de l'agent, du gateway et de l'API, `/health`, arrêt, cache, préfixes S3          |
| `builds.ts`              | Compilation asynchrone (Worker) : états, `buildId`, demande dans R2, rappels signés, `GET …/builds/:id`            |
| `compile-worker-auth.ts` | Jetons API → Worker et signature HMAC des rappels (WebCrypto, Node.js et Workers)                                  |
| `synctex.ts`             | Requêtes et réponses SyncTeX dans les deux sens                                                                    |
| `word-count.ts`          | Comptage de mots (texcount) : demande, plafonds, résultat                                                          |
| `convert.ts`             | Conversion Markdown → LaTeX (pandoc dans le sandbox) : demande, options, résultat, échecs                          |
| `markdown-import.ts`     | Import de Markdown (`POST …/convert/markdown`) et préambule nécessaire à un fragment de pandoc, sans doublon       |
| `realtime.ts`            | Routes internes du temps réel (snapshot, fermeture, déconnexion, membres), jetons (projet, canal de l'utilisateur) |
| `events.ts`              | Événements du projet sur le document meta (`tree.changed`, `compile.updated`…), `banner.changed`                   |
| `presence.ts`            | Présence (awareness Yjs) : identité, document ouvert, curseur, couleurs                                            |
| `permissions.ts`         | Matrice des permissions d'un projet par rôle (owner, editor, reviewer, viewer), dont l'activation de l'IA          |
| `projects.ts`            | Langues du correcteur orthographique d'un projet                                                                   |
| `workspaces.ts`          | Types et rôles de workspace, matrice de ses permissions, workspace renvoyé par `GET /workspaces`                   |
| `sharing.ts`             | Membres, invitations, transfert de propriété, liens de partage                                                     |
| `comments.ts`            | Commentaires ancrés : fils, messages, routes du panneau Review, `comment.thread-updated`                           |
| `chat.ts`                | Chat du projet : messages, mentions, références de fichier, pagination                                             |
| `history.ts`             | Historique : versions (dont `restored`), diff attribué, label, restauration, manifeste, routes internes            |
| `search.ts`              | Recherche dans un projet (texte ou expression régulière), résultats                                                |
| `preferences.ts`         | Préférences de l'utilisateur (éditeur, onglets ouverts, symboles récents)                                          |
| `billing.ts`             | Clerk Billing : plans, features, limites (dont crédits IA), `GET /me/plan`, refus `E_PLAN_LIMIT`, `plan.storage`   |
| `admin.ts`               | Admin : utilisateurs, projets, bannières système, statistiques (dont annulations), journal (`/api/v1/admin/*`)     |
| `templates.ts`           | Catalogue `templates.json` v1, fiches et routes de la galerie, recherche `filterTemplates`                         |
| `texlive.ts`             | Index des packages TeX Live (`texlive/<année>/packages.json`), recherche et suggestions                            |
| `client-config.ts`       | `GET /api/v1/client-config` : origines vues par le navigateur (repli de la CSP de apps/web)                        |
| `ai.ts`                  | IA (Claude) : modèle, opérations, crédits mensuels, conversations, réglages par projet et workspace, erreurs       |
| `suggestions.ts`         | Suggestions (suivi des modifications) d'un membre ou de l'IA : types, statuts, ancrage                             |
| `tokens.ts`              | Jetons d'accès personnels (`/api/v1/me/tokens`) : portées, limites, création, liste                                |
| `integrations.ts`        | Liens d'intégration d'un projet : dépôt Git (GitHub) et bibliothèque Zotero                                        |

Le paquet est compilé vers `dist/` (ESM + déclarations). Commandes :

```bash
pnpm --filter @kaxolax/contracts build
pnpm --filter @kaxolax/contracts test
```
