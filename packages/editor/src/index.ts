import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
} from '@codemirror/commands'
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from '@codemirror/language'
import { highlightSelectionMatches, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorSelection, EditorState, type Extension } from '@codemirror/state'
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from '@codemirror/view'
import type { ActionHost, ActionRegistry } from './actions/registry.js'
import { autoCompile, type AutoCompileOptions } from './auto-compile.js'
import { latexFolding } from './folding.js'
import { externalCitationSource } from './completion/external-citations.js'
import { latexAutocomplete, type LatexCompletionOptions } from './completion/latex-completion.js'
import { latexLanguage, latexLanguageData } from './language.js'
import { editorKeymap, type EditorKeymapMode } from './settings.js'
import { spellcheck, type SpellcheckConfig, spellcheckConfigOf } from './spellcheck/extension.js'
import {
  type EditorAppearance,
  editorTheme,
  type SyntaxThemeId,
  themeSettings,
  type ThemeMode,
} from './theme.js'

export { findFoldRange, latexFolding } from './folding.js'
export { latexLanguage } from './language.js'
export * from './theme.js'
export * from './auto-compile.js'
export * from './outline.js'
export * from './presence.js'
export * from './comments.js'
export * from './settings.js'
export * from './completion/bibtex.js'
export * from './completion/external-citations.js'
export * from './completion/latex-completion.js'
export * from './completion/latex-data.js'
export * from './completion/project-index.js'
export * from './completion/tex-scan.js'
export * from './spellcheck/client.js'
export * from './spellcheck/extension.js'
export * from './spellcheck/extract.js'
export * from './spellcheck/personal.js'
export * from './spellcheck/protocol.js'
export * from './package-manager.js'
export {
  findPreamble,
  loadedPackages,
  type LoadedPackage,
  type PackagePlan,
  planPackage,
  type Preamble,
  usepackageCommand,
} from './packages.js'
export * from './actions/registry.js'
export {
  addPackage,
  createDefaultRegistry,
  defaultActions,
  FONT_SIZES,
  PACKAGE_MANAGER_DIALOG,
  type PackageManagerPayload,
  packageManagerPayload,
} from './actions/defaults.js'
export * from './actions/writing.js'
export * from './writing/apply.js'
export * from './writing/formula.js'
export * from './writing/formula-library.js'
export * from './writing/math-packages.js'
export * from './writing/mathlive.js'
export * from './writing/symbols.js'
export * from './writing/table-import.js'
export * from './writing/table-latex.js'
export * from './writing/table-model.js'
export * from './writing/track.js'
export {
  ACTION_USER_EVENT,
  type BlockTemplate,
  CURSOR,
  type EditBuilder,
  editCommand,
  inlineSnippet,
  insertBlock,
  isActionTransaction,
  replaceWithBlock,
  type RequiredPackage,
  toggleWrap,
} from './actions/edit.js'

export interface LatexEditorOptions {
  /** Ctrl+Entrée (Cmd+Entrée sur macOS) : recompiler. */
  onCompile?: () => void
  /** Lecture seule (rôles viewer et reviewer). */
  readOnly?: boolean
}

/** Compartiments reconfigurables sans recréer l'éditeur (voir `reconfigureEditor`). */
export const themeCompartment = new Compartment()
export const readOnlyCompartment = new Compartment()
export const lineWrappingCompartment = new Compartment()
export const keymapCompartment = new Compartment()
export const spellcheckCompartment = new Compartment()

/** Extensions de lecture seule (état et DOM). */
function readOnlyExtension(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}

export interface LatexExtensionsOptions extends LatexEditorOptions {
  /** Historique fourni par y-codemirror.next (document partagé). */
  sharedHistory?: boolean
  /** Thème de l'éditeur, sombre par défaut. */
  theme?: ThemeMode
  /** Police, taille et hauteur de ligne (variables CSS de @kaxolax/ui sinon). */
  appearance?: EditorAppearance
  /** Retour à la ligne automatique (activé par défaut). */
  lineWrapping?: boolean
  /** Registre d'actions dont les raccourcis sont liés, avec les callbacks de l'application. */
  actions?: { registry: ActionRegistry; host: ActionHost | (() => ActionHost) }
  /** Compilation automatique après une pause de frappe. */
  autoCompile?: AutoCompileOptions
  /** Thème de coloration syntaxique (`default` : couleurs de @kaxolax/ui). */
  syntaxTheme?: SyntaxThemeId
  /** Raccourcis Vim ou Emacs (`default` : ceux de CodeMirror). */
  keymap?: EditorKeymapMode
  /** Autocomplétion : sources du projet (labels, clés, fichiers) ; `false` la désactive. */
  completion?: LatexCompletionOptions | false
  /** Correcteur orthographique (null ou absent : désactivé). */
  spellcheck?: SpellcheckConfig | null
}

/** Autocomplétion LaTeX, avec la source externe de citations si l'application en fournit une. */
function completionExtension(options: LatexCompletionOptions = {}): Extension {
  const { citationProvider, sources } = options
  const sourcesOf = () => (typeof sources === 'function' ? sources() : (sources ?? null))
  return latexAutocomplete(
    options,
    citationProvider
      ? [externalCitationSource({ provider: citationProvider, sources: sourcesOf })]
      : [],
  )
}

/** Raccourcis propres à Kaxolax. */
export function kaxolaxKeymap(options: LatexEditorOptions): Extension {
  return keymap.of([
    {
      key: 'Mod-Enter',
      preventDefault: true,
      run: () => {
        options.onCompile?.()
        return true
      },
    },
    { key: 'Mod-/', run: toggleComment },
  ])
}

/**
 * Extensions de l'éditeur LaTeX : coloration, recherche et remplacement, repli des environnements
 * et des sections, fermeture des accolades, historique et raccourcis. L'historique d'annulation
 * est fourni par y-codemirror.next quand le document est partagé (`sharedHistory`).
 */
export function latexExtensions(options: LatexExtensionsOptions = {}): Extension[] {
  return [
    keymapCompartment.of(editorKeymap(options.keymap ?? 'default')),
    themeCompartment.of(
      editorTheme(options.theme ?? 'dark', options.appearance, options.syntaxTheme),
    ),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    options.sharedHistory === true ? [] : history(),
    foldGutter(),
    latexFolding,
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    indentOnInput(),
    latexLanguage,
    latexLanguageData,
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    lineWrappingCompartment.of(options.lineWrapping === false ? [] : EditorView.lineWrapping),
    readOnlyCompartment.of(readOnlyExtension(options.readOnly === true)),
    options.completion === false ? [] : completionExtension(options.completion),
    spellcheckCompartment.of(options.spellcheck ? spellcheck(options.spellcheck) : []),
    options.actions ? options.actions.registry.keymap(options.actions.host) : [],
    options.autoCompile ? autoCompile(options.autoCompile) : [],
    kaxolaxKeymap(options),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...(options.sharedHistory === true ? [] : historyKeymap),
      ...foldKeymap,
      indentWithTab,
    ]),
  ]
}

/** Réglages modifiables d'un éditeur créé par `latexExtensions`. */
export interface EditorReconfiguration {
  theme?: ThemeMode
  /** Fusionnée avec la police en place. */
  appearance?: EditorAppearance
  readOnly?: boolean
  lineWrapping?: boolean
  syntaxTheme?: SyntaxThemeId
  keymap?: EditorKeymapMode
  /** Configuration du correcteur, ou null pour le désactiver. */
  spellcheck?: SpellcheckConfig | null
}

/**
 * Change thème, coloration, police, raccourcis, correcteur, lecture seule ou retour à la ligne
 * d'un éditeur sans le recréer (le document, l'historique et les curseurs sont conservés). Les
 * champs absents ne changent pas. Accepte directement le résultat de `editorSettings`.
 */
export function reconfigureEditor(view: EditorView, change: EditorReconfiguration): void {
  const effects = []
  if (
    change.theme !== undefined ||
    change.appearance !== undefined ||
    change.syntaxTheme !== undefined
  ) {
    const current = view.state.facet(themeSettings)
    effects.push(
      themeCompartment.reconfigure(
        editorTheme(
          change.theme ?? current.mode,
          { ...current.appearance, ...change.appearance },
          change.syntaxTheme ?? current.syntax ?? 'default',
        ),
      ),
    )
  }
  if (change.keymap !== undefined) {
    effects.push(keymapCompartment.reconfigure(editorKeymap(change.keymap)))
  }
  // Même configuration du correcteur : rien à recréer (les soulignements restent).
  if (change.spellcheck !== undefined && change.spellcheck !== spellcheckConfigOf(view.state)) {
    effects.push(
      spellcheckCompartment.reconfigure(change.spellcheck ? spellcheck(change.spellcheck) : []),
    )
  }
  if (change.readOnly !== undefined) {
    effects.push(readOnlyCompartment.reconfigure(readOnlyExtension(change.readOnly)))
  }
  if (change.lineWrapping !== undefined) {
    effects.push(
      lineWrappingCompartment.reconfigure(change.lineWrapping ? EditorView.lineWrapping : []),
    )
  }
  if (effects.length > 0) view.dispatch({ effects })
}

/** Place le curseur au début d'une ligne (1 = première) et la fait défiler au centre. */
export function goToLine(view: EditorView, line: number): void {
  const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines))
  view.dispatch({
    selection: EditorSelection.cursor(target.from),
    effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
  })
  view.focus()
}
