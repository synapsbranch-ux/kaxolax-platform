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

- `reconfigureEditor(view, { theme, appearance, readOnly, lineWrapping })` change ces réglages sans recréer l'éditeur.
- `setAutoCompile(view, { enabled, delayMs })` et `autoCompileState(view)` pilotent l'auto-compilation.
- `goToLine(view, line)`, `kaxolaxKeymap`, `findFoldRange` : API de l'étape 1, inchangée.

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

- `ActionHost` : callbacks fournis par l'application (`newFile`, `upload`, `downloadZip`, `searchProject`, `openDialog`, `prompt`, `notify`, `readOnly`). Une action dont le callback manque est désactivée.
- Constructeurs d'actions d'édition (`editCommand`, `toggleWrap`, `inlineSnippet`, `insertBlock`, `replaceWithBlock`, marque `CURSOR`) : une transaction par action, donc une étape d'annulation ; `isActionTransaction` permet d'appeler `stopCapturing()` d'un `Y.UndoManager`.
- `planPackage`, `addPackage`, `loadedPackages`, `findPreamble` : ajout d'un `\usepackage` dans le préambule, sans doublon, options fusionnées.

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
