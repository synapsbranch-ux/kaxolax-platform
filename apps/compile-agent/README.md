# @kaxolax/compile-agent

Agent de compilation : service HTTP interne qui tourne sur les workers. Il synchronise les
fichiers d'un projet, lance latexmk dans un conteneur sandboxé, parse le log, envoie les sorties
vers S3 et répond aux requêtes SyncTeX. Il n'est jamais exposé publiquement : toutes les routes
exigent l'en-tête `X-Internal-Token`.

## Routes

| Route                            | Rôle                                                      |
| -------------------------------- | --------------------------------------------------------- |
| `POST /projects/:id/compile`     | Compile (corps `CompileRequest` de `@kaxolax/contracts`)  |
| `POST /projects/:id/stop`        | Arrête la compilation en cours                            |
| `POST /projects/:id/clear-cache` | Supprime le répertoire de travail du projet               |
| `GET /projects/:id/synctex/code` | Du code vers le PDF (`file`, `line`, `column`)            |
| `GET /projects/:id/synctex/pdf`  | Du PDF vers le code (`page`, `h`, `v`)                    |
| `POST /projects/:id/word-count`  | Compte les mots (corps `WordCountRequest`) ; 422 si échec |
| `POST /projects/:id/convert`     | Markdown → LaTeX (corps `ConvertRequest`) ; 422 si échec  |
| `GET /health`                    | Compilations actives et capacité                          |

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
  Options de la demande (`options`) : `haltOnFirstError` ajoute `-halt-on-error` ; `draft`
  ajoute `-usepretex=\PassOptionsToPackage{draft}{graphicx}\PassOptionsToPackage{draft}{hyperref}`
  (texte constant lu avant le document, fichiers du projet intacts). Aucune valeur de la demande
  n'entre dans la commande, jamais de `-shell-escape`.
- **Statuts** :
  - `timeout` : le conteneur a été tué au bout de `timeoutMs` ;
  - `error` : arrêt demandé, mémoire épuisée, PDF de plus de 100 Mo, log de plus de 10 Mo, chemin refusé ;
  - `failure` : latexmk a échoué (le PDF peut exister) ;
  - `success` : sinon.
- **Compteur de mots** : `texcount -merge -sub=section -utf8 -nocol ./<principal>` dans le même
  sandbox (aucun réseau, UID 1000, racine en lecture seule, délai de 20 s). Les documents texte de
  la demande sont écrits dans `COMPILES_DIR/.wordcount/<aléa>/`, hors des projets (ni « vider le
  cache » ni le nettoyage LRU n'y touchent), monté en lecture seule et supprimé ensuite. texcount
  (Perl) n'exécute pas TeX, donc aucun shell escape possible ; comme il ne lit pas texmf.cnf, il
  tourne sous une garde Perl (`TEXCOUNT_GUARD`) qui refuse toute lecture hors de ce répertoire
  (chemin absolu, `..`, nom avec `|` qui lancerait une commande). Sortie analysée (`src/texcount.ts`) :
  totaux, détail par partie, chapitre et section (documents inclus à leur place), avertissements
  `!!! … !!!`. Au plus 2 comptages simultanés par agent et 8 en attente (au-delà, 503
  `word_count_busy` immédiat) ; dans le conteneur Cloudflare (`ProcessSandbox`, une exécution
  à la fois), le comptage attend la fin de la compilation.
- **Conversion Markdown → LaTeX** (`src/convert.ts`) : pandoc 3.12 de l'image TeX Live, dans le
  même sandbox (aucun réseau, UID 1000, racine en lecture seule, `RLIMIT_FSIZE`, délai de 30 s
  par défaut, 60 s au plus, chien de garde sur la taille du répertoire). Le répertoire de travail,
  neuf et hors des projets (`COMPILES_DIR/.convert/<aléa>/`), ne contient que `input.md`,
  `kaxolax-convert.json` (options du filtre) et `media/` ; il est supprimé ensuite.
  - Commande constante : `pandoc +RTS -M512m -RTS --sandbox --data-dir=/usr/share/kaxolax/pandoc
--lua-filter=/usr/share/kaxolax/pandoc/kaxolax-convert.lua --from=markdown-raw_tex-raw_attribute-raw_html
--to=latex --standalone --wrap=preserve --variable=documentclass:<classe> --natbib --output=output.tex input.md`.
    Seules des valeurs de listes fermées en dépendent (classe, `--top-level-division`,
    `--number-sections`, `--natbib` ou `--biblatex`, `--from=markdown` avec `rawLatex`). Aucun autre filtre, modèle ni
    fichier de défauts : le filtre Lua de l'image est le seul exécuté.
  - Sans `rawLatex`, le LaTeX brut du texte est échappé, mais pandoc recopie tel quel le contenu
    des formules (`$…$`, `$$…$$`, métadonnées YAML comprises) : le LaTeX produit n'est jamais sûr,
    le sandbox de compilation reste la seule barrière. Les commandes d'accès aux fichiers ou au
    moteur ainsi recopiées (`\input`, `\write18`, `\directlua`…, hors verbatim) sont signalées
    dans `warnings`.
  - Le filtre réécrit les chemins des images (relatifs au Markdown → relatifs au document
    principal, `graphicsDir`), change les images distantes en liens, remplace les chemins absolus
    ou hors du projet par leur texte, extrait les images `data:` (PNG, JPEG, PDF, 50 au plus,
    4 Mo de fichiers distincts : une image répétée ne compte pas) sous `media/<sha1>.<ext>`, et
    encadre le corps de marqueurs aléatoires.
  - Citations `[@clé]` : commandes natbib (`\citep`, `\citet`) ou biblatex (`\autocite`,
    `\textcite`), jamais citeproc ni du texte. pandoc recopie les clés telles quelles, même avec
    la syntaxe `@{…}` : le filtre ne garde que les clés de l'alphabet sûr (lettres, chiffres,
    `_:.-+/`), les autres restent du texte échappé et sont signalées. Sans citation, les lignes
    natbib/biblatex du modèle de pandoc sont retirées hors du corps. `citations` de la réponse
    liste les clés citées (l'API les compare aux `.bib` du projet).
  - Réponse (`ConvertResult`) : document complet, ou corps et préambule (fragment : sans
    `\documentclass`, titre ni `\setcounter{secnumdepth}`, la numérotation restant celle du
    document hôte), titre,
    images extraites en base64 (chemins sous `mediaDir`), traitement de chaque image (présence
    dans `media`, la liste des fichiers du projet) et avertissements. Les sorties sont lues sans
    suivre de lien symbolique. Rien n'est écrit dans le projet : l'API range les fichiers.
  - Échecs (422 `convert_failed`, `reason`) : `timeout`, `out_of_memory` (tas plafonné),
    `output_too_large` (LaTeX de plus de 8 Mo, images), `failed` (erreur de pandoc). Même file que
    le comptage de mots (2 exécutions, 8 en attente, puis 503 `convert_busy`).
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
- la conversion Markdown → LaTeX (document compilé, fragment inclus dans un document) et les cas
  malveillants `pandoc-*` de l'image, rejoués par l'agent ;
- le jeu d'exemples Markdown de `test/fixtures/markdown` (titres, listes, tableaux, maths,
  notes, liens et code, images, blocs de citation, citations `[@clé]` compilées avec BibTeX) : chaque `<nom>.md` converti en fragment comme le fait
  l'API est comparé exactement à `<nom>.expected.tex`, puis inclus dans le document de départ
  d'un projet complété du seul préambule demandé par l'API (`pandocRequirements`) et compilé.
  `KAXOLAX_UPDATE_EXPECTED=1` réécrit les résultats attendus (à relire avant de les garder) ;
- le HTTP avec S3.

Ils sont ignorés si Docker ou l'image manquent, sauf avec `KAXOLAX_REQUIRE_INTEGRATION=1` (CI).
L'image à tester se choisit avec `KAXOLAX_TEST_IMAGE`. Les tests de conversion sont aussi ignorés
si l'image n'a pas pandoc (images publiées avant son ajout), sauf avec `KAXOLAX_REQUIRE_PANDOC=1`.
Pour les lancer sans reconstruire TeX Live, ajouter pandoc à l'image locale avec l'étape
`pandoc-overlay` de kaxolax-texlive-images :

```bash
docker build --target pandoc-overlay --build-arg PANDOC_OVERLAY_BASE=kaxolax-texlive:2026-medium \
  -t kaxolax-texlive-pandoc:2026-medium ../kaxolax-texlive-images
KAXOLAX_TEST_IMAGE=kaxolax-texlive-pandoc:2026-medium KAXOLAX_REQUIRE_PANDOC=1 \
  pnpm --filter @kaxolax/compile-agent test:integration
```
