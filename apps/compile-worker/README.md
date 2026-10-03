# @kaxolax/compile-worker

Worker Cloudflare de compilation (mode `COMPILE_BACKEND=cloudflare` de l'API) : Worker + Durable
Object `CompileContainer` + Cloudflare Containers. Une instance de conteneur par projet (Durable
Object nommé par `projectId`), VM isolée sans réseau (`enableInternet = false`), mise en sommeil
15 min après la dernière activité.

## Routes (appelées par l'API seulement)

Chaque requête porte `Authorization: Bearer v1.<charge>.<HMAC>` : jeton de 60 s signé avec
`COMPILE_WORKER_SECRET` et lié au `projectId` de l'URL (`packages/contracts/src/compile-worker-auth.ts`).

| Route                                   | Rôle                                                      |
| --------------------------------------- | --------------------------------------------------------- |
| `GET /health`                           | Sonde, sans jeton                                         |
| `POST /projects/:id/compile`            | Met une compilation en file (la plus récente gagne) ; 202 |
| `POST /projects/:id/cancel`             | Annule la compilation en cours ou en file                 |
| `POST /projects/:id/warm`               | Réveil anticipé du conteneur (ouverture de l'éditeur)     |
| `POST /projects/:id/clear-cache`        | Vide le cache de compilation du projet dans le conteneur  |
| `GET /projects/:id/synctex/code`, `pdf` | SyncTeX sur la dernière sortie                            |
| `POST /projects/:id/word-count`         | Compte les mots (texcount), synchrone ; 422 si échec      |

Le comptage de mots est synchrone : la demande (documents texte seulement, aucun binaire à
pousser) passe du Worker au Durable Object puis à l'agent du conteneur, réveillé si besoin.
L'agent l'exécute après une compilation en cours (une exécution à la fois dans la VM). L'API
attend au plus 95 s (Cloudflare coupe une requête à 100 s) : un conteneur au réveil lent donne
503, à réessayer ; l'éditeur réveille le conteneur dès l'ouverture (`warm`).

## Déroulement d'une compilation

1. L'API écrit la demande (sources texte, liste des binaires par sha256) dans le bucket des
   sorties et appelle `POST /projects/:id/compile`.
2. Le Durable Object répond `preparing` si le conteneur n'est pas prêt (`healthy` : l'agent
   écoute), sinon `queued` ; l'API publie cet état. Il réveille le conteneur si besoin (rappel
   `preparing`), puis rappelle `running`. Une annulation pendant le réveil ou l'envoi des
   binaires empêche le lancement de latexmk.
3. Il lit les binaires dans R2 (`PROJECT_FILES`) et les pousse au conteneur (cache par sha256
   vérifié), lance la compilation (agent `apps/compile-agent`, point d'entrée `container-main`).
4. Il relit PDF, log et SyncTeX, les écrit dans R2 (`COMPILE_OUTPUTS`) et envoie le rappel final
   signé (`POST /api/v1/internal/compile-callbacks`, HMAC du corps, horodatage, `seq` croissant).
   Seuls ces fichiers, sous `outputs/<projet>/<build>/`, sont copiés : le conteneur n'est pas
   fiable. Toute exception (R2, état du conteneur) se termine par un rappel `error`.
5. Une compilation par alarme (une alarme est limitée à 15 min) : une demande arrivée entre-temps
   est traitée dans une nouvelle alarme. Un rappel final que l'API n'a pas reçu (4 tentatives en
   21 s) est gardé dans le stockage du Durable Object et réessayé toutes les 30 s jusqu'au
   timeout de la compilation + 5 min (au-delà, l'API l'a close).

Le conteneur n'a ni réseau ni identifiants : tout passe par le Worker et ses bindings.

## Conteneur

`container/Dockerfile` (linux/amd64, contexte = racine du monorepo) : agent de compilation sur
l'image TeX Live durcie de `kaxolax-texlive-images`, épinglée par son empreinte dans
`TEXLIVE_IMAGE` (sans elle, `wrangler deploy` échoue : `image_vars` de `wrangler.jsonc` passe
`TEXLIVE_REQUIRE_PINNED=1` ; la CI et le poste local construisent sans cet argument). Protections : `latexmk -norc`, texmf.cnf
durci, UID 1000 sans privilège (`setpriv`), `prlimit`, timeout, processus tués après chaque
compilation (voir `docs/decisions.md`, écart de sandbox).

## Commandes

```bash
pnpm --filter @kaxolax/compile-worker test       # vitest, doubles des bindings (sans réseau)
pnpm --filter @kaxolax/compile-worker build      # wrangler deploy --dry-run (bundle dans dist/)
pnpm --filter @kaxolax/compile-worker run deploy # déploiement réel : voir docs/deploy.md
```

`run` est obligatoire pour le déploiement : `pnpm deploy` est une commande intégrée de pnpm
(copie d'un paquet du workspace), qui passe avant le script `deploy` du paquet.

Secret : `pnpm --filter @kaxolax/compile-worker exec wrangler secret put COMPILE_WORKER_SECRET`
(même valeur que l'API). Domaine et noms de buckets : `wrangler.jsonc`.
