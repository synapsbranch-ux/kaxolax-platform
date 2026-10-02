import {
  type CellRange,
  cellAnchor,
  escapeLatex,
  expandRange,
  type FormulaDialogPayload,
  type InsertStatus,
  insertColumn,
  insertRow,
  missingPackages,
  parseDelimited,
  type SymbolsDialogPayload,
  type TableDialogPayload,
  type TableModel,
} from '@kaxolax/editor'
import type { Text } from '@codemirror/state'

/** Outils d'écriture : logique d'interface sans React (gardes, grille, messages). */

function hasKind(payload: unknown, kind: string): boolean {
  return (
    typeof payload === 'object' && payload !== null && (payload as { kind?: unknown }).kind === kind
  )
}

export function isFormulaPayload(payload: unknown): payload is FormulaDialogPayload {
  return hasKind(payload, 'formula')
}

export function isSymbolsPayload(payload: unknown): payload is SymbolsDialogPayload {
  return hasKind(payload, 'symbols')
}

export function isTablePayload(payload: unknown): payload is TableDialogPayload {
  return hasKind(payload, 'table')
}

/** Message à afficher après une insertion (null : rien à signaler, la boîte se ferme). */
export function insertStatusMessage(
  status: InsertStatus,
): { message: string; level: 'info' | 'warning' | 'error' } | null {
  switch (status) {
    case 'inserted':
    case 'replaced':
    case 'unchanged':
      return null
    case 'stale':
      return {
        message:
          'Le texte d’origine a été modifié ou supprimé entre-temps : rien n’a été remplacé.',
        level: 'warning',
      }
    case 'read-only':
      return { message: 'Le document est en lecture seule.', level: 'error' }
    case 'invalid':
      return {
        message: 'Le texte ne compilerait pas : corrigez les problèmes signalés avant l’insertion.',
        level: 'error',
      }
  }
}

/** État des packages demandés : manquants dans ce fichier, ou fichier sans préambule. */
export type PackageCheck =
  | { kind: 'ok' }
  | { kind: 'missing'; names: string[] }
  /** Fichier inclus : les packages sont à charger dans le document principal. */
  | { kind: 'no-preamble'; names: string[] }

export function checkPackages(doc: Text | string, names: readonly string[]): PackageCheck {
  if (names.length === 0) return { kind: 'ok' }
  const missing = missingPackages(doc, names)
  if (missing === null) return { kind: 'no-preamble', names: [...new Set(names)] }
  return missing.length === 0 ? { kind: 'ok' } : { kind: 'missing', names: missing }
}

/** Case de la grille (ligne, colonne), indices à partir de 0. */
export interface CellPosition {
  row: number
  column: number
}

export type GridDirection = 'up' | 'down' | 'left' | 'right'

/** Ancre de la fusion qui couvre une case (la case elle-même hors fusion). */
export function anchorOf(model: TableModel, position: CellPosition): CellPosition {
  const anchor = cellAnchor(model, position.row, position.column)
  return anchor ? { row: anchor.row, column: anchor.column } : position
}

/**
 * Case voisine dans une direction, en sautant les cases couvertes par la fusion de départ ;
 * l'ancre de la fusion d'arrivée est renvoyée. Null au bord de la grille.
 */
export function moveInGrid(
  model: TableModel,
  from: CellPosition,
  direction: GridDirection,
): CellPosition | null {
  const start = anchorOf(model, from)
  const cell = model.rows[start.row]?.cells[start.column]
  const rowspan = cell?.rowspan ?? 1
  const colspan = cell?.colspan ?? 1
  let row = from.row
  let column = from.column
  if (direction === 'up') row = start.row - 1
  else if (direction === 'down') row = start.row + rowspan
  else if (direction === 'left') column = start.column - 1
  else column = start.column + colspan
  if (row < 0 || column < 0 || row >= model.rows.length || column >= model.columns.length) {
    return null
  }
  return anchorOf(model, { row, column })
}

/** Case suivante (ou précédente) dans l'ordre de lecture, pour Tab ; null en fin de grille. */
export function nextInReadingOrder(
  model: TableModel,
  from: CellPosition,
  backwards = false,
): CellPosition | null {
  const width = model.columns.length
  const total = model.rows.length * width
  const start = anchorOf(model, from)
  let index = start.row * width + start.column
  for (;;) {
    index += backwards ? -1 : 1
    if (index < 0 || index >= total) return null
    const position = { row: Math.floor(index / width), column: index % width }
    // Seules les ancres sont des étapes (les cases couvertes sont sautées).
    if (model.rows[position.row]?.cells[position.column]) return position
  }
}

/** Plage rectangulaire couvrant deux cases, agrandie aux fusions qu'elle touche. */
export function rangeBetween(model: TableModel, a: CellPosition, b: CellPosition): CellRange {
  return expandRange(model, {
    top: Math.min(a.row, b.row),
    left: Math.min(a.column, b.column),
    bottom: Math.max(a.row, b.row),
    right: Math.max(a.column, b.column),
  })
}

/** Vrai si une case est dans la plage. */
export function inRange(range: CellRange, row: number, column: number): boolean {
  return row >= range.top && row <= range.bottom && column >= range.left && column <= range.right
}

/** Un collage dans une cellule remplit la grille s'il contient plusieurs cases (tabulation, ligne). */
export function isGridPaste(text: string): boolean {
  return /[\t\n]/.test(text.replace(/\r?\n$/, ''))
}

/**
 * Colle un texte tabulé (Excel, Google Sheets) ou CSV à partir d'une case : la grille s'agrandit
 * au besoin ; une case couverte par une fusion est ignorée (seule l'ancre reçoit du texte).
 * Contenus échappés pour LaTeX par défaut.
 */
export function pasteIntoTable(
  model: TableModel,
  at: CellPosition,
  text: string,
  options: { escape?: boolean } = {},
): TableModel {
  const data = parseDelimited(text)
  if (data.length === 0) return model
  const escape = options.escape ?? true
  const width = Math.max(...data.map((row) => row.length))
  let next = model
  while (next.rows.length < at.row + data.length) next = insertRow(next, next.rows.length)
  while (next.columns.length < at.column + width) {
    next = insertColumn(next, next.columns.length)
  }
  // insertRow et insertColumn copient le modèle ; sinon, copie avant modification.
  if (next === model) next = structuredClone(model)
  data.forEach((values, r) => {
    values.forEach((value, c) => {
      const cell = next.rows[at.row + r]?.cells[at.column + c]
      if (cell) cell.content = escape ? escapeLatex(value.trim()) : value.trim()
    })
  })
  return next
}

/** Libellé d'alignement d'une colonne. */
export const COLUMN_ALIGNS = [
  { value: 'l', label: 'Gauche' },
  { value: 'c', label: 'Centre' },
  { value: 'r', label: 'Droite' },
  { value: 'p', label: 'Paragraphe (largeur fixe)' },
] as const

/** Alignement CSS de l'aperçu d'une colonne de la grille. */
export function cssAlign(align: string): 'left' | 'center' | 'right' {
  if (align === 'c') return 'center'
  if (align === 'r') return 'right'
  return 'left'
}
