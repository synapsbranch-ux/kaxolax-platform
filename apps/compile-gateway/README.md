# @kaxolax/compile-gateway

Service HTTP interne entre l'API et les agents de compilation. Il n'est jamais exposé : toutes
les routes exigent l'en-tête `X-Internal-Token`.

## Routage

- **Verrou** `compile:lock:{projectId}` (Redis, `SET … PX … GET`) : une nouvelle demande sur un
  projet en cours de compilation arrête la précédente (l'arrêt attend la fin de son conteneur).
- **Affinité** `compile:agent:{projectId}` (TTL 24 h) : même agent = répertoire de travail déjà
  présent = compilation incrémentale. Elle est posée de façon atomique : deux premières demandes
  simultanées vont au même agent, qui exécute les compilations d'un projet une par une.
- **Bascule** : si l'agent affecté ne répond pas à `/health`, le gateway choisit le moins chargé
  (compilations actives / capacité) et compile à froid. Une connexion coupée pendant la
  compilation donne droit à une seconde tentative sur un autre agent.
- SyncTeX et l'arrêt suivent l'affinité ; le vidage du cache s'adresse à tous les agents.
- Le comptage de mots (sans état : les documents sont dans la demande) va à l'agent de
  l'affinité, sinon au moins chargé, sans prendre le verrou du projet ; seconde tentative
  ailleurs si l'agent tombe.

## Routes

| Route                            | Rôle                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `POST /compile`                  | Corps `CompileRequest` (avec `options` éventuelles) ; réponse de l'agent + `agentId` |
| `POST /projects/:id/stop`        | Arrête la compilation en cours                                                       |
| `POST /projects/:id/clear-cache` | Supprime le répertoire du projet sur tous les agents                                 |
| `GET /projects/:id/synctex/code` | Du code vers le PDF                                                                  |
| `GET /projects/:id/synctex/pdf`  | Du PDF vers le code                                                                  |
| `POST /projects/:id/word-count`  | Compte les mots (corps `WordCountRequest`) ; 422 et 503 de l'agent relayés           |
| `GET /health`                    | Disponibilité et charge de chaque agent                                              |

Sans agent disponible, `/compile` répond 503 : l'API enregistre alors une compilation en erreur.

## Développement

```bash
docker compose up -d redis
pnpm --filter @kaxolax/compile-gateway dev    # lit .env.example, puis .env s'il existe
pnpm --filter @kaxolax/compile-gateway test   # faux agents + Redis local
```

`COMPILE_AGENTS` liste les agents (`id=url`, séparés par des virgules). Pour essayer la bascule
en local, lancer un second agent (`AGENT_ID=agent-local-2 PORT=3201 COMPILES_DIR=.data/compiles-2
CACHE_DIR=.data/cache-2`) et l'ajouter à la liste.
