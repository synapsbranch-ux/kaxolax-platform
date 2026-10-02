import { isolateHistory } from '@codemirror/commands'
import { getIndentUnit, indentString } from '@codemirror/language'
import {
  EditorSelection,
  type EditorState,
  type SelectionRange,
  type StateCommand,
  type Transaction,
  type TransactionSpec,
} from '@codemirror/state'
import { planPackage } from '../packages.js'
import { indentationOf } from '../scan.js'

/** Marque de position du curseur dans les modèles (`\caption{${CURSOR}}`). */
export const CURSOR = '‸'

/** Événement utilisateur des transactions produites par les actions. */
export const ACTION_USER_EVENT = 'input.action'

/**
 * Vrai pour une transaction produite par une action du registre. Avec un historique Yjs
 * (`Y.UndoManager`), appeler `stopCapturing()` sur ces transactions garde une étape d'annulation
 * par action.
 */
export function isActionTransaction(transaction: Transaction): boolean {
  return transaction.isUserEvent(ACTION_USER_EVENT)
}

/** Construit les modifications à partir de l'état, ou null si l'action ne s'applique pas. */
export type EditBuilder = (state: EditorState) => TransactionSpec | null

/** Package à charger dans le préambule avec une action (`align` demande amsmath). */
export interface RequiredPackage {
  name: string
  options?: string[]
}

/**
 * Commande qui applique `build` en une seule transaction : une étape d'annulation isolée,
 * défilement vers la sélection. Les packages requis absents du préambule sont ajoutés dans la même
 * transaction (rien n'est ajouté dans un fichier sans préambule).
 */
export function editCommand(
  build: EditBuilder,
  packages: readonly RequiredPackage[] = [],
): StateCommand {
  return ({ state, dispatch }) => {
    if (state.readOnly) return false
    const spec = build(state)
    if (spec === null) return false
    const extra: TransactionSpec[] = []
    for (const required of packages) {
      const plan = planPackage(state.doc, required.name, required.options)
      if (plan.status === 'insert' || plan.status === 'update') extra.push({ changes: plan.change })
    }
    dispatch(
      state.update(spec, ...extra, {
        userEvent: ACTION_USER_EVENT,
        annotations: isolateHistory.of('full'),
        scrollIntoView: true,
      }),
    )
    return true
  }
}

/** Position après coup : début du texte inséré par `changes[change]`, plus `offset`. */
interface Marker {
  change: number
  offset: number
}

/** Modification d'une plage de la sélection, en coordonnées du document d'origine. */
interface RangeEdit {
  changes: { from: number; to?: number; insert?: string }[]
  /** Sélection après coup ; absente : la plage d'origine, projetée. */
  ranges?: { anchor: Marker; head?: Marker }[]
}

/** Applique `edit` à chaque plage de la sélection (null : plage inchangée). */
function editRanges(
  state: EditorState,
  edit: (range: SelectionRange) => RangeEdit | null,
): TransactionSpec | null {
  const edits = state.selection.ranges.map(edit)
  if (edits.every((item) => item === null)) return null
  const changes = state.changes(edits.flatMap((item) => item?.changes ?? []))
  const ranges: SelectionRange[] = []
  let mainIndex = 0
  state.selection.ranges.forEach((range, index) => {
    const item = edits[index]
    if (index === state.selection.mainIndex) mainIndex = ranges.length
    if (!item?.ranges || item.ranges.length === 0) {
      ranges.push(range.map(changes))
      return
    }
    const position = (marker: Marker) =>
      changes.mapPos(item.changes[marker.change]?.from ?? range.from, -1) + marker.offset
    for (const { anchor, head } of item.ranges) {
      ranges.push(EditorSelection.range(position(anchor), position(head ?? anchor)))
    }
  })
  return { changes, selection: EditorSelection.create(ranges, mainIndex) }
}

/** Retire les marques de curseur d'un texte et renvoie leurs positions. */
function extractCursors(text: string): { text: string; cursors: number[] } {
  const [first = '', ...rest] = text.split(CURSOR)
  const cursors: number[] = []
  let out = first
  for (const part of rest) {
    cursors.push(out.length)
    out += part
  }
  return { text: out, cursors }
}

/** Accolades équilibrées (hors `\{` et `\}`). */
function balanced(text: string): boolean {
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\\') i++
    else if (ch === '{') depth++
    else if (ch === '}' && --depth < 0) return false
  }
  return depth === 0
}

/**
 * Enrobe chaque sélection de `before`…`after` (`\textbf{`…`}`) en gardant le texte sélectionné ;
 * sans sélection, insère l'enrobage avec le curseur au milieu. Si la sélection est déjà enrobée
 * (à l'intérieur ou à l'extérieur), l'enrobage est retiré.
 */
export function toggleWrap(before: string, after: string): EditBuilder {
  return (state) =>
    editRanges(state, ({ from, to, empty }) => {
      const doc = state.doc
      const outside =
        from >= before.length &&
        doc.sliceString(from - before.length, from) === before &&
        doc.sliceString(to, to + after.length) === after
      if (outside && balanced(doc.sliceString(from, to))) {
        return {
          changes: [
            { from: from - before.length, to: from },
            { from: to, to: to + after.length },
          ],
          ranges: [{ anchor: { change: 0, offset: 0 }, head: { change: 1, offset: 0 } }],
        }
      }
      if (empty) {
        return {
          changes: [{ from, insert: before + after }],
          ranges: [{ anchor: { change: 0, offset: before.length } }],
        }
      }
      const text = doc.sliceString(from, to)
      if (
        text.length >= before.length + after.length &&
        text.startsWith(before) &&
        text.endsWith(after) &&
        balanced(text.slice(before.length, text.length - after.length))
      ) {
        return {
          changes: [
            { from, to: from + before.length },
            { from: to - after.length, to },
          ],
          ranges: [{ anchor: { change: 0, offset: 0 }, head: { change: 1, offset: 0 } }],
        }
      }
      return {
        changes: [
          { from, insert: before },
          { from: to, insert: after },
        ],
        ranges: [{ anchor: { change: 0, offset: before.length }, head: { change: 1, offset: 0 } }],
      }
    })
}

/**
 * Insère `before` + sélection + `after` (`\frac{` … `}{‸}`). Sans sélection, le curseur va à la
 * première marque `CURSOR` de `before`, sinon à la place de la sélection. Avec une sélection, il va
 * aux marques de `before` et `after`, sinon la sélection est gardée. La sélection n'est jamais
 * réécrite (les ancres de commentaires restent valides).
 */
export function inlineSnippet(before: string, after: string): EditBuilder {
  const head = extractCursors(before)
  const tail = extractCursors(after)
  return (state) =>
    editRanges(state, ({ from, to, empty }) => {
      if (empty) {
        const offset = head.cursors.length > 0 ? head.cursors : [head.text.length]
        return {
          changes: [{ from, insert: head.text + tail.text }],
          ranges: offset.map((cursor) => ({ anchor: { change: 0, offset: cursor } })),
        }
      }
      const ranges = [
        ...head.cursors.map((offset) => ({ anchor: { change: 0, offset } })),
        ...tail.cursors.map((offset) => ({ anchor: { change: 1, offset } })),
      ]
      return {
        changes: [
          { from, insert: head.text },
          { from: to, insert: tail.text },
        ],
        ranges:
          ranges.length > 0
            ? ranges
            : [{ anchor: { change: 0, offset: head.text.length }, head: { change: 1, offset: 0 } }],
      }
    })
}

/** Environnement ou bloc de lignes inséré par une action. */
export interface BlockTemplate {
  /** Lignes avant le contenu ; chaque `\t` en tête vaut un niveau d'indentation. */
  before: readonly string[]
  /** Lignes après le contenu. */
  after: readonly string[]
  /** Contenu quand la sélection est vide (marque `CURSOR` pour le curseur). */
  body?: readonly string[]
  /** Niveau d'indentation des lignes sélectionnées placées dans le bloc (1 par défaut). */
  depth?: number
  /** Préfixe de chaque ligne sélectionnée non vide (`\item `). */
  linePrefix?: string
}

/** Remplace les tabulations de tête d'un modèle par l'unité d'indentation de l'éditeur. */
function expandIndent(state: EditorState, line: string): string {
  return line.replace(/^\t+/, (tabs) => indentString(state, tabs.length * getIndentUnit(state)))
}

/**
 * Bloc pour une plage : insertion (sélection vide, ou remplacée si `replace`) ou enrobage des
 * lignes sélectionnées.
 */
function blockEdit(
  state: EditorState,
  { from, to, empty }: SelectionRange,
  template: BlockTemplate,
  replace: boolean,
): RangeEdit {
  const doc = state.doc
  const startLine = doc.lineAt(from)
  const base = indentationOf(startLine.text)
  const pre = doc.sliceString(startLine.from, from)
  const atLineStart = pre.trim() === ''

  if (empty || replace) {
    // Le bloc occupe ses propres lignes : en début de ligne, il prend la place de l'indentation ;
    // le texte qui suit le curseur passe à la ligne suivante.
    const toLine = doc.lineAt(to)
    const post = doc.sliceString(to, toLine.to)
    const rest = post.trimStart()
    const lines = [...template.before, ...(template.body ?? []), ...template.after]
    const block =
      (atLineStart ? '' : '\n') +
      lines.map((line) => base + expandIndent(state, line)).join('\n') +
      (rest === '' ? '' : `\n${base}`)
    const { text, cursors } = extractCursors(block)
    return {
      changes: [
        {
          from: atLineStart ? startLine.from : from,
          to: rest === '' ? toLine.to : to + post.length - rest.length,
          insert: text,
        },
      ],
      ranges: (cursors.length > 0 ? cursors : [text.length]).map((offset) => ({
        anchor: { change: 0, offset },
      })),
    }
  }

  // Dernière ligne : une sélection qui finit en début de ligne s'arrête à la ligne d'avant.
  let endLine = doc.lineAt(to)
  if (to === endLine.from && endLine.number > startLine.number) {
    endLine = doc.line(endLine.number - 1)
  }
  const end = Math.min(to, endLine.to)
  const post = doc.sliceString(end, endLine.to)
  const bodyIndent = indentString(state, (template.depth ?? 1) * getIndentUnit(state))
  const prefix = template.linePrefix ?? ''

  // En début de ligne, l'en-tête s'insère après l'indentation de la première ligne.
  const insertAt = atLineStart ? Math.min(startLine.from + base.length, end) : from
  const header = extractCursors(
    (atLineStart ? '' : `\n${base}`) +
      template.before
        .map((line, index) => (index === 0 ? '' : base) + expandIndent(state, line))
        .join('\n') +
      `\n${base}${bodyIndent}${prefix}`,
  )
  const footer = extractCursors(
    template.after.map((line) => `\n${base}${expandIndent(state, line)}`).join('') +
      (post.trim() === '' ? '' : `\n${base}`),
  )
  const changes: RangeEdit['changes'] = [{ from: insertAt, insert: header.text }]
  for (let number = startLine.number + 1; number <= endLine.number; number++) {
    const line = doc.line(number)
    if (line.text.trim() === '') continue
    changes.push({ from: line.from, insert: bodyIndent })
    if (prefix !== '') {
      changes.push({ from: line.from + indentationOf(line.text).length, insert: prefix })
    }
  }
  changes.push({ from: end, insert: footer.text })
  const footerIndex = changes.length - 1
  const ranges = [
    ...header.cursors.map((offset) => ({ anchor: { change: 0, offset } })),
    ...footer.cursors.map((offset) => ({ anchor: { change: footerIndex, offset } })),
  ]
  return ranges.length > 0 ? { changes, ranges } : { changes }
}

/**
 * Insère un bloc sur ses propres lignes, à l'indentation de la ligne courante. Avec une sélection,
 * les lignes sélectionnées deviennent le contenu du bloc : seuls l'en-tête, la fin et
 * l'indentation sont insérés (le texte sélectionné n'est pas réécrit). Les marques `CURSOR` de
 * l'en-tête et de la fin placent le curseur, sinon la sélection d'origine est gardée.
 */
export function insertBlock(template: BlockTemplate): EditBuilder {
  return (state) => editRanges(state, (range) => blockEdit(state, range, template, false))
}

/**
 * Remplace chaque sélection par un bloc construit à partir du texte sélectionné (titre de section,
 * chemin d'image…), sur ses propres lignes.
 */
export function replaceWithBlock(template: (selection: string) => BlockTemplate): EditBuilder {
  return (state) =>
    editRanges(state, (range) =>
      blockEdit(
        state,
        range,
        template(state.sliceDoc(range.from, range.to).replaceAll(CURSOR, '')),
        true,
      ),
    )
}
