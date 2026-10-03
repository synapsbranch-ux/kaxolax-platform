# @kaxolax/editor

Extensions CodeMirror 6 de l'éditeur LaTeX de Kaxolax. Compilé par `tsc` vers `dist/` (`pnpm --filter @kaxolax/editor build`).

## Extensions

```ts
latexExtensions({
  sharedHistory: true, // historique fourni par y-codemirror.next
  readOnly, // viewer, reviewer
  theme: 'dark', // ou 'light'
  appearance: { fontSize: 14 }, // variables --editor-font-* de @kaxolax/ui sinon
  lineWrapping: true,
  onCompile, // Mod-Enter
  actions: { registry, host: () => host }, // raccourcis du registre
  autoCompile: { onCompile, delayMs: 2500, enabled: () => prefs.autoCompile },
})
```

- `reconfigureEditor(view, { theme, appearance, syntaxTheme, keymap, spellcheck, readOnly, lineWrapping })` change ces réglages sans recréer l’éditeur (voir « Paramètres de l’éditeur »).
- `setAutoCompile(view, { enabled, delayMs })` et `autoCompileState(view)` pilotent l'auto-compilation.
- `goToLine(view, line)`, `kaxolaxKeymap`, `findFoldRange` : API de l'étape 1, inchangée.
- Commentaires (`comments.ts`) : `commentHighlights({ onSelect })` surligne les plages des fils (`setCommentRanges`, envoyées par l'application qui résout les ancres Yjs ; entre deux envois, elles suivent les modifications locales), met en avant le fil actif (`setActiveComment`) et signale un clic dans un texte commenté ; `commentsAt`, `commentableSelection`, `revealComment`.
- Suivi des modifications (`suggestions.ts`) : `suggestionTracking({ isRemote, onEdit, onUndo, canDecide, onAction, onSelect })`. Mode Suggérer (`setSuggestMode`) : un filtre de transactions remplace toute modification locale du texte (frappe, collage, autocomplétion, action) par un simple déplacement du curseur et la remet à l'application (`onEdit`, une seule plage couvrante, curseur prévu) ; les transactions distantes (`isRemote`, par exemple `ySyncAnnotation` de y-codemirror.next) passent. Ctrl+Z appelle `onUndo` en mode Suggérer. Affichage (`setSuggestionMarks`, `setActiveSuggestion`) : texte d'origine barré, texte proposé en widget avant le curseur, couleur de présence de l'auteur (`--suggestion-color`), brouillon en tirets, info-bulle (auteur, date, Accepter / Refuser si `canDecide()`, Retirer pour l'auteur), Ctrl+Alt+Entrée / Ctrl+Alt+Maj+Entrée sur la suggestion sous le curseur. `suggestionViewEdit` convertit une modification du document en coordonnées de la vue de `recordSuggestionEdit` (@kaxolax/collab) : Retour arrière après le widget retire d'abord le texte proposé. `suggestionsAt`, `suggestionMarks`, `coveringEdit`, `isSuggesting`.
- Présence (`presence.ts`) : `collaboratorCursorTheme` (noms des curseurs distants de y-codemirror.next toujours visibles, couleurs de `@kaxolax/ui`), `keystrokeListener(callback)` (frappe dans l'éditeur, modificateurs seuls exclus : fin du suivi d'un collaborateur), `revealPosition(view, position)` (défilement sans changer la sélection).

Les couleurs viennent des variables de `@kaxolax/ui/tokens.css` (`EDITOR_VARIABLES`), avec une palette de repli (`EDITOR_PALETTES`). `.cm-editor` porte `data-theme`.

## Registre d'actions

`createDefaultRegistry()` renvoie un registre contenant les actions de base (`defaultActions`) des menus `ACTION_MENUS` : Fichier, Format, Structures, Maths, Graphiques, Packages, Rechercher, Remplacer.

```ts
const dispose = registry.register({
  id: 'math.formula',
  label: 'Éditeur de formules',
  menu: 'math',
  icon: 'square-function',
  shortcut: 'Mod-Shift-e',
  when: canEdit,
  run: ({ host }) => host.openDialog?.('math.formula'),
})
registry.byMenu('math') // pour la barre Tools
registry.run('format.bold', { view, host })
registry.subscribe(() => rerender())
```

- `ActionHost` : callbacks fournis par l'application (`newFile`, `upload`, `downloadZip`, `searchProject`, `openDialog`, `prompt`, `notify`, `onMarkdownPaste`, `readOnly`). Une action dont le callback manque est désactivée.
- Constructeurs d'actions d'édition (`editCommand`, `toggleWrap`, `inlineSnippet`, `insertBlock`, `replaceWithBlock`, marque `CURSOR`) : une transaction par action, donc une étape d'annulation ; `isActionTransaction` permet d'appeler `stopCapturing()` d'un `Y.UndoManager`.
- `planPackage`, `addPackage`, `loadedPackages`, `findPreamble` : ajout d'un `\usepackage` dans le préambule, sans doublon, options fusionnées.

## Import de Markdown

- Action `file.import-markdown` (« Importer du Markdown… », menu Fichier, `MARKDOWN_IMPORT_DIALOG`) : `host.openDialog` avec un `MarkdownImportPayload` (la sélection si elle ressemble à du Markdown, avec sa plage à remplacer) ; désactivée en lecture seule ou sans `openDialog`.
- `looksLikeMarkdown(text)` : Markdown évident (deux signes au moins, ou un bloc de code ou un tableau), jamais un texte qui contient du LaTeX.
- Collage intelligent (`markdownPasteDetector`, inclus par `latexExtensions` avec `actions`) : après le collage de Markdown évident dans un document modifiable, `host.onMarkdownPaste({ text, from, to })` ; le texte reste collé tel quel. L'application y ajoute `documentId` (document du collage) : le remplacement n'a lieu que dans ce document.

## Outils d'écriture (formules, symboles, tableaux)

Logique pure (sans React ni MathLive), testée ; l'interface vit dans l'application. Les actions `math.formula` (« Éditeur de formules », `Mod-Shift-e`), `math.symbols` (« Symboles ») et `structures.table` (« Tableau ») sont dans `createDefaultRegistry()` : elles appellent `host.openDialog(id, payload)` (identifiants dans `WRITING_DIALOGS`) et sont désactivées sans `openDialog` ou en lecture seule.

```ts
// Éditeur de formules : payload = formulaDialogPayload(state)
mathfield.value = payload.initial // formule sous le curseur, ou sélection
applyFormula(view, payload, { latex: mathfield.value, style: 'equation', label: 'eq:x' })
// Symboles
searchSymbols('flèche', { category: 'arrows' })
symbolMissingPackages(mainDoc, symbol) // ['amssymb'] → bouton « Ajouter » : addPackage(view, name)
insertSymbol(view, symbol, { addPackages: true })
recent = pushRecentSymbol(recent, symbol.id) // parseRecentSymbols / serializeRecentSymbols
// Tableaux : payload = tableDialogPayload(state), payload.parse = grille ou texte brut
applyTable(view, payload, model) // ou { raw } pour un tableau non représentable
```

- Formules : `findFormulas`, `formulaAt` (`\( \)`, `\[ \]`, `$ $`, `$$ $$`, `equation`, `align`, `gather`, `multline`… étoilés ou non ; commentaires et verbatim ignorés), `rewriteFormula` (même présentation : seuls la formule et le `\label` changent, texte identique si rien ne change ; un `align` réécrit par MathLive garde une ligne par `\\` avec l'indentation d'origine, `breakRows`), `mathModeAt` (contenu d'une formule hors `\text{…}`, jamais sur ses délimiteurs : mode des symboles), `formatFormula` (en ligne, centrée, `equation` avec `\label` ; plusieurs lignes dans `split`/`aligned`), `mathfieldValue`/`fromMathfield` (`align` présenté dans `aligned` à MathLive), `FORMULA_LIBRARY` ; `formulaIssues` (accolades, `$`, `#`, `&` hors alignement, délimiteurs ou `\begin`/`\end` imbriqués : `formulaInsertion(…).errors`, insertion refusée, `invalid`), avertissement si une équation passée en ligne ou centrée perd son `\label` ; `sanitizeLabel` (`A-Z a-z 0-9 : . _ / + -`).
- `normalizeMathLive` : table `MATHLIVE_REPLACEMENTS` (`\exponentialE` → `e`, `\differentialD` → `\mathrm{d}`, `\mleft` → `\left`…), cases vides retirées, couleurs `#rrggbb` converties pour xcolor, sauts de ligne et commentaires `%` gardés (un commentaire ne commente jamais la suite) ; `sanitizeForMathLive` retire `\href`, `\htmlStyle`, `\class`… (contenu gardé, répété jusqu'à un texte stable : une commande reformée par un retrait est retirée aussi) de toute valeur chargée dans MathLive ; `mathPackages(latex)` et `missingPackages(doc, names)` (mathtools fournit amsmath, amssymb fournit amsfonts).
- Symboles : `SYMBOLS` (commande, aperçu, noms fr/en, catégorie, mode, packages), recherche sans casse ni accents, récents bornés (`RECENT_SYMBOLS_LIMIT`) à stocker par l'application.
- Tableaux : `TableModel` (colonnes `l c r p{…} m{…} X`, séparateurs `|`, cellules avec `colspan`/`rowspan`, filets par frontière, flottant, légende, label) ; `createTable`, `mergeCells`, `splitCell`, `insertRow`/`deleteRow`, `insertColumn`/`deleteColumn`, `setHorizontalRule`, `setVerticalRule`, `setTableRuleStyle` (booktabs, classique, aucun) ; `generateTable` (`\multicolumn`, `\multirow`, packages) ; `tableAt`/`parseTable` (tabular, tabular*, tabularx, longtable, flottant `table` s'il ne contient que le tableau) : aller-retour exact pour les tableaux générés, avertissements (`comments`, `normalized`, `raw-cell`…) ou `ok: false` + texte brut sinon ; `tableFromDelimited` (collage Excel/Sheets ou CSV, `escapeLatex` ; une colonne de nombres à virgule décimale `3,5` n'est pas coupée) ; `tableCellIssues` et `captionIssue` (cases et légende qui ne compileraient pas : `%`, `#`, `&`, `$` seul, `_`/`^` hors formule, `\\`, accolades) et `fixTableCells` (échappement en un clic, légende comprise) ; `\cmidrule[largeur](rognage){a-b}`, `\rowcolor` en tête de ligne (`row.prefix`) et légendes de suite d'un longtable (`\caption[]{…}` avant `\endhead`, gardées telles quelles) relus sans perte ; `nested` : tabular seul déjà dans un flottant, une minipage ou une boîte, ou nouveau tableau inséré à un tel endroit (`floatForbiddenAt`, `tableFloatLocked` : pas de flottant).
- Insertion : une étape d'annulation, packages ajoutés au préambule s'ils manquent (`missingPackages` : un package déjà fourni par un autre n'est pas ajouté) ; la plage détectée est suivie à travers les modifications depuis l'ouverture (`trackTarget`, champ d'état), `stale` si elle ne contient plus le texte d'origine (jamais une autre occurrence), `unchanged` si rien n'a changé. Un bloc régénéré prend l'indentation de l'éditeur.

## Outline

- `extractOutline(doc)` : arbre `{ level, title, shortTitle, starred, line, from, children }` (`\part` à `\subparagraph`), commentaires, préambule et verbatim ignorés.
- `scanOutline(doc)` signale aussi les inclusions (`\input`, `\include`, `\subfile`, `\import`) ; `expandOutline` et `includeCandidates` descendent dans les fichiers inclus fournis par l'application.
- `currentSection(tree, position, file?)` et `currentSectionPath` : section courante.

## Autocomplétion

`latexExtensions({ completion: { sources: () => index, currentFile: () => path } })` (ou `latexAutocomplete(…)` seul ; `completion: false` la retire). Les sources sont fournies par l'application via `CompletionSources` ; `ProjectIndex` en est une implémentation mise à jour à la volée :

```ts
const index = new ProjectIndex()
index.setFiles(paths) // arborescence (binaires compris) ; retire les fichiers disparus
index.setFile('refs.bib', text) // .bib : clés ; .tex/.sty/.cls : labels, \newcommand, environnements, packages
index.renameFile(from, to)
index.setPackageNames(names) // index TeX Live servi par l'API, proposé après \usepackage{
```

- Commandes : LaTeX de base, symboles du sélecteur, commandes des packages chargés dans le projet ou le fichier (`PACKAGE_COMPLETIONS`, dépendances implicites `PACKAGE_IMPLIES` : mathtools → amsmath, beamer → hyperref…), commandes définies dans le projet ; snippets avec champs (Tab).
- `\begin{` : environnements (même logique) ; `\end{` : l'environnement ouvert en tête.
- `\ref`, `\eqref`, `\autoref`, `\cref`, `\Cref`, `\pageref`, `\nameref`, `\vref`… : labels de tous les fichiers (contexte et `fichier:ligne`) ; listes `\cref{a,|`.
- `\cite`, `\citep`, `\citet`, `\parencite`, `\textcite`, `\autocite`… : clés de tous les .bib (auteurs, année, titre) ; listes `\cite{a,|`. Listes calculées une fois par version de l'index : `\cite{` répond en moins de 100 ms sur 5 000 clés (test).
- Chemins relatifs au dossier du document principal (`rootDirectory()` des sources : LaTeX et texcount y tournent ; fichiers hors de ce dossier en `../…`, proposés en dernier ; pour `\includegraphics`, aussi relatifs aux dossiers de `\graphicspath`, en premier) : `\input`/`\include` (.tex, sans extension), `\includegraphics` (png, jpg, pdf, eps), `\bibliography` (.bib sans extension), `\addbibresource`, `\lstinputlisting`… ; `\usepackage{` : packages connus et index TeX Live ; `\documentclass{` : classes courantes.
- `parseBibtex(text)` : BibTeX et biblatex tolérants (accolades imbriquées, guillemets, `@string` et concaténation `#`, mois, `@comment`, `@preamble`, parenthèses, clés `a:b/c+d`, commentaires `%`), erreurs avec ligne et reprise à l'entrée suivante, doublons signalés ; `bibtexToText`, `shortAuthors` pour l'affichage.

## Correcteur orthographique

Hunspell (hunspell-asm, WebAssembly) dans un Web Worker ; dictionnaires fr et en (paquets `dictionary-fr`, `dictionary-en`) servis par l'application, chargés à la première vérification de la langue.

```ts
// Fichier du worker (application) :
import { startSpellcheckWorker } from '@kaxolax/editor/spellcheck-worker'
startSpellcheckWorker(self, { dictionaryUrl: (language) => `/dictionaries/${language}` }) // .aff et .dic
// Page :
const client = new SpellcheckClient(new Worker(new URL('./spellcheck.worker.ts', import.meta.url)))
await client.setPersonalDictionary(preferences.spellcheckDictionary)
const spellcheck = { client, language: project.spellcheckLanguage, onMenu, onAddToDictionary }
reconfigureEditor(view, editorSettings(preferences.editor, preferences.theme, spellcheck))
```

- `extractWords(doc)` : mots à vérifier (lettres Unicode, apostrophes et traits d'union internes) hors commandes et arguments non textuels (`\label`, `\ref`, `\cite…`, `\usepackage`, `\begin{…}` et spécification de colonnes, chemins, URL, couleurs, longueurs, définitions de commandes), maths (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`, `equation`, `align`…), commentaires, verbatim (`\verb`, `verbatim`, `lstlisting`, `minted`), dessins (`tikzpicture`). Ignorés aussi : sigles et mots à majuscule interne (`CNRS`, `LaTeX`), mots d'une lettre, mots collés à un chiffre ou à un accent en commande (`caf\'e`).
- Protocole (`protocol.ts`) : `check` (mots inconnus), `suggest`, `personal` (dictionnaire personnel) ; messages validés des deux côtés, erreurs `E_BAD_REQUEST`, `E_DICTIONARY_UNAVAILABLE`, `E_INTERNAL`. `SpellService` (cœur du worker, moteur injecté) : un chargement par langue, résultats mémorisés, mot composé correct si ses parties le sont. `SpellcheckClient` : seuls les mots jamais vus partent au worker, délai maximal, `subscribe` (revérification quand le dictionnaire personnel change).
- Extension `spellcheck(config)` (compartiment `spellcheckCompartment`, `reconfigureEditor({ spellcheck: config | null })`) : vérification après une pause de frappe, soulignement `.cm-spellError` retiré dès qu'un mot est modifié ; clic droit sur un mot souligné → `onMenu({ word, x, y, suggestions(), replace(text), addToDictionary() })` ; `openSpellcheckMenu(view)` pour le clavier ou un menu.
- Dictionnaire personnel : préférence `spellcheckDictionary` (1 000 mots de 40 caractères au plus, 20 Kio sérialisé), `addPersonalWord`, `removePersonalWord` ; `personalWordStatus` dit si l'ajout est possible (`ok`, `invalid`, `duplicate`, `full`) : plein, l'ajout est refusé, aucun mot ancien ne sort.

## Paramètres de l'éditeur

`editorSettings(preferences.editor, theme, spellcheck?)` traduit les préférences (`@kaxolax/contracts`) en réglages appliqués à chaud par `reconfigureEditor` : thème clair ou sombre, thème de coloration (`SYNTAX_THEMES` : Kaxolax, Classique, Solarized, Monokai, Contraste élevé), police (`EDITOR_FONTS` ou nom saisi, filtré), taille et hauteur de ligne (bornées), raccourcis (`keymapCompartment` : défaut, Vim avec `@replit/codemirror-vim`, Emacs avec `@replit/codemirror-emacs`, priorité la plus haute), retour à la ligne, correcteur (null si `editor.spellcheck` est faux). Le document, l'historique et les curseurs sont conservés.

## Gestionnaire de packages

- `projectPackages(doc)` : un élément par package (`\usepackage` et `\RequirePackage`, plusieurs par ligne ou par commande, listes sur plusieurs lignes avec commentaires), options, ligne, commande partagée ou non.
- `planRemovePackage` / `removePackage(view, name)` : commande seule retirée avec ses options et sa ligne (commentaire de fin compris) ; dans une liste, seul le nom part, mise en forme conservée (options partagées signalées : `sharedOptions`) ; toutes les occurrences. `planPackageOptions` / `setPackageOptions` : options d'un package chargé seul. Ajout avec options : `addPackage(view, name, options)`. Une étape d'annulation par opération.
- Action `packages.manager` (« Gestionnaire de packages », menu Packages) : `host.openDialog('packages.manager', packageManagerPayload)` ; les suggestions pour un nom mal écrit viennent de l'API (`GET /texlive/suggestions`).
