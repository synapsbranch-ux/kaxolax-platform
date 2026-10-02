import {
  EditorSelection,
  type EditorState,
  type Extension,
  StateEffect,
  StateField,
} from '@codemirror/state'
import { Decoration, type DecorationSet, EditorView } from '@codemirror/view'

/**
 * Surlignage du texte commenté. Les plages viennent de l'application, qui résout les ancres des
 * fils (positions relatives Yjs) dans le document courant et les envoie par `setCommentRanges`
 * après chaque modification ; entre deux envois, les plages suivent les modifications locales.
 * Un clic dans un texte commenté sélectionne son fil (`onSelect`).
 */

/** Plage commentée [from, to[ d'un fil. */
export interface CommentRange {
  id: string
  from: number
  to: number
}

/** Remplace les plages commentées (fils ouverts du document). */
export const setCommentRanges = StateEffect.define<readonly CommentRange[]>()
/** Fil mis en avant (sélectionné dans le panneau Review), ou aucun. */
export const setActiveComment = StateEffect.define<string | null>()

interface CommentHighlightState {
  ranges: readonly CommentRange[]
  active: string | null
}

const commentHighlightField = StateField.define<CommentHighlightState>({
  create: () => ({ ranges: [], active: null }),
  update(value, transaction) {
    let { ranges, active } = value
    if (transaction.docChanged) {
      ranges = ranges.flatMap((range) => {
        const from = transaction.changes.mapPos(range.from, 1)
        const to = transaction.changes.mapPos(range.to, -1)
        return to > from ? [{ id: range.id, from, to }] : []
      })
    }
    for (const effect of transaction.effects) {
      if (effect.is(setCommentRanges)) {
        const length = transaction.state.doc.length
        ranges = effect.value.filter(
          (range) => range.from >= 0 && range.to <= length && range.to > range.from,
        )
      } else if (effect.is(setActiveComment)) active = effect.value
    }
    return ranges === value.ranges && active === value.active ? value : { ranges, active }
  },
})

const highlightMark = Decoration.mark({ class: 'cm-comment-highlight' })
const activeMark = Decoration.mark({ class: 'cm-comment-highlight cm-comment-active' })

function decorationsOf(state: EditorState): DecorationSet {
  const { ranges, active } = state.field(commentHighlightField)
  return Decoration.set(
    ranges.map((range) =>
      (range.id === active ? activeMark : highlightMark).range(range.from, range.to),
    ),
    true,
  )
}

const commentHighlightTheme = EditorView.baseTheme({
  '.cm-comment-highlight': {
    backgroundColor: 'var(--comment-highlight, rgba(250, 204, 21, 0.22))',
    borderBottom: '2px solid var(--comment-highlight-border, rgba(234, 179, 8, 0.7))',
  },
  '.cm-comment-active': {
    backgroundColor: 'var(--comment-highlight-active, rgba(250, 204, 21, 0.45))',
  },
})

/** Fils dont la plage contient `pos`, du plus court au plus long (le plus précis d'abord). */
export function commentsAt(state: EditorState, pos: number): string[] {
  return (
    state
      .field(commentHighlightField, false)
      ?.ranges.filter((range) => range.from <= pos && pos <= range.to)
      .sort((a, b) => a.to - a.from - (b.to - b.from))
      .map((range) => range.id) ?? []
  )
}

/** Plages commentées courantes (après les modifications locales). */
export function commentRanges(state: EditorState): readonly CommentRange[] {
  return state.field(commentHighlightField, false)?.ranges ?? []
}

export interface CommentHighlightOptions {
  /** Clic dans un texte commenté : le fil le plus précis à cet endroit. */
  onSelect?: (threadId: string) => void
}

/** Extension de surlignage des commentaires (voir `setCommentRanges`, `setActiveComment`). */
export function commentHighlights(options: CommentHighlightOptions = {}): Extension {
  return [
    commentHighlightField,
    EditorView.decorations.compute([commentHighlightField], decorationsOf),
    commentHighlightTheme,
    EditorView.updateListener.of((update) => {
      if (!options.onSelect || !update.selectionSet) return
      if (!update.transactions.some((transaction) => transaction.isUserEvent('select.pointer')))
        return
      const { main } = update.state.selection
      if (!main.empty) return
      const [id] = commentsAt(update.state, main.head)
      if (id !== undefined) options.onSelect(id)
    }),
  ]
}

/** Sélection principale à commenter : texte non vide, ou null. */
export function commentableSelection(
  state: EditorState,
): { from: number; to: number; text: string } | null {
  const { main } = state.selection
  if (main.empty) return null
  return { from: main.from, to: main.to, text: state.sliceDoc(main.from, main.to) }
}

/** Sélectionne une plage commentée et la fait défiler au centre. */
export function revealComment(view: EditorView, from: number, to: number): void {
  const length = view.state.doc.length
  const start = Math.min(Math.max(0, from), length)
  const end = Math.min(Math.max(start, to), length)
  view.dispatch({
    selection: EditorSelection.range(start, end),
    effects: EditorView.scrollIntoView(start, { y: 'center' }),
  })
}
