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

- `ActionHost` : callbacks fournis par l'application (`newFile`, `upload`, `downloadZip`, `searchProject`, `openDialog`, `prompt`, `notify`, `readOnly`). Une action dont le callback manque est désactivée.
- Constructeurs d'actions d'édition (`editCommand`, `toggleWrap`, `inlineSnippet`, `insertBlock`, `replaceWithBlock`, marque `CURSOR`) : une transaction par action, donc une étape d'annulation ; `isActionTransaction` permet d'appeler `stopCapturing()` d'un `Y.UndoManager`.
- `planPackage`, `addPackage`, `loadedPackages`, `findPreamble` : ajout d'un `\usepackage` dans le préambule, sans doublon, options fusionnées.

## Outline

- `extractOutline(doc)` : arbre `{ level, title, shortTitle, starred, line, from, children }` (`\part` à `\subparagraph`), commentaires, préambule et verbatim ignorés.
- `scanOutline(doc)` signale aussi les inclusions (`\input`, `\include`, `\subfile`, `\import`) ; `expandOutline` et `includeCandidates` descendent dans les fichiers inclus fournis par l'application.
- `currentSection(tree, position, file?)` et `currentSectionPath` : section courante.
