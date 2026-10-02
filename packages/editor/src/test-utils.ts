import { history, undo } from '@codemirror/commands'
import { EditorSelection, EditorState, type Extension, type StateCommand } from '@codemirror/state'

/**
 * Outils de test : un document s'écrit avec `|` pour un curseur et `«…»` pour une sélection
 * (plusieurs plages possibles).
 */
export function stateOf(marked: string, extensions: Extension = []): EditorState {
  const ranges: { anchor: number; head: number }[] = []
  let doc = ''
  let open: number | null = null
  for (const ch of marked) {
    if (ch === '|') ranges.push({ anchor: doc.length, head: doc.length })
    else if (ch === '«') open = doc.length
    else if (ch === '»' && open !== null) {
      ranges.push({ anchor: open, head: doc.length })
      open = null
    } else doc += ch
  }
  if (ranges.length === 0) ranges.push({ anchor: 0, head: 0 })
  return EditorState.create({
    doc,
    selection: EditorSelection.create(
      ranges.map(({ anchor, head }) => EditorSelection.range(anchor, head)),
    ),
    extensions: [history(), EditorState.allowMultipleSelections.of(true), extensions],
  })
}

/** Document avec ses sélections marquées (inverse de `stateOf`). */
export function marked(state: EditorState): string {
  const marks: { at: number; text: string }[] = []
  for (const range of state.selection.ranges) {
    if (range.empty) marks.push({ at: range.from, text: '|' })
    else marks.push({ at: range.from, text: '«' }, { at: range.to, text: '»' })
  }
  marks.sort((a, b) => b.at - a.at)
  let doc = state.doc.toString()
  for (const { at, text } of marks) doc = doc.slice(0, at) + text + doc.slice(at)
  return doc
}

/** Exécute une commande ; renvoie l'état obtenu (identique si la commande ne s'applique pas). */
export function runCommand(state: EditorState, command: StateCommand): EditorState {
  let next = state
  command({
    state,
    dispatch: (transaction) => {
      next = transaction.state
    },
  })
  return next
}

/** Annule une étape d'historique. */
export function undoOnce(state: EditorState): EditorState {
  return runCommand(state, undo)
}
