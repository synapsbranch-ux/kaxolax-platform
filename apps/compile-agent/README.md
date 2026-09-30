# @kaxolax/compile-agent

Agent de compilation : service HTTP interne qui tourne sur les workers. Il synchronise les
fichiers d'un projet, lance latexmk dans un conteneur sandboxé, parse le log, envoie les sorties
vers S3 et répond aux requêtes SyncTeX. Il n'est jamais exposé publiquement : toutes les routes
exigent l'en-tête `X-Internal-Token`.

## Routes

| Route                            | Rôle                                                     |
| -------------------------------- | -------------------------------------------------------- |
| `POST /projects/:id/compile`     | Compile (corps `CompileRequest` de `@kaxolax/contracts`) |
| `POST /projects/:id/stop`        | Arrête la compilation en cours                           |
| `POST /projects/:id/clear-cache` | Supprime le répertoire de travail du projet              |
| `GET /projects/:id/synctex/code` | Du code vers le PDF (`file`, `line`, `column`)           |
| `GET /projects/:id/synctex/pdf`  | Du PDF vers le code (`page`, `h`, `v`)                   |
| `GET /health`                    | Compilations actives et capacité                         |

## Fonctionnement

- **Un répertoire par projet** : `COMPILES_DIR/<projectId>/files` est monté sur `/compile`.
  `state.json` (hash des ressources écrites, document principal) reste hors du montage.
- **Synchronisation par hash** : seuls les fichiers modifiés sont écrits. Les ressources
  supprimées disparaissent, mais les fichiers générés (aux, bbl, pdf…) restent pour la
  compilation incrémentale. Un chemin absolu, avec `..` ou traversant un lien symbolique est
  refusé avant toute écriture. Les écritures se font en `O_NOFOLLOW`.
- **Cache des binaires** : indexé par sha256 et alimenté depuis S3. Le contenu téléchargé est
  vérifié avant d'entrer dans le cache, puis copié (jamais lié) dans le répertoire du projet.
- **Sandbox** : conteneur neuf à chaque fois, créé par l'API Docker (socket Unix). Règles :
  - `--network none`, UID 1000, racine en lecture seule, `/tmp` en tmpfs `noexec` ;
  - `cap-drop ALL`, `no-new-privileges` ;
  - 2 Go de mémoire, 1 CPU, 256 processus, `RLIMIT_FSIZE` à 101 Mo ;
  - seul le projet est monté, runtime `COMPILE_RUNTIME` (runc ou runsc).
  - Un chien de garde tue la compilation si le répertoire dépasse `WORKDIR_MAX_BYTES`.
- **Commande** : `latexmk -norc -cd -f -jobname=output -synctex=1 -interaction=batchmode -file-line-error -pdf main.tex`
  (`-xelatex` ou `-lualatex` selon le compilateur). `-norc` empêche latexmk d'exécuter le
  `latexmkrc` (du Perl) d'un projet (voir `docs/decisions.md`).
- **Statuts** :
  - `timeout` : le conteneur a été tué au bout de `timeoutMs` ;
  - `error` : arrêt demandé, mémoire épuisée, PDF de plus de 100 Mo, log de plus de 10 Mo, chemin refusé ;
  - `failure` : latexmk a échoué (le PDF peut exister) ;
  - `success` : sinon.
- **Nettoyage LRU** des répertoires de projets et du cache, toutes les 5 minutes.
- Durées mesurées (`timings` : synchronisation, exécution, upload) et loguées à chaque compilation.

## Développement

Prérequis : Docker, l'image `kaxolax-texlive:2026-medium` (voir `kaxolax-texlive-images`), et
la stack locale (`docker compose up -d` à la racine) pour S3.

```bash
pnpm --filter @kaxolax/compile-agent dev      # serveur sur :3200 (.env.example, puis .env s'il existe)
```

### Ligne de commande, sans interface ni S3

```bash
cd apps/compile-agent
pnpm cli compile examples/demo --repeat 2          # à froid puis à chaud, durées affichées
pnpm cli compile examples/demo --compiler xelatex
pnpm cli synctex-code examples/demo --file chapters/intro.tex --line 4
pnpm cli synctex-pdf examples/demo --page 1 --h 150 --v 330
pnpm cli clear-cache examples/demo
```

Les sorties sont copiées dans `.data/outputs`. `COMPILE_RUNTIME=runsc` compile sous gVisor.

### Tests

```bash
pnpm --filter @kaxolax/compile-agent test               # unitaires
pnpm --filter @kaxolax/compile-agent test:integration   # vrai Docker + image TeX Live (+ S3 local)
COMPILE_RUNTIME=runsc pnpm --filter @kaxolax/compile-agent test:integration
```

Les tests d'intégration couvrent :

- un succès, une erreur avec son fichier et sa ligne, un timeout et un arrêt ;
- SyncTeX aller-retour et la comparaison à chaud contre à froid ;
- un lien symbolique planté et l'absence de fuite de l'environnement ;
- la suite de tests malveillants, lue dans l'image (`/usr/share/kaxolax/malicious`) et rejouée par l'agent ;
- le HTTP avec S3.

Ils sont ignorés si Docker ou l'image manquent, sauf avec `KAXOLAX_REQUIRE_INTEGRATION=1` (CI).
L'image à tester se choisit avec `KAXOLAX_TEST_IMAGE`.
