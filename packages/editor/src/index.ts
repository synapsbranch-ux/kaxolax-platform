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
import { EditorSelection, EditorState, type Extension } from '@codemirror/state'
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
import { latexFolding } from './folding.js'
import { latexHighlighting, latexLanguage, latexLanguageData } from './language.js'

export { findFoldRange, latexFolding } from './folding.js'
export { latexHighlightStyle, latexLanguage } from './language.js'

export interface LatexEditorOptions {
  /** Ctrl+Entrée (Cmd+Entrée sur macOS) : recompiler. */
  onCompile?: () => void
  /** Lecture seule (rôles viewer et reviewer). */
  readOnly?: boolean
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
export function latexExtensions(
  options: LatexEditorOptions & { sharedHistory?: boolean } = {},
): Extension[] {
  return [
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
    latexHighlighting,
    bracketMatching(),
    closeBrackets(),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    EditorView.lineWrapping,
    EditorState.readOnly.of(options.readOnly === true),
    EditorView.editable.of(options.readOnly !== true),
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

/** Place le curseur au début d'une ligne (1 = première) et la fait défiler au centre. */
export function goToLine(view: EditorView, line: number): void {
  const target = view.state.doc.line(Math.min(Math.max(1, line), view.state.doc.lines))
  view.dispatch({
    selection: EditorSelection.cursor(target.from),
    effects: EditorView.scrollIntoView(target.from, { y: 'center' }),
  })
  view.focus()
}
