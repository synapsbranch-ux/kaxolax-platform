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
import { latexLanguage, latexLanguageData } from './language.js'
import { type EditorAppearance, editorTheme, themeSettings, type ThemeMode } from './theme.js'

export { findFoldRange, latexFolding } from './folding.js'
export { latexLanguage } from './language.js'
export * from './theme.js'
export * from './auto-compile.js'
export * from './outline.js'
export * from './presence.js'
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
} from './actions/defaults.js'
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
    themeCompartment.of(editorTheme(options.theme ?? 'dark', options.appearance)),
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
}

/**
 * Change thème, police, lecture seule ou retour à la ligne d'un éditeur sans le recréer (le
 * document, l'historique et les curseurs sont conservés). Les champs absents ne changent pas.
 */
export function reconfigureEditor(view: EditorView, change: EditorReconfiguration): void {
  const effects = []
  if (change.theme !== undefined || change.appearance !== undefined) {
    const current = view.state.facet(themeSettings)
    effects.push(
      themeCompartment.reconfigure(
        editorTheme(change.theme ?? current.mode, { ...current.appearance, ...change.appearance }),
      ),
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
