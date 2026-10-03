import {
  EditorSelection,
  EditorState,
  type Extension,
  Prec,
  StateEffect,
  StateField,
  type Transaction,
} from '@codemirror/state'
import {
  Decoration,
  type DecorationSet,
  EditorView,
  hoverTooltip,
  keymap,
  type Tooltip,
  WidgetType,
} from '@codemirror/view'

/**
 * Suivi des modifications dans l'éditeur (mode Suggérer) :
 *
 * - en mode Suggérer, toute modification locale du texte (frappe, collage, autocomplétion, action
 *   de la barre Tools…) est interceptée avant d'atteindre le document : la transaction est
 *   remplacée par un simple déplacement du curseur et la modification est remise à l'application
 *   (`onEdit`), qui en fait une suggestion (`recordSuggestionEdit` de @kaxolax/collab) ; le texte
 *   partagé (Y.Text) ne change pas. Seules les transactions distantes (`isRemote` : mises à jour
 *   Yjs des collaborateurs, acceptation d'une suggestion) passent ;
 * - affichage en ligne : texte supprimé barré, texte ajouté en widget, à la couleur de présence
 *   de l'auteur ; info-bulle (auteur, date, Accepter / Refuser / Retirer) au survol ;
 * - raccourcis : Ctrl+Alt+Entrée accepte et Ctrl+Alt+Maj+Entrée refuse la suggestion sous le
 *   curseur (Cmd+Option sur macOS) ; Ctrl+Z en mode Suggérer annule la suggestion en cours
 *   (`onUndo`) au lieu de l'historique du texte.
 *
 * Les plages viennent de l'application, qui résout les ancres (positions relatives Yjs) après
 * chaque modification et les envoie par `setSuggestionMarks` ; entre deux envois, elles suivent
 * les modifications distantes.
 */

/** Suggestion affichée : plage du texte d'origine dans le document courant et texte proposé. */
export interface SuggestionMark {
  id: string
  kind: 'insert' | 'delete' | 'replace'
  /** Début et fin du texte d'origine (égaux pour une insertion : le point d'insertion). */
  from: number
  to: number
  proposedText: string
  authorName: string
  /** Couleur CSS de présence de l'auteur (`var(--presence-N)`). */
  color: string
  /** Libellé de la date (déjà formaté), ou null pour un brouillon pas encore enregistré. */
  dateLabel: string | null
  /** Suggestion de l'utilisateur courant : il peut la retirer. */
  mine: boolean
  /** Brouillon en cours de saisie (pas encore de décision possible). */
  draft: boolean
}

/** Remplacement de [from, to[ par `insert`. */
export interface TextEdit {
  from: number
  to: number
  insert: string
}

/** Modification interceptée en mode Suggérer, en coordonnées du document (texte courant). */
export interface InterceptedEdit extends TextEdit {
  /** Position du curseur après la modification (le texte, lui, n'a pas bougé). */
  cursor: number
}

/** Remplace les suggestions affichées. */
export const setSuggestionMarks = StateEffect.define<readonly SuggestionMark[]>()
/** Suggestion mise en avant (sélectionnée dans le panneau Review), ou aucune. */
export const setActiveSuggestion = StateEffect.define<string | null>()
/** Active ou désactive le mode Suggérer. */
export const setSuggestMode = StateEffect.define<boolean>()
/** Modification interceptée (transportée par la transaction de remplacement). */
const interceptedEdit = StateEffect.define<InterceptedEdit>()

interface SuggestionState {
  marks: readonly SuggestionMark[]
  active: string | null
  suggesting: boolean
}

function validMark(mark: SuggestionMark, length: number): boolean {
  if (mark.from < 0 || mark.to > length || mark.to < mark.from) return false
  return mark.kind === 'insert' ? mark.from === mark.to : mark.to > mark.from
}

const suggestionField = StateField.define<SuggestionState>({
  create: () => ({ marks: [], active: null, suggesting: false }),
  update(value, transaction) {
    let { marks, active, suggesting } = value
    if (transaction.docChanged) {
      marks = marks.flatMap((mark) => {
        // Un point d'insertion suit le texte qui le suit ; une plage ne s'étend pas.
        const from = transaction.changes.mapPos(mark.from, 1)
        const to =
          mark.kind === 'insert' ? from : Math.max(from, transaction.changes.mapPos(mark.to, -1))
        const next = { ...mark, from, to }
        return validMark(next, transaction.state.doc.length) ? [next] : []
      })
    }
    for (const effect of transaction.effects) {
      if (effect.is(setSuggestionMarks)) {
        const length = transaction.state.doc.length
        marks = effect.value.filter((mark) => validMark(mark, length))
      } else if (effect.is(setActiveSuggestion)) active = effect.value
      else if (effect.is(setSuggestMode)) suggesting = effect.value
    }
    return marks === value.marks && active === value.active && suggesting === value.suggesting
      ? value
      : { marks, active, suggesting }
  },
})

/** Vrai si le mode Suggérer est actif dans cet état. */
export function isSuggesting(state: EditorState): boolean {
  return state.field(suggestionField, false)?.suggesting ?? false
}

/** Suggestions affichées (après les modifications distantes). */
export function suggestionMarks(state: EditorState): readonly SuggestionMark[] {
  return state.field(suggestionField, false)?.marks ?? []
}

/**
 * Suggestions à la position `pos` (texte d'origine qui la contient, ou point d'insertion à cette
 * position), la plus courte d'abord ; les brouillons ne comptent pas.
 */
export function suggestionsAt(state: EditorState, pos: number): SuggestionMark[] {
  return suggestionMarks(state)
    .filter((mark) => !mark.draft && mark.from <= pos && pos <= mark.to)
    .sort((a, b) => a.to - a.from - (b.to - b.from))
}

class InsertionWidget extends WidgetType {
  constructor(
    readonly mark: SuggestionMark,
    readonly active: boolean,
  ) {
    super()
  }

  override eq(other: InsertionWidget): boolean {
    return (
      other.mark.id === this.mark.id &&
      other.mark.proposedText === this.mark.proposedText &&
      other.mark.color === this.mark.color &&
      other.mark.draft === this.mark.draft &&
      other.mark.authorName === this.mark.authorName &&
      other.active === this.active
    )
  }

  toDOM(): HTMLElement {
    const element = document.createElement('ins')
    element.className = `cm-suggestion-insert${this.active ? ' cm-suggestion-active' : ''}${
      this.mark.draft ? ' cm-suggestion-draft' : ''
    }`
    element.textContent = this.mark.proposedText
    element.style.setProperty('--suggestion-color', this.mark.color)
    element.dataset.suggestionId = this.mark.id
    element.title = `Ajout suggéré par ${this.mark.authorName}`
    return element
  }

  override ignoreEvent(): boolean {
    return false
  }
}

function decorationsOf(state: EditorState): DecorationSet {
  const { marks, active } = state.field(suggestionField)
  const ranges = []
  for (const mark of marks) {
    const isActive = mark.id === active
    if (mark.to > mark.from) {
      ranges.push(
        Decoration.mark({
          class: `cm-suggestion-delete${isActive ? ' cm-suggestion-active' : ''}${
            mark.draft ? ' cm-suggestion-draft' : ''
          }`,
          attributes: {
            style: `--suggestion-color: ${mark.color}`,
            'data-suggestion-id': mark.id,
            title: `Suppression suggérée par ${mark.authorName}`,
          },
        }).range(mark.from, mark.to),
      )
    }
    if (mark.proposedText !== '') {
      // Avant le curseur placé à la fin de la plage : la saisie suivante prolonge le texte ajouté.
      ranges.push(
        Decoration.widget({ widget: new InsertionWidget(mark, isActive), side: -1 }).range(mark.to),
      )
    }
  }
  return Decoration.set(ranges, true)
}

const suggestionTheme = EditorView.baseTheme({
  '.cm-suggestion-delete': {
    textDecoration: 'line-through',
    textDecorationColor: 'var(--suggestion-color)',
    textDecorationThickness: '2px',
    backgroundColor: 'color-mix(in oklab, var(--suggestion-color) 14%, transparent)',
    opacity: '0.75',
  },
  '.cm-suggestion-insert': {
    textDecoration: 'underline',
    textDecorationColor: 'var(--suggestion-color)',
    textDecorationThickness: '2px',
    textUnderlineOffset: '3px',
    backgroundColor: 'color-mix(in oklab, var(--suggestion-color) 22%, transparent)',
    color: 'inherit',
    whiteSpace: 'pre-wrap',
  },
  '.cm-suggestion-draft': {
    textDecorationStyle: 'dashed',
  },
  '.cm-suggestion-active': {
    outline: '2px solid var(--suggestion-color)',
    outlineOffset: '1px',
    borderRadius: '2px',
  },
  '.cm-tooltip.cm-suggestion-tooltip': {
    padding: '6px 8px',
    borderRadius: '6px',
    fontFamily: 'var(--font-sans, system-ui, sans-serif)',
    fontSize: '12px',
    lineHeight: '1.4',
    maxWidth: '320px',
  },
  '.cm-suggestion-tooltip-item + .cm-suggestion-tooltip-item': {
    marginTop: '6px',
    paddingTop: '6px',
    borderTop: '1px solid color-mix(in oklab, currentColor 20%, transparent)',
  },
  '.cm-suggestion-tooltip-author': {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontWeight: '600',
  },
  '.cm-suggestion-tooltip-dot': {
    width: '8px',
    height: '8px',
    borderRadius: '9999px',
    backgroundColor: 'var(--suggestion-color)',
    flexShrink: '0',
  },
  '.cm-suggestion-tooltip-meta': { opacity: '0.75' },
  '.cm-suggestion-tooltip-actions': { display: 'flex', gap: '4px', marginTop: '4px' },
  '.cm-suggestion-tooltip-actions button': {
    font: 'inherit',
    padding: '1px 8px',
    borderRadius: '4px',
    border: '1px solid color-mix(in oklab, currentColor 30%, transparent)',
    background: 'transparent',
    color: 'inherit',
    cursor: 'pointer',
  },
  '.cm-suggestion-tooltip-actions button:hover, .cm-suggestion-tooltip-actions button:focus-visible':
    {
      backgroundColor: 'color-mix(in oklab, currentColor 12%, transparent)',
    },
})

const KIND_LABELS: Record<SuggestionMark['kind'], string> = {
  insert: 'Ajout',
  delete: 'Suppression',
  replace: 'Remplacement',
}

/** Décision prise depuis l'éditeur (info-bulle ou raccourci). */
export type SuggestionAction = 'accept' | 'reject' | 'withdraw'

export interface SuggestionExtensionOptions {
  /** Transaction distante (mise à jour Yjs reçue) : jamais interceptée. */
  isRemote: (transaction: Transaction) => boolean
  /** Modification interceptée en mode Suggérer (appelée après la mise à jour de la vue). */
  onEdit: (edit: InterceptedEdit) => void
  /** Ctrl+Z en mode Suggérer : annuler la suggestion en cours plutôt que le texte. */
  onUndo?: () => void
  /** Vrai si l'utilisateur accepte ou refuse (lu à chaque affichage). */
  canDecide: () => boolean
  /** Accepter, refuser ou retirer une suggestion. */
  onAction?: (id: string, action: SuggestionAction) => void
  /** Clic dans une suggestion. */
  onSelect?: (id: string) => void
}

function tooltipButton(label: string, title: string, run: () => void): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = label
  button.title = title
  button.addEventListener('mousedown', (event) => {
    // Le clic ne déplace pas le curseur de l'éditeur.
    event.preventDefault()
  })
  button.addEventListener('click', (event) => {
    event.preventDefault()
    run()
  })
  return button
}

function tooltipFor(
  marks: readonly SuggestionMark[],
  options: SuggestionExtensionOptions,
  view: EditorView,
): HTMLElement {
  const dom = document.createElement('div')
  dom.className = 'cm-suggestion-tooltip'
  dom.setAttribute('role', 'group')
  dom.setAttribute('aria-label', 'Suggestion')
  for (const mark of marks) {
    const item = document.createElement('div')
    item.className = 'cm-suggestion-tooltip-item'
    item.style.setProperty('--suggestion-color', mark.color)
    item.dataset.suggestionId = mark.id
    const author = document.createElement('div')
    author.className = 'cm-suggestion-tooltip-author'
    const dot = document.createElement('span')
    dot.className = 'cm-suggestion-tooltip-dot'
    dot.setAttribute('aria-hidden', 'true')
    const name = document.createElement('span')
    name.textContent = mark.authorName
    author.append(dot, name)
    const meta = document.createElement('div')
    meta.className = 'cm-suggestion-tooltip-meta'
    meta.textContent =
      mark.dateLabel === null
        ? `${KIND_LABELS[mark.kind]} · en cours`
        : `${KIND_LABELS[mark.kind]} · ${mark.dateLabel}`
    item.append(author, meta)
    const actions = document.createElement('div')
    actions.className = 'cm-suggestion-tooltip-actions'
    const act = (action: SuggestionAction) => () => {
      options.onAction?.(mark.id, action)
      view.focus()
    }
    if (options.onAction && options.canDecide()) {
      actions.append(
        tooltipButton('Accepter', 'Accepter (Ctrl+Alt+Entrée)', act('accept')),
        tooltipButton('Refuser', 'Refuser (Ctrl+Alt+Maj+Entrée)', act('reject')),
      )
    }
    if (options.onAction && mark.mine) {
      actions.append(tooltipButton('Retirer', 'Retirer ma suggestion', act('withdraw')))
    }
    if (actions.childElementCount > 0) item.append(actions)
    dom.append(item)
  }
  return dom
}

/**
 * Couvre toutes les modifications d'une transaction par une seule : [from, to[ du document de
 * départ remplacé par le texte correspondant du nouveau document (les parties inchangées entre
 * deux modifications sont recopiées telles quelles).
 */
export function coveringEdit(transaction: Transaction): TextEdit | null {
  let fromA = Number.POSITIVE_INFINITY
  let toA = -1
  let fromB = Number.POSITIVE_INFINITY
  let toB = -1
  transaction.changes.iterChangedRanges((startA, endA, startB, endB) => {
    fromA = Math.min(fromA, startA)
    toA = Math.max(toA, endA)
    fromB = Math.min(fromB, startB)
    toB = Math.max(toB, endB)
  })
  if (toA < 0) return null
  return { from: fromA, to: toA, insert: transaction.newDoc.sliceString(fromB, toB) }
}

/** Position du curseur après une modification interceptée (le texte ne bouge pas). */
function cursorAfter(edit: TextEdit, transaction: Transaction): number {
  if (edit.insert !== '') return edit.to
  // Suppression vers l'avant : le curseur passe après le texte barré, sinon il reste avant.
  return transaction.isUserEvent('delete.forward') ? edit.to : edit.from
}

/**
 * Extension du suivi des modifications : affichage des suggestions (`setSuggestionMarks`), mise
 * en avant (`setActiveSuggestion`) et mode Suggérer (`setSuggestMode`, désactivé au départ).
 */
export function suggestionTracking(options: SuggestionExtensionOptions): Extension {
  const decideAtCursor = (action: 'accept' | 'reject') => (view: EditorView) => {
    if (!options.onAction || !options.canDecide()) return false
    const [mark] = suggestionsAt(view.state, view.state.selection.main.head)
    if (mark === undefined) return false
    options.onAction(mark.id, action)
    return true
  }
  const undoInSuggestMode = (view: EditorView) => {
    if (!isSuggesting(view.state)) return false
    options.onUndo?.()
    return true
  }
  const redoInSuggestMode = (view: EditorView) => isSuggesting(view.state)
  return [
    suggestionField,
    EditorView.decorations.compute([suggestionField], decorationsOf),
    suggestionTheme,
    suggestFilter(options),
    EditorView.updateListener.of((update) => {
      for (const transaction of update.transactions) {
        for (const effect of transaction.effects) {
          if (effect.is(interceptedEdit)) options.onEdit(effect.value)
        }
      }
      if (!options.onSelect || !update.selectionSet) return
      if (!update.transactions.some((transaction) => transaction.isUserEvent('select.pointer')))
        return
      const { main } = update.state.selection
      if (!main.empty) return
      const [mark] = suggestionsAt(update.state, main.head)
      if (mark !== undefined) options.onSelect(mark.id)
    }),
    hoverTooltip(
      (view, pos): Tooltip | null => {
        const marks = suggestionMarks(view.state).filter(
          (mark) => !mark.draft && mark.from <= pos && pos <= mark.to,
        )
        if (marks.length === 0) return null
        return {
          pos: Math.min(...marks.map((mark) => mark.from)),
          end: Math.max(...marks.map((mark) => mark.to)),
          above: true,
          create: () => {
            const dom = tooltipFor(marks, options, view)
            return { dom }
          },
        }
      },
      { hoverTime: 250 },
    ),
    Prec.highest(
      keymap.of([
        { key: 'Mod-Alt-Enter', preventDefault: true, run: decideAtCursor('accept') },
        { key: 'Mod-Alt-Shift-Enter', preventDefault: true, run: decideAtCursor('reject') },
        // L'historique Yjs modifierait le texte : en mode Suggérer, Ctrl+Z annule la suggestion en
        // cours et Rétablir ne fait rien (comme le bouton de la barre d'outils).
        { key: 'Mod-z', run: undoInSuggestMode, preventDefault: true },
        { key: 'Mod-y', run: redoInSuggestMode, preventDefault: true },
        { key: 'Mod-Shift-z', run: redoInSuggestMode, preventDefault: true },
      ]),
    ),
  ]
}

/** Filtre des transactions du mode Suggérer (voir `suggestionTracking`). */
function suggestFilter(options: SuggestionExtensionOptions): Extension {
  return EditorState.transactionFilter.of((transaction) => {
    if (!transaction.docChanged || !isSuggesting(transaction.startState)) return transaction
    if (options.isRemote(transaction)) return transaction
    const edit = coveringEdit(transaction)
    if (edit === null) return transaction
    const cursor = cursorAfter(edit, transaction)
    return {
      selection: EditorSelection.cursor(cursor),
      effects: interceptedEdit.of({ ...edit, cursor }),
      scrollIntoView: true,
      userEvent: 'select',
    }
  })
}

/**
 * Coordonnées de la vue de `recordSuggestionEdit` (@kaxolax/collab) : le texte courant où la
 * suggestion en cours de l'utilisateur (`draft` : sa plage d'origine et la longueur du texte
 * proposé) est appliquée. Le document de l'éditeur, lui, reste le texte courant : la plage
 * d'origine y est barrée et le texte proposé affiché en widget juste après.
 *
 * Règles : une position avant la suggestion ne bouge pas, une position après est décalée ; une
 * position dans le texte barré compte au début (début d'une plage modifiée) ou après le texte
 * proposé (fin d'une plage, point d'insertion). Un effacement qui se termine juste après la suggestion (Retour arrière, curseur
 * après le widget) retire d'abord le texte proposé, puis prolonge la suppression vers l'arrière.
 */
export function suggestionViewEdit(
  edit: TextEdit,
  draft: { from: number; to: number; proposedLength: number } | null,
): TextEdit {
  if (draft === null) return { from: edit.from, to: edit.to, insert: edit.insert }
  const shift = draft.proposedLength - (draft.to - draft.from)
  const viewEnd = draft.from + draft.proposedLength
  if (
    edit.insert === '' &&
    edit.to === draft.to &&
    edit.from < edit.to &&
    (edit.from >= draft.from || draft.from === draft.to)
  ) {
    const length = edit.to - edit.from
    return { from: Math.max(0, viewEnd - length), to: viewEnd, insert: '' }
  }
  const map = (position: number, start: boolean) => {
    if (position >= draft.to) return position + shift
    if (position <= draft.from) return position
    return start ? draft.from : viewEnd
  }
  // Point d'insertion dans le texte barré : après le texte proposé.
  const from = map(edit.from, edit.from !== edit.to)
  return { from, to: Math.max(from, map(edit.to, false)), insert: edit.insert }
}
