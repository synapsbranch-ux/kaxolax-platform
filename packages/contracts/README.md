# @kaxolax/contracts

Schémas zod et types partagés entre les services (API, compile-gateway, compile-agent,
realtime). Chaque service valide avec ces schémas les messages qu'il reçoit.

| Module          | Contenu                                                                                      |
| --------------- | -------------------------------------------------------------------------------------------- |
| `common.ts`     | Compilateurs, statuts de compilation, sha256, en-tête `x-internal-token`                     |
| `names.ts`      | Règles des noms d'entités et des chemins relatifs sûrs                                       |
| `files.ts`      | Règles « document texte ou fichier binaire »                                                 |
| `log.ts`        | Entrée de log LaTeX parsée                                                                   |
| `compile.ts`    | Demande de compilation, réponses de l'agent, du gateway et de l'API, `/health`, arrêt, cache |
| `synctex.ts`    | Requêtes et réponses SyncTeX dans les deux sens                                              |
| `realtime.ts`   | Snapshot d'un projet et fermeture d'un document (routes internes du service temps réel)      |
| `projects.ts`   | Langues du correcteur orthographique d'un projet                                             |
| `workspaces.ts` | Types et rôles de workspace, workspace renvoyé par `GET /workspaces`                         |
| `templates.ts`  | Catalogue `templates.json` v1, fiches et routes de la galerie, recherche `filterTemplates`   |

Le paquet est compilé vers `dist/` (ESM + déclarations). Commandes :

```bash
pnpm --filter @kaxolax/contracts build
pnpm --filter @kaxolax/contracts test
```
