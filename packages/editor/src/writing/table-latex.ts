import type { Text } from '@codemirror/state'
import { groupEnd } from '../scan.js'
import { environments, hasComment, maskCode, type MaskedCode, withoutComments } from './mask.js'
import {
  cloneTable,
  type TableCell,
  type TableColumn,
  type TableEnvironment,
  type TableFloat,
  type TableModel,
  type TableRow,
  type TableRule,
} from './table-model.js'

// --- Échappement ---------------------------------------------------------------------------------

const ESCAPES: Readonly<Record<string, string>> = {
  '\\': '\\textbackslash{}',
  '&': '\\&',
  '%': '\\%',
  $: '\\$',
  '#': '\\#',
  _: '\\_',
  '{': '\\{',
  '}': '\\}',
  '~': '\\textasciitilde{}',
  '^': '\\textasciicircum{}',
  '<': '\\textless{}',
  '>': '\\textgreater{}',
  '|': '\\textbar{}',
}

/**
 * Texte brut → LaTeX : caractères spéciaux `\ & % $ # _ { } ~ ^` échappés (et `< > |`, faux en
 * codage OT1), sauts de ligne remplacés par une espace (une cellule tient sur une ligne).
 */
export function escapeLatex(text: string): string {
  return text.replace(/[\\&%$#_{}~^<>|]/g, (ch) => ESCAPES[ch] ?? ch).replace(/\s*\r?\n\s*/g, ' ')
}

// --- Génération ----------------------------------------------------------------------------------

/** Spécification d'une colonne (`l`, `p{3cm}`, `>{\centering}m{2cm}`). */
export function columnSpec(column: TableColumn): string {
  const body = column.width === undefined ? column.align : `${column.align}{${column.width}}`
  return (
    (column.before === undefined ? '' : `>{${column.before}}`) +
    body +
    (column.after === undefined ? '' : `<{${column.after}}`)
  )
}

/** Préambule de colonnes `{|l|c|r|}`. */
export function tableColumnsSpec(model: Pick<TableModel, 'columns' | 'separators'>): string {
  return (
    model.columns.map((column, i) => (model.separators[i] ?? '') + columnSpec(column)).join('') +
    (model.separators[model.columns.length] ?? '')
  )
}

/** Spécification de `\multicolumn` déduite des colonnes couvertes (alignement et filets). */
export function defaultMulticolumnSpec(model: TableModel, column: number, colspan: number): string {
  const first = model.columns[column]
  const align = first && /^[lcr]$/.test(first.align) ? first.align : 'c'
  const left = column === 0 ? edgeRule(model.separators[0]) : ''
  const right = edgeRule(model.separators[column + colspan])
  return `${left}${align}${right}`
}

function edgeRule(separator: string | undefined): string {
  return separator?.match(/\|+/)?.[0] ?? ''
}

function ruleText(rule: TableRule): string {
  switch (rule.kind) {
    case 'hline':
      return '\\hline'
    case 'toprule':
    case 'midrule':
    case 'bottomrule':
      return `\\${rule.kind}${rule.width === undefined ? '' : `[${rule.width}]`}`
    case 'cline':
      return `\\cline{${rule.from}-${rule.to}}`
    case 'cmidrule':
      return (
        `\\cmidrule${rule.width === undefined ? '' : `[${rule.width}]`}` +
        `${rule.trim === undefined ? '' : `(${rule.trim})`}{${rule.from}-${rule.to}}`
      )
    case 'raw':
      return rule.text
  }
}

/** Texte d'une case : `\multicolumn`, `\multirow`, ou contenu seul. */
function cellText(model: TableModel, cell: TableCell, column: number, emptyCover = false): string {
  const content = emptyCover ? '' : cell.content
  const inner =
    cell.rowspan > 1 && !emptyCover
      ? `\\multirow{${cell.rowspan}}{${cell.multirowWidth ?? '*'}}{${content}}`
      : content
  if (cell.colspan > 1 || cell.spec !== undefined) {
    const spec = cell.spec ?? defaultMulticolumnSpec(model, column, cell.colspan)
    return `\\multicolumn{${cell.colspan}}{${spec}}{${inner}}`
  }
  return inner
}

export interface GeneratedTable {
  text: string
  /** Packages demandés (booktabs, multirow, tabularx, longtable, array). */
  packages: string[]
  /** Problèmes détectés (cellules qui casseraient la grille…), en français. */
  warnings: string[]
}

export interface GenerateOptions {
  /** Aligne les `&` des colonnes simples (par défaut). */
  alignColumns?: boolean
}

/**
 * LaTeX d'un tableau : environnement flottant (`\centering`, `\caption`, `\label`) ou tabular
 * seul ; une ligne par rangée, filets sur leur propre ligne, indentation par tabulations (une
 * tabulation par niveau, à convertir selon l'éditeur).
 */
export function generateTable(model: TableModel, options: GenerateOptions = {}): GeneratedTable {
  const warnings: string[] = []
  const packages = new Set<string>()
  const longtable = model.environment === 'longtable'
  const inFloat = model.float !== null && !longtable
  const indent = inFloat ? '\t' : ''
  const rowIndent = `${indent}\t`

  // Texte de chaque case visible (null : case couverte par une fusion horizontale).
  const texts: (string | null)[][] = model.rows.map((row, r) =>
    row.cells.map((cell, c) => {
      if (cell !== null) {
        if (cell.rowspan > 1) packages.add('multirow')
        const issue = cellIssue(cell.content, cellOptions(model, cell, c))
        if (issue !== null) warnings.push(`Ligne ${r + 1}, colonne ${c + 1} : ${issue}`)
        return cellText(model, cell, c)
      }
      // Case couverte : par une fusion verticale (case vide à écrire) ou horizontale (rien).
      const anchor = coverOf(model, r, c)
      if (anchor?.column !== c || anchor.row === r) return null
      return cellText(model, anchor.cell, c, true)
    }),
  )

  // Nombre de colonnes occupées par le texte écrit en (r, c).
  const spanAt = (r: number, c: number) =>
    model.rows[r]?.cells[c]?.colspan ?? coverOf(model, r, c)?.cell.colspan ?? 1
  const widths = model.columns.map((_, c) =>
    options.alignColumns === false
      ? 0
      : Math.max(
          0,
          ...model.rows.map((_row, r) => (spanAt(r, c) === 1 ? (texts[r]?.[c]?.length ?? 0) : 0)),
        ),
  )

  const lines: string[] = []
  const caption = captionLines(model)
  const captionProblem = captionIssue(model)
  if (captionProblem !== null) warnings.push(`Légende : ${captionProblem.message}`)
  if (inFloat && model.float) {
    lines.push(
      `\\begin{${model.float.environment}}${model.float.placement === undefined ? '' : `[${model.float.placement}]`}`,
    )
    if (model.float.centering) lines.push('\t\\centering')
    if (model.captionPosition === 'above') lines.push(...caption.map((line) => `\t${line}`))
  } else if (!longtable && caption.length > 0) {
    warnings.push(
      'Légende et label demandent un environnement flottant (table) : ils sont ignorés.',
    )
  }

  const spec = tableColumnsSpec(model)
  const position = model.position === undefined ? '' : `[${model.position}]`
  const width =
    model.environment === 'tabular*' || model.environment === 'tabularx'
      ? `{${model.width ?? '\\linewidth'}}`
      : ''
  // `\begin{tabularx}{largeur}[t]{spec}` : la largeur précède la position.
  lines.push(`${indent}\\begin{${model.environment}}${width}${position}{${spec}}`)
  if (longtable && caption.length > 0) lines.push(`${rowIndent}${caption.join(' ')} \\\\`)

  model.rules.forEach((rules, boundary) => {
    if (rules.length > 0) lines.push(rowIndent + rules.map(ruleText).join(' '))
    const row = model.rows[boundary]
    const cells = texts[boundary]
    if (!row || !cells) return
    const parts: string[] = []
    cells.forEach((text, c) => {
      if (text === null) return
      const last = c + spanAt(boundary, c) >= cells.length
      parts.push(last ? text : text.padEnd(widths[c] ?? 0, ' '))
    })
    const prefix = row.prefix === undefined ? '' : `${row.prefix} `
    lines.push(`${rowIndent}${prefix}${parts.join(' & ').trimEnd()} \\\\${row.spacing ?? ''}`)
  })

  lines.push(`${indent}\\end{${model.environment}}`)
  if (inFloat && model.float) {
    if (model.captionPosition === 'below') lines.push(...caption.map((line) => `\t${line}`))
    lines.push(`\\end{${model.float.environment}}`)
  }

  const rules = model.rules.flat()
  if (rules.some((rule) => ['toprule', 'midrule', 'bottomrule', 'cmidrule'].includes(rule.kind)))
    packages.add('booktabs')
  if (model.environment === 'tabularx') packages.add('tabularx')
  if (longtable) packages.add('longtable')
  if (
    model.columns.some(
      (column) =>
        /^[mb]$/.test(column.align) || column.before !== undefined || column.after !== undefined,
    )
  ) {
    packages.add('array')
  }
  return { text: lines.join('\n'), packages: [...packages], warnings }
}

function captionLines(model: TableModel): string[] {
  const lines: string[] = []
  if (model.caption !== undefined && model.caption !== '') lines.push(`\\caption{${model.caption}}`)
  if (model.label !== undefined && model.label !== '') lines.push(`\\label{${model.label}}`)
  return lines
}

/** Ancre de la fusion qui couvre une case. */
function coverOf(
  model: TableModel,
  row: number,
  column: number,
): { row: number; column: number; cell: TableCell } | null {
  for (let r = row; r >= 0; r--) {
    const cells = model.rows[r]?.cells ?? []
    for (let c = column; c >= 0; c--) {
      const cell = cells[c]
      if (cell && r + cell.rowspan > row && c + cell.colspan > column)
        return { row: r, column: c, cell }
    }
  }
  return null
}

/** Options d'analyse d'une cellule. */
export interface CellOptions {
  /** La colonne place déjà la case en mode mathématique (`>{$}c<{$}`). */
  math?: boolean
}

/** Position d'un `$` non échappé qui reste sans partenaire (le dernier), -1 sinon. */
function unpairedDollar(content: string): number {
  let last = -1
  let count = 0
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\\') i++
    else if (content[i] === '$') {
      count++
      last = i
    }
  }
  return count % 2 === 1 ? last : -1
}

/**
 * Parcourt une cellule et signale chaque caractère qui casserait le tableau ou la compilation :
 * `&` hors environnement, `\\` hors groupe, `%` (commenterait la fin de ligne et son `\\`), `#`,
 * `$` sans partenaire, `_` et `^` hors mode mathématique. `visit` reçoit la position et le
 * caractère ; les accolades sont comptées à part (`depth` final).
 */
function scanCell(
  content: string,
  options: CellOptions,
  visit: (index: number, issue: CellIssueKind) => void,
): number {
  let depth = 0
  let environments = 0
  let math = options.math === true
  const lonely = unpairedDollar(content)
  for (let i = 0; i < content.length; i++) {
    const ch = content[i]
    if (ch === '\\') {
      const rest = content.slice(i)
      if (/^\\begin(?![a-zA-Z])/.test(rest)) environments++
      else if (/^\\end(?![a-zA-Z])/.test(rest)) environments--
      else if (content[i + 1] === '\\' && depth === 0 && environments === 0) visit(i, 'row')
      else if (content[i + 1] === '(' && options.math !== true) math = true
      else if (content[i + 1] === ')' && options.math !== true) math = false
      i++
    } else if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth < 0) {
        visit(i, 'close')
        depth = 0
      }
    } else if (ch === '&' && environments === 0) visit(i, '&')
    else if (ch === '%') visit(i, '%')
    else if (ch === '#') visit(i, '#')
    else if (ch === '$') {
      if (i === lonely) visit(i, '$')
      else if (options.math !== true) math = !math
    } else if ((ch === '_' || ch === '^') && !math && depth === 0 && environments === 0) {
      visit(i, ch)
    }
  }
  return depth
}

type CellIssueKind = 'row' | 'close' | '&' | '%' | '#' | '$' | '_' | '^'

const CELL_ISSUES: Record<CellIssueKind, string> = {
  row: '« \\\\ » coupe la ligne du tableau',
  close: 'accolade fermante en trop',
  '&': '« & » non échappé ajoute une colonne',
  '%': '« % » non échappé commente la fin de la ligne',
  '#': '« # » non échappé ne compile pas',
  $: '« $ » sans partenaire ouvre une formule non fermée',
  _: '« _ » hors formule ne compile pas',
  '^': '« ^ » hors formule ne compile pas',
}

/**
 * Problème d'un contenu de cellule : `&` hors environnement ou `\\` hors groupe (la grille serait
 * décalée ; `\shortstack{a \\ b}` reste permis), `%`, `#`, `$` non fermé, `_` ou `^` hors
 * formule, accolades non équilibrées. Null si le contenu est sûr.
 */
export function cellIssue(content: string, options: CellOptions = {}): string | null {
  const found: CellIssueKind[] = []
  const depth = scanCell(content, options, (_index, issue) => {
    found.push(issue)
  })
  const first = found[0]
  if (first !== undefined) return CELL_ISSUES[first]
  return depth === 0 ? null : 'accolade non fermée'
}

const CELL_FIXES: Partial<Record<CellIssueKind, string>> = {
  '&': '\\&',
  '%': '\\%',
  '#': '\\#',
  $: '\\$',
  _: '\\_',
  '^': '\\textasciicircum{}',
}

/**
 * Échappe les caractères spéciaux tapés comme du texte (`20%` → `20\%`, `R&D` → `R\&D`, `$`
 * sans partenaire, `_` hors formule) ; le LaTeX valide de la cellule est gardé. `\\` et accolades
 * non équilibrées restent à corriger à la main (`cellIssue` les signale encore).
 */
export function fixCellContent(content: string, options: CellOptions = {}): string {
  const edits: { index: number; insert: string }[] = []
  scanCell(content, options, (index, issue) => {
    const insert = CELL_FIXES[issue]
    if (insert !== undefined) edits.push({ index, insert })
  })
  let out = content
  for (const { index, insert } of edits.reverse()) {
    out = out.slice(0, index) + insert + out.slice(index + 1)
  }
  return out
}

/** Problème d'une case de la grille (positions à partir de 0). */
export interface TableCellIssue {
  row: number
  column: number
  message: string
  /** `fixCellContent` le corrige. */
  fixable: boolean
}

/** Options d'une case : colonne (ou `\multicolumn`) en mode mathématique. */
export function cellOptions(model: TableModel, cell: TableCell, column: number): CellOptions {
  const prefix = cell.spec ?? model.columns[column]?.before ?? ''
  return { math: /\$|\\\(|\\ensuremath/.test(prefix) }
}

/** Cases dont le contenu casserait le tableau ou la compilation (l'insertion est refusée). */
export function tableCellIssues(model: TableModel): TableCellIssue[] {
  const issues: TableCellIssue[] = []
  model.rows.forEach((row, r) => {
    row.cells.forEach((cell, c) => {
      if (cell === null) return
      const options = cellOptions(model, cell, c)
      const message = cellIssue(cell.content, options)
      if (message === null) return
      const fixable = cellIssue(fixCellContent(cell.content, options), options) === null
      issues.push({ row: r, column: c, message, fixable })
    })
  })
  return issues
}

/** Vrai si la légende est écrite (flottant `table` ou longtable). */
function writesCaption(model: TableModel): boolean {
  return model.environment === 'longtable' || model.float !== null
}

/** Problème de la légende (mêmes règles qu'une case, en mode texte). */
export interface TableCaptionIssue {
  message: string
  /** `fixTableCells` le corrige. */
  fixable: boolean
}

/**
 * Légende qui casserait la compilation (`50%` commenterait l'accolade fermante, `R&D` donnerait
 * « Misplaced alignment tab », `#`, `$` seul, accolades non équilibrées) : l'insertion est
 * refusée. Null si la légende est sûre, vide ou non écrite (tableau seul).
 */
export function captionIssue(model: TableModel): TableCaptionIssue | null {
  const caption = model.caption ?? ''
  if (caption === '' || !writesCaption(model)) return null
  const message = cellIssue(caption)
  if (message === null) return null
  return { message, fixable: cellIssue(fixCellContent(caption)) === null }
}

/** Échappe les caractères spéciaux de toutes les cases et de la légende (`fixCellContent`). */
export function fixTableCells(model: TableModel): TableModel {
  const next = cloneTable(model)
  next.rows.forEach((row) => {
    row.cells.forEach((cell, c) => {
      if (cell !== null) cell.content = fixCellContent(cell.content, cellOptions(next, cell, c))
    })
  })
  if (next.caption !== undefined) next.caption = fixCellContent(next.caption)
  return next
}

// --- Analyse -------------------------------------------------------------------------------------

export const TABLE_ENVIRONMENTS: readonly TableEnvironment[] = [
  'tabular',
  'tabular*',
  'tabularx',
  'longtable',
]

/** Avertissement de l'analyse : le tableau est représentable, avec une perte de forme signalée. */
export interface TableWarning {
  code: 'comments' | 'normalized' | 'raw-cell' | 'missing-cells' | 'float-content'
  message: string
}

export type TableParseResult =
  | { ok: true; model: TableModel; warnings: TableWarning[] }
  /** Non représentable dans la grille : à éditer en texte brut (`raw` = source d'origine). */
  | { ok: false; reason: string; raw: string }

/** Tableau trouvé sous le curseur : plage à remplacer et résultat de l'analyse. */
export interface TableMatch {
  from: number
  to: number
  text: string
  /** Environnement analysé (le flottant `table` s'il ne contient que le tableau, sa légende, son label). */
  scope: 'float' | 'tabular'
  /**
   * Tableau seul placé dans un flottant, une minipage, un autre tableau ou l'argument d'une
   * commande (`\\resizebox{…}{!}{…}`) : il ne peut pas recevoir son propre flottant `table`
   * (« Not in outer par mode »).
   */
  nested: boolean
  result: TableParseResult
}

/** Environnements où un flottant `table` ne peut pas être placé. */
const NO_FLOAT_ENVIRONMENTS = new Set<string>([
  'table',
  'table*',
  'figure',
  'figure*',
  'minipage',
  'wraptable',
  'wrapfigure',
  'sidewaystable',
  'sidewaysfigure',
  'subtable',
  'subfigure',
  'tabular',
  'tabular*',
  'tabularx',
  'longtable',
  'array',
])

/** Profondeur d'accolades du code avant `position` (`\\{` ignoré). */
function braceDepth(code: string, position: number): number {
  let depth = 0
  for (let i = 0; i < position; i++) {
    const ch = code[i]
    if (ch === '\\') i++
    else if (ch === '{') depth++
    else if (ch === '}') depth = Math.max(0, depth - 1)
  }
  return depth
}

/**
 * Vrai si un flottant `table` ne peut pas être inséré à la position : dans une figure, une
 * minipage, un autre flottant ou tableau, ou dans l'argument d'une commande (« Not in outer par
 * mode »).
 */
export function floatForbiddenAt(doc: Text | string, position: number): boolean {
  const masked = maskCode(doc)
  return (
    environments(masked.code).some(
      (env) =>
        NO_FLOAT_ENVIRONMENTS.has(env.name) && env.beginTo <= position && position <= env.endFrom,
    ) || braceDepth(masked.code, position) > 0
  )
}

/** Lecture de `{…}` ou `[…]` à partir de `index` (blancs sautés). */
function readGroup(
  code: string,
  index: number,
  open: '{' | '[' | '(',
): { inner: [number, number]; end: number } | null {
  let i = index
  while (i < code.length && /\s/.test(code.charAt(i))) i++
  if (code[i] !== open) return null
  if (open === '(') {
    const close = code.indexOf(')', i)
    return close === -1 ? null : { inner: [i + 1, close], end: close + 1 }
  }
  const end = groupEnd(code, i)
  return end < 0 ? null : { inner: [i + 1, end - 1], end }
}

/** Découpe une spécification de colonnes en colonnes et séparateurs. */
export function parseColumnsSpec(
  spec: string,
): { columns: TableColumn[]; separators: string[]; normalized: boolean } | null {
  const columns: TableColumn[] = []
  const separators: string[] = ['']
  let normalized = false
  let pendingBefore: string | undefined
  const appendSeparator = (value: string) => {
    separators[separators.length - 1] = (separators.at(-1) ?? '') + value
  }
  let i = 0
  const source = expandRepeats(spec)
  if (source === null) return null
  if (source !== spec) normalized = true
  while (i < source.length) {
    const ch = source.charAt(i)
    if (/\s/.test(ch)) {
      i++
      continue
    }
    if (ch === '|') {
      appendSeparator('|')
      i++
    } else if (ch === '@' || ch === '!') {
      const group = readGroup(source, i + 1, '{')
      if (!group) return null
      appendSeparator(source.slice(i, group.end))
      i = group.end
    } else if (ch === '>') {
      const group = readGroup(source, i + 1, '{')
      if (!group) return null
      pendingBefore = source.slice(group.inner[0], group.inner[1])
      i = group.end
    } else if (ch === '<') {
      const group = readGroup(source, i + 1, '{')
      const last = columns.at(-1)
      if (!group || !last) return null
      last.after = source.slice(group.inner[0], group.inner[1])
      i = group.end
    } else if (/[a-zA-Z]/.test(ch)) {
      const column: TableColumn = { align: ch }
      i++
      if (/[pmbw]/.test(ch)) {
        const group = readGroup(source, i, '{')
        if (!group) return null
        column.width = source.slice(group.inner[0], group.inner[1])
        i = group.end
      }
      if (pendingBefore !== undefined) column.before = pendingBefore
      pendingBefore = undefined
      columns.push(column)
      separators.push('')
    } else return null
  }
  if (columns.length === 0 || pendingBefore !== undefined) return null
  return { columns, separators, normalized }
}

/** Développe `*{3}{c}` en `ccc` (null si mal formé). */
function expandRepeats(spec: string): string | null {
  let out = spec
  for (let guard = 0; guard < 20; guard++) {
    const star = out.indexOf('*')
    if (star === -1) return out
    const count = readGroup(out, star + 1, '{')
    if (!count) return null
    const body = readGroup(out, count.end, '{')
    if (!body) return null
    const n = Number(out.slice(count.inner[0], count.inner[1]).trim())
    if (!Number.isInteger(n) || n < 0 || n > 100) return null
    out =
      out.slice(0, star) + out.slice(body.inner[0], body.inner[1]).repeat(n) + out.slice(body.end)
  }
  return null
}

/**
 * Découpe le corps d'un tableau au niveau supérieur (hors groupes et environnements imbriqués) :
 * positions des `&` et des `\\` (avec leur suffixe `[2pt]` ou `*`).
 */
function splitBody(code: string, from: number, to: number) {
  const breaks: { at: number; end: number; spacing: string }[] = []
  const amps: number[] = []
  let depth = 0
  let envs = 0
  for (let i = from; i < to; i++) {
    const ch = code[i]
    if (ch === '\\') {
      const rest = code.slice(i, i + 6)
      if (rest.startsWith('\\begin') && !/[a-zA-Z]/.test(code.charAt(i + 6))) envs++
      else if (rest.startsWith('\\end') && !/[a-zA-Z]/.test(code.charAt(i + 4))) envs--
      if (code[i + 1] === '\\' && depth === 0 && envs === 0) {
        let end = i + 2
        let spacing = ''
        if (code[end] === '*') {
          spacing = '*'
          end++
        }
        const optional = readGroup(code, end, '[')
        if (optional) {
          spacing += code.slice(optional.inner[0] - 1, optional.end).replace(/^\s+/, '')
          end = optional.end
        }
        breaks.push({ at: i, end, spacing })
        i = end - 1
        continue
      }
      i++
    } else if (ch === '{') depth++
    else if (ch === '}') depth--
    else if (ch === '&' && depth === 0 && envs === 0) amps.push(i)
  }
  return { breaks, amps }
}

const RULE_PATTERNS: { pattern: RegExp; build: (match: RegExpExecArray) => TableRule }[] = [
  { pattern: /^\\hline(?![a-zA-Z@])/, build: () => ({ kind: 'hline' }) },
  {
    pattern: /^\\(toprule|midrule|bottomrule)(?![a-zA-Z@])(?:\s*\[([^\]]*)\])?/,
    build: (m) => ({
      kind: m[1] as 'toprule' | 'midrule' | 'bottomrule',
      ...(m[2] === undefined ? {} : { width: m[2] }),
    }),
  },
  {
    pattern: /^\\cline\s*\{\s*(\d+)\s*-\s*(\d+)\s*\}/,
    build: (m) => ({ kind: 'cline', from: Number(m[1]), to: Number(m[2]) }),
  },
  {
    // `\cmidrule[largeur](rognage){a-b}` : largeur et rognage optionnels (booktabs).
    pattern:
      /^\\cmidrule(?![a-zA-Z@])(?:\s*\[([^\]]*)\])?(?:\s*\(([^)]*)\))?\s*\{\s*(\d+)\s*-\s*(\d+)\s*\}/,
    build: (m) => ({
      kind: 'cmidrule',
      from: Number(m[3]),
      to: Number(m[4]),
      ...(m[2] === undefined ? {} : { trim: m[2] }),
      ...(m[1] === undefined ? {} : { width: m[1] }),
    }),
  },
]

/** Commandes placées entre deux lignes, gardées telles quelles. */
const RAW_RULE =
  /^\\(addlinespace|endhead|endfirsthead|endfoot|endlastfoot|hhline|specialrule|noalign|morecmidrules|arrayrulecolor|pagebreak|nopagebreak|newpage|rowcolors|hiderowcolors|showrowcolors)(?![a-zA-Z@])/

/** Commande de tête de ligne (colortbl) : elle reste avant la première case de sa ligne. */
const ROW_PREFIX = /^\\rowcolor(?![a-zA-Z@])/

/** Lit les filets en tête d'un segment ; renvoie les filets et la position du contenu. */
function readRules(
  code: string,
  text: string,
  from: number,
  to: number,
): { rules: TableRule[]; index: number } {
  const rules: TableRule[] = []
  let i = from
  for (;;) {
    while (i < to && /\s/.test(code.charAt(i))) i++
    const rest = code.slice(i, to)
    const known = RULE_PATTERNS.map(({ pattern, build }) => {
      const match = pattern.exec(rest)
      return match ? { rule: build(match), length: match[0].length } : null
    }).find((item) => item !== null)
    if (known) {
      rules.push(known.rule)
      i += known.length
      continue
    }
    const raw = RAW_RULE.exec(rest)
    if (!raw) break
    // Arguments éventuels : `[…]`, `(…)` et `{…}` qui suivent.
    let end = i + raw[0].length
    for (;;) {
      const group = readGroup(code, end, '[') ?? readGroup(code, end, '{')
      if (!group || group.end > to) break
      end = group.end
    }
    rules.push({ kind: 'raw', text: text.slice(i, end).trim() })
    i = end
  }
  return { rules, index: i }
}

/** `\multicolumn{n}{spec}{x}` ou `\multirow{n}{w}{x}` couvrant toute la cellule. */
function readSpanCommand(
  content: string,
  name: 'multicolumn' | 'multirow',
): { count: number; spec: string; inner: string } | null {
  const head = new RegExp(`^\\\\${name}(?![a-zA-Z@])`).exec(content)
  if (!head) return null
  const count = readGroup(content, head[0].length, '{')
  if (!count) return null
  const spec = readGroup(content, count.end, '{')
  if (!spec) return null
  const inner = readGroup(content, spec.end, '{')
  if (!inner || content.slice(inner.end).trim() !== '') return null
  const n = Number(content.slice(count.inner[0], count.inner[1]).trim())
  if (!Number.isInteger(n) || n < 1) return null
  return {
    count: n,
    spec: content.slice(spec.inner[0], spec.inner[1]).trim(),
    inner: content.slice(inner.inner[0], inner.inner[1]).trim(),
  }
}

/** Analyse le tabular, tabularx ou longtable qui commence à `env.from`. */
function parseTabular(
  masked: MaskedCode,
  env: { name: string; from: number; to: number; beginTo: number; endFrom: number },
): TableParseResult {
  const { code, text } = masked
  const raw = text.slice(env.from, env.to)
  const fail = (reason: string): TableParseResult => ({ ok: false, reason, raw })
  const warnings: TableWarning[] = []
  const environment = env.name as TableEnvironment
  let i = env.beginTo
  let position: string | undefined
  let width: string | undefined
  if (environment === 'tabular*' || environment === 'tabularx') {
    const group = readGroup(code, i, '{')
    if (!group) return fail('Largeur du tableau illisible.')
    width = text.slice(group.inner[0], group.inner[1]).trim()
    i = group.end
  }
  const optional = readGroup(code, i, '[')
  if (optional) {
    position = text.slice(optional.inner[0], optional.inner[1]).trim()
    i = optional.end
  }
  const specGroup = readGroup(code, i, '{')
  if (!specGroup) return fail('Spécification des colonnes absente.')
  const columnsSpec = parseColumnsSpec(text.slice(specGroup.inner[0], specGroup.inner[1]))
  if (!columnsSpec) return fail('Spécification des colonnes non reconnue.')
  if (columnsSpec.normalized) {
    warnings.push({
      code: 'normalized',
      message: 'Les colonnes répétées (*{n}{…}) sont développées.',
    })
  }
  const bodyFrom = specGroup.end
  const bodyTo = env.endFrom
  if (hasComment(masked, bodyFrom, bodyTo)) {
    warnings.push({ code: 'comments', message: 'Les commentaires du tableau seront retirés.' })
  }
  const width0 = columnsSpec.columns.length
  const { breaks, amps } = splitBody(code, bodyFrom, bodyTo)

  const model: TableModel = {
    environment,
    ...(width === undefined ? {} : { width }),
    ...(position === undefined ? {} : { position }),
    columns: columnsSpec.columns,
    separators: columnsSpec.separators,
    rows: [],
    rules: [],
    float: null,
    captionPosition: 'above',
  }

  // Segments entre deux `\\` : filets en tête, puis cellules.
  const segments: { from: number; to: number; spacing?: string }[] = []
  let start = bodyFrom
  for (const item of breaks) {
    segments.push({ from: start, to: item.at, spacing: item.spacing })
    start = item.end
  }
  segments.push({ from: start, to: bodyTo })

  let pendingRules: TableRule[] = []
  for (const [index, segment] of segments.entries()) {
    const { rules, index: contentFrom } = readRules(code, text, segment.from, segment.to)
    pendingRules.push(...rules)
    const isLast = index === segments.length - 1
    const rest = code.slice(contentFrom, segment.to)
    if (isLast && rest.trim() === '') break
    if (isLast) {
      warnings.push({ code: 'normalized', message: 'La dernière ligne reçoit un « \\\\ » final.' })
    }
    // `\rowcolor[…]{…}` en tête de ligne : gardé avec la ligne, hors de la première case.
    let cellsFrom = contentFrom
    let prefix: string | undefined
    const head = ROW_PREFIX.exec(code.slice(contentFrom, segment.to))
    if (head) {
      let end = contentFrom + head[0].length
      for (;;) {
        const group = readGroup(code, end, '[') ?? readGroup(code, end, '{')
        if (!group || group.end > segment.to) break
        end = group.end
      }
      prefix = text.slice(contentFrom, end).trim()
      cellsFrom = end
    }
    const separators = amps.filter((at) => at >= cellsFrom && at < segment.to)
    const bounds = [cellsFrom, ...separators.map((at) => at + 1)]
    const ends = [...separators, segment.to]
    const contents = bounds.map((from, k) => cleanContent(masked, from, ends[k] ?? segment.to))

    // Légende d'un longtable : première « ligne » faite de `\caption` (et `\label`).
    if (environment === 'longtable' && prefix === undefined && contents.length === 1) {
      const content = contents[0] ?? ''
      const caption = model.rows.length === 0 ? readCaption(content) : null
      if (caption && model.caption === undefined) {
        model.caption = caption.caption
        if (caption.label !== undefined) model.label = caption.label
        continue
      }
      // Autre légende (`\caption[]{… (suite)}` avant `\endhead`) : ligne gardée telle quelle,
      // jamais complétée par des cases vides.
      if (isCaptionRow(content)) {
        pendingRules.push({ kind: 'raw', text: `${content} \\\\${segment.spacing ?? ''}` })
        continue
      }
    }

    const row: TableRow = { cells: [] }
    if (prefix !== undefined) row.prefix = prefix
    if (segment.spacing !== undefined && segment.spacing !== '') row.spacing = segment.spacing
    for (const content of contents) {
      const multicolumn = readSpanCommand(content, 'multicolumn')
      const cell: TableCell = { content, colspan: 1, rowspan: 1 }
      if (multicolumn) {
        cell.colspan = multicolumn.count
        cell.spec = multicolumn.spec
        cell.content = multicolumn.inner
      }
      const multirow = readSpanCommand(cell.content, 'multirow')
      if (multirow) {
        cell.rowspan = multirow.count
        if (multirow.spec !== '*') cell.multirowWidth = multirow.spec
        cell.content = multirow.inner
      } else if (/^\\multirow(?![a-zA-Z@])/.test(cell.content)) {
        warnings.push({ code: 'raw-cell', message: 'Un \\multirow à options est gardé tel quel.' })
      }
      row.cells.push(cell)
      for (let k = 1; k < cell.colspan; k++) row.cells.push(null)
    }
    if (row.cells.length > width0) {
      return fail(`Une ligne a ${row.cells.length} cellules pour ${width0} colonnes.`)
    }
    if (row.cells.length < width0) {
      warnings.push({
        code: 'missing-cells',
        message: 'Les lignes incomplètes sont complétées par des cellules vides.',
      })
      while (row.cells.length < width0) row.cells.push({ content: '', colspan: 1, rowspan: 1 })
    }
    model.rules.push(pendingRules)
    pendingRules = []
    model.rows.push(row)
  }
  model.rules.push(pendingRules)
  if (model.rows.length === 0) return fail('Le tableau n’a aucune ligne.')

  applyRowspans(model, warnings)
  normalizeSpecs(model)
  return { ok: true, model, warnings: dedupe(warnings) }
}

function dedupe(warnings: TableWarning[]): TableWarning[] {
  return warnings.filter(
    (warning, index) => warnings.findIndex((other) => other.message === warning.message) === index,
  )
}

/** `\\caption{…}` suivi éventuellement de `\\label{…}`, rien d'autre. */
function readCaption(content: string): { caption: string; label?: string } | null {
  const head = /^\\caption(?![a-zA-Z@])/.exec(content)
  if (!head) return null
  const caption = readGroup(content, head[0].length, '{')
  if (!caption) return null
  const result: { caption: string; label?: string } = {
    caption: content.slice(caption.inner[0], caption.inner[1]),
  }
  const rest = content.slice(caption.end).trim()
  if (rest === '') return result
  const label = /^\\label(?![a-zA-Z@])/.exec(rest)
  const group = label ? readGroup(rest, label[0].length, '{') : null
  if (!group || rest.slice(group.end).trim() !== '') return null
  result.label = rest.slice(group.inner[0], group.inner[1])
  return result
}

/** Ligne faite seulement d'une `\caption[…]{…}` (ou `\caption*`), suivie éventuellement d'un `\label`. */
function isCaptionRow(content: string): boolean {
  const head = /^\\caption\*?(?![a-zA-Z@])/.exec(content)
  if (!head) return false
  let end = head[0].length
  const optional = readGroup(content, end, '[')
  if (optional) end = optional.end
  const caption = readGroup(content, end, '{')
  if (!caption) return false
  const rest = content.slice(caption.end).trim()
  if (rest === '') return true
  const label = /^\\label(?![a-zA-Z@])/.exec(rest)
  const group = label ? readGroup(rest, label[0].length, '{') : null
  return group !== null && rest.slice(group.end).trim() === ''
}

/** Contenu d'une cellule : texte d'origine (verbatim compris), commentaires retirés, rogné. */
function cleanContent(masked: MaskedCode, from: number, to: number): string {
  return withoutComments(masked, from, to)
    .replace(/\s*\n\s*/g, ' ')
    .trim()
}

/**
 * Fusions verticales : les cases sous un `\multirow` doivent être vides (ou un `\multicolumn` vide
 * de même largeur) ; sinon le `\multirow` reste dans le contenu de la cellule.
 */
function applyRowspans(model: TableModel, warnings: TableWarning[]): void {
  model.rows.forEach((row, r) => {
    row.cells.forEach((cell, c) => {
      if (!cell || cell.rowspan === 1) return
      const covered: TableCell[] = []
      let fits = r + cell.rowspan <= model.rows.length
      for (let k = 1; fits && k < cell.rowspan; k++) {
        const below = model.rows[r + k]?.cells[c]
        if (below?.content !== '' || below.colspan !== cell.colspan || below.rowspan !== 1)
          fits = false
        else covered.push(below)
      }
      if (!fits) {
        // Non représentable : la commande reste dans la cellule.
        cell.content = `\\multirow{${cell.rowspan}}{${cell.multirowWidth ?? '*'}}{${cell.content}}`
        cell.rowspan = 1
        delete cell.multirowWidth
        warnings.push({
          code: 'raw-cell',
          message: 'Un \\multirow qui chevauche d’autres cellules est gardé tel quel.',
        })
        return
      }
      for (let k = 1; k < cell.rowspan; k++) {
        const target = model.rows[r + k]
        if (target) target.cells[c] = null
      }
    })
  })
}

/** Spécification de `\multicolumn` égale à la valeur par défaut : retirée (forme canonique). */
function normalizeSpecs(model: TableModel): void {
  model.rows.forEach((row) => {
    row.cells.forEach((cell, c) => {
      if (
        cell?.spec !== undefined &&
        cell.colspan > 1 &&
        cell.spec === defaultMulticolumnSpec(model, c, cell.colspan)
      ) {
        delete cell.spec
      }
    })
  })
}

/** Analyse le contenu d'un environnement `table` : placement, `\centering`, légende, label. */
function parseFloat(
  masked: MaskedCode,
  float: { name: string; beginTo: number; endFrom: number },
  tabular: { from: number; to: number },
): {
  float: TableFloat
  caption?: string
  label?: string
  captionPosition: 'above' | 'below'
} | null {
  const { code, text } = masked
  let i = float.beginTo
  const result: {
    float: TableFloat
    caption?: string
    label?: string
    captionPosition: 'above' | 'below'
  } = {
    float: { environment: float.name as 'table' | 'table*', centering: false },
    captionPosition: 'above',
  }
  const placement = readGroup(code, i, '[')
  if (placement) {
    result.float.placement = text.slice(placement.inner[0], placement.inner[1]).trim()
    i = placement.end
  }
  let seenTabular = false
  for (;;) {
    while (i < float.endFrom && /\s/.test(code.charAt(i))) i++
    if (i >= float.endFrom) break
    if (i === tabular.from) {
      seenTabular = true
      i = tabular.to
      continue
    }
    const rest = code.slice(i, float.endFrom)
    const command = /^\\(centering|caption|label)(?![a-zA-Z@])/.exec(rest)
    if (!command) return null
    i += command[0].length
    if (command[1] === 'centering') {
      result.float.centering = true
      continue
    }
    if (command[1] === 'caption' && readGroup(code, i, '[')) return null
    const group = readGroup(code, i, '{')
    if (!group) return null
    const value = text.slice(group.inner[0], group.inner[1])
    if (command[1] === 'caption') {
      if (result.caption !== undefined) return null
      result.caption = value
      result.captionPosition = seenTabular ? 'below' : 'above'
    } else {
      if (result.label !== undefined) return null
      result.label = value
    }
    i = group.end
  }
  return seenTabular ? result : null
}

/** Analyse un texte qui contient un tableau (le premier tabular, dans son flottant éventuel). */
export function parseTable(source: string): TableParseResult {
  const masked = maskCode(source)
  const first = environments(masked.code).find((env) =>
    (TABLE_ENVIRONMENTS as readonly string[]).includes(env.name),
  )
  if (!first) return { ok: false, reason: 'Aucun tableau trouvé.', raw: source }
  return (
    tableAt(source, first.from)?.result ?? {
      ok: false,
      reason: 'Aucun tableau trouvé.',
      raw: source,
    }
  )
}

/**
 * Tableau (tabular, tabular*, tabularx, longtable) qui contient la position ou la sélection,
 * le plus intérieur. Si son environnement `table` ne contient que lui, `\centering`, `\caption` et
 * `\label`, la plage couvre le flottant entier.
 */
export function tableAt(doc: Text | string, from: number, to = from): TableMatch | null {
  const masked = maskCode(doc)
  const all = environments(masked.code)
  const tabular = all
    .filter(
      (env) =>
        (TABLE_ENVIRONMENTS as readonly string[]).includes(env.name) &&
        env.from <= from &&
        to <= env.to,
    )
    .sort((a, b) => b.from - a.from)[0]
  // Curseur dans le flottant, hors du tabular : le tabular unique du flottant.
  const float = all
    .filter(
      (env) => (env.name === 'table' || env.name === 'table*') && env.from <= from && to <= env.to,
    )
    .sort((a, b) => b.from - a.from)[0]
  const target =
    tabular ??
    (float
      ? all.find(
          (env) =>
            (TABLE_ENVIRONMENTS as readonly string[]).includes(env.name) &&
            env.from > float.from &&
            env.to < float.to,
        )
      : undefined)
  if (!target) return null
  const result = parseTabular(masked, target)
  const enclosing = all
    .filter(
      (env) =>
        (env.name === 'table' || env.name === 'table*') &&
        env.from < target.from &&
        target.to < env.to,
    )
    .sort((a, b) => b.from - a.from)[0]
  if (enclosing && result.ok) {
    const parsed = parseFloat(masked, enclosing, target)
    if (parsed) {
      result.model.float = parsed.float
      if (parsed.caption !== undefined) result.model.caption = parsed.caption
      if (parsed.label !== undefined) result.model.label = parsed.label
      result.model.captionPosition = parsed.captionPosition
      if (
        hasComment(masked, enclosing.from, enclosing.to) &&
        !result.warnings.some((w) => w.code === 'comments')
      ) {
        result.warnings.push({
          code: 'comments',
          message: 'Les commentaires du tableau seront retirés.',
        })
      }
      return {
        from: enclosing.from,
        to: enclosing.to,
        text: masked.text.slice(enclosing.from, enclosing.to),
        scope: 'float',
        nested: false,
        result,
      }
    }
    result.warnings.push({
      code: 'float-content',
      message: 'Le flottant contient d’autres éléments : seule la grille est modifiée.',
    })
  }
  return {
    from: target.from,
    to: target.to,
    text: masked.text.slice(target.from, target.to),
    scope: 'tabular',
    nested:
      all.some(
        (env) =>
          NO_FLOAT_ENVIRONMENTS.has(env.name) &&
          env.beginTo <= target.from &&
          target.to <= env.endFrom,
      ) || braceDepth(masked.code, target.from) > 0,
    result,
  }
}
