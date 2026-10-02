import { createTable, type NewTableOptions, type TableModel } from './table-model.js'
import { escapeLatex } from './table-latex.js'

export type Delimiter = '\t' | ',' | ';'

/** Nombre seul, virgule décimale comprise (`3,5`, `-1 234,56`, `12 %`) : une seule colonne. */
const NUMBER = /^\s*"?[-+]?\d[\d\s\u00a0\u202f.]*(?:,\d+)?\s*%?"?\s*$/

/** Lignes d'un texte (sauts de ligne hors guillemets), lignes vides retirées. */
function records(text: string): string[] {
  const lines: string[] = []
  let quoted = false
  let line = ''
  for (const ch of text) {
    if (ch === '"') quoted = !quoted
    if (!quoted && (ch === '\n' || ch === '\r')) {
      lines.push(line)
      line = ''
    } else line += ch
  }
  lines.push(line)
  return lines.filter((item) => item.trim() !== '')
}

/** Nombre de `delimiter` hors guillemets dans une ligne. */
function countOutsideQuotes(line: string, delimiter: string): number {
  let quoted = false
  let count = 0
  for (const ch of line) {
    if (ch === '"') quoted = !quoted
    else if (!quoted && ch === delimiter) count++
  }
  return count
}

/**
 * Séparateur d'un collage ou d'un CSV : tabulation (Excel, Google Sheets) si présente hors
 * guillemets. Sinon, sur plusieurs lignes, `;` ou `,` s'il revient le même nombre de fois sur
 * chaque ligne (`;` d'abord : CSV français) ; une colonne de nombres à virgule décimale (`3,5`),
 * avec ou sans en-tête, n'est pas coupée (tabulation, absente : une seule colonne). Sinon : le plus
 * fréquent sur la première ligne.
 */
export function detectDelimiter(text: string): Delimiter {
  const lines = records(text.replace(/^\uFEFF/, ''))
  if (lines.some((line) => countOutsideQuotes(line, '\t') > 0)) return '\t'
  const consistent = (delimiter: ';' | ',') => {
    const counts = lines.map((line) => countOutsideQuotes(line, delimiter))
    return counts.every((count) => count > 0 && count === counts[0])
  }
  // Virgules seulement dans des nombres (`3,5`), en-tête de colonne éventuel : une seule colonne.
  const commas = lines.filter((line) => countOutsideQuotes(line, ',') > 0)
  const decimals = commas.length > 0 && commas.every((line) => NUMBER.test(line))
  if (lines.length > 1 && consistent(';')) return ';'
  if (decimals || lines.every((line) => NUMBER.test(line))) return '\t'
  if (lines.length > 1 && consistent(',')) return ','
  const first = lines[0] ?? ''
  return countOutsideQuotes(first, ';') > countOutsideQuotes(first, ',') ? ';' : ','
}

/**
 * Lit un texte tabulé ou CSV (RFC 4180) : champs entre guillemets avec `""`, séparateurs et sauts
 * de ligne à l'intérieur, fins de ligne CRLF. La dernière ligne vide est ignorée, les lignes sont
 * complétées à la même longueur.
 */
export function parseDelimited(
  text: string,
  delimiter: Delimiter = detectDelimiter(text),
): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  let fieldStart = true
  const source = text.replace(/^\uFEFF/, '')
  for (let i = 0; i < source.length; i++) {
    const ch = source.charAt(i)
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"'
          i++
        } else quoted = false
      } else field += ch
      continue
    }
    if (ch === '"' && fieldStart) {
      quoted = true
      fieldStart = false
    } else if (ch === delimiter) {
      row.push(field)
      field = ''
      fieldStart = true
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && source[i + 1] === '\n') i++
      row.push(field)
      rows.push(row)
      row = []
      field = ''
      fieldStart = true
    } else {
      field += ch
      fieldStart = false
    }
  }
  if (field !== '' || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  const width = Math.max(0, ...rows.map((item) => item.length))
  return rows.map((item) => [...item, ...Array.from({ length: width - item.length }, () => '')])
}

export interface ImportOptions extends NewTableOptions {
  delimiter?: Delimiter
  /** Échappe les caractères spéciaux de LaTeX (par défaut) ; false : les cellules sont du LaTeX. */
  escape?: boolean
}

/** Tableau construit à partir d'un collage (Excel, Google Sheets) ou d'un CSV ; null si vide. */
export function tableFromDelimited(text: string, options: ImportOptions = {}): TableModel | null {
  const rows = parseDelimited(text, options.delimiter)
    .map((row) => row.map((value) => value.trim()))
    .filter((row) => row.some((value) => value !== ''))
  if (rows.length === 0) return null
  const escape = options.escape ?? true
  const contents = rows.map((row) => row.map((value) => (escape ? escapeLatex(value) : value)))
  const model = createTable(contents, undefined, options)
  // Colonnes numériques alignées à droite.
  model.columns.forEach((column, c) => {
    const values = rows.slice(options.header === false ? 0 : 1).map((row) => row[c] ?? '')
    if (
      values.some((value) => value !== '') &&
      values.every((value) => value === '' || /^[-+]?[\d\s.,]+%?$/.test(value))
    ) {
      column.align = options.align ?? 'r'
    }
  })
  return model
}
