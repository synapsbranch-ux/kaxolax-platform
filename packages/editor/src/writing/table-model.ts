/** Modèle de grille du générateur de tableaux : cellules, fusions, colonnes, filets. */

/** Type de colonne : `l`, `c`, `r`, `p`/`m`/`b` (avec largeur), `X` (tabularx) ou autre lettre. */
export interface TableColumn {
  align: string
  /** Largeur de `p{…}`, `m{…}`, `b{…}`. */
  width?: string
  /** Préfixe `>{…}` et suffixe `<{…}` (package array), sans les accolades. */
  before?: string
  after?: string
}

export interface TableCell {
  /** Contenu LaTeX de la cellule (rogné). */
  content: string
  colspan: number
  rowspan: number
  /** Spécification de `\multicolumn` (`c`, `|c|`) ; absente : déduite de la colonne. */
  spec?: string
  /** Largeur de `\multirow` ; absente : `*`. */
  multirowWidth?: string
}

/** Filet ou commande placée entre deux lignes. Colonnes numérotées à partir de 1. */
export type TableRule =
  | { kind: 'hline' }
  | { kind: 'toprule' | 'midrule' | 'bottomrule'; width?: string }
  | { kind: 'cline'; from: number; to: number }
  /** `\cmidrule[width](trim){from-to}` (booktabs). */
  | { kind: 'cmidrule'; from: number; to: number; trim?: string; width?: string }
  /** Commande gardée telle quelle (`\addlinespace`, `\endhead`, `\hhline{…}`…). */
  | { kind: 'raw'; text: string }

export interface TableRow {
  /** Une case par colonne ; null : couverte par une fusion (à gauche ou au-dessus). */
  cells: (TableCell | null)[]
  /** Suffixe de `\\` (`[2pt]`, `*`). */
  spacing?: string
  /** Commande de tête de ligne gardée telle quelle (`\rowcolor{gray!10}`), avant la première case. */
  prefix?: string
}

export type TableEnvironment = 'tabular' | 'tabular*' | 'tabularx' | 'longtable'

export interface TableFloat {
  environment: 'table' | 'table*'
  /** Placement `[htbp]` sans les crochets ; absent : aucun. */
  placement?: string
  centering: boolean
}

export interface TableModel {
  environment: TableEnvironment
  /** Largeur de `tabular*` et `tabularx`. */
  width?: string
  /** Position `[t]`, `[c]` sans les crochets. */
  position?: string
  columns: TableColumn[]
  /** Séparateurs de colonnes (`|`, `||`, `@{}`), un de plus que de colonnes. */
  separators: string[]
  rows: TableRow[]
  /** Filets entre les lignes, un de plus que de lignes (0 : avant la première). */
  rules: TableRule[][]
  /** Environnement flottant `table` ; null : tableau seul. */
  float: TableFloat | null
  caption?: string
  label?: string
  /** Légende au-dessus (par défaut) ou au-dessous du tableau. */
  captionPosition: 'above' | 'below'
}

/** Style des filets horizontaux. */
export type TableRuleStyle = 'booktabs' | 'classic' | 'none'

export interface NewTableOptions {
  style?: TableRuleStyle
  /** Filet sous la première ligne (en-tête). */
  header?: boolean
  float?: boolean
  align?: string
}

function cell(content = ''): TableCell {
  return { content, colspan: 1, rowspan: 1 }
}

/** Copie profonde (les opérations ne modifient jamais le modèle reçu). */
export function cloneTable(model: TableModel): TableModel {
  return structuredClone(model)
}

/**
 * Nouveau tableau `rows` × `columns` à partir de contenus (lignes de chaînes, complétées par des
 * cases vides), style booktabs et environnement `table` par défaut.
 */
export function createTable(
  rows: number | readonly (readonly string[])[],
  columns?: number,
  options: NewTableOptions = {},
): TableModel {
  const data = typeof rows === 'number' ? Array.from({ length: rows }, () => []) : rows
  const width = Math.max(1, columns ?? 0, ...data.map((row) => row.length))
  const height = Math.max(1, data.length)
  const style = options.style ?? 'booktabs'
  const model: TableModel = {
    environment: 'tabular',
    columns: Array.from({ length: width }, () => ({ align: options.align ?? 'l' })),
    separators: Array.from({ length: width + 1 }, () => ''),
    rows: Array.from({ length: height }, (_, r) => ({
      cells: Array.from({ length: width }, (_, c) => cell(data[r]?.[c] ?? '')),
    })),
    rules: Array.from({ length: height + 1 }, () => []),
    float:
      options.float === false ? null : { environment: 'table', placement: 'htbp', centering: true },
    captionPosition: 'above',
  }
  if (style !== 'none') {
    model.rules[0] = [ruleFor(style, 0, height)]
    model.rules[height] = [ruleFor(style, height, height)]
    if ((options.header ?? true) && height > 1) model.rules[1] = [ruleFor(style, 1, height)]
  }
  return model
}

function ruleFor(style: 'booktabs' | 'classic', boundary: number, rows: number): TableRule {
  if (style === 'classic') return { kind: 'hline' }
  if (boundary === 0) return { kind: 'toprule' }
  if (boundary === rows) return { kind: 'bottomrule' }
  return { kind: 'midrule' }
}

const BOOKTABS = new Set(['toprule', 'midrule', 'bottomrule', 'cmidrule'])

function isLine(rule: TableRule): boolean {
  return rule.kind !== 'raw'
}

/** Style des filets d'un tableau (booktabs dès qu'un filet booktabs est présent). */
export function tableRuleStyle(model: TableModel): TableRuleStyle {
  const rules = model.rules.flat()
  if (rules.some((rule) => BOOKTABS.has(rule.kind))) return 'booktabs'
  if (rules.some((rule) => rule.kind === 'hline' || rule.kind === 'cline')) return 'classic'
  return 'none'
}

/** Colonnes (1 à n) couvertes par une fusion verticale qui traverse la frontière `boundary`. */
function crossedColumns(model: TableModel, boundary: number): Set<number> {
  const crossed = new Set<number>()
  if (boundary <= 0 || boundary >= model.rows.length) return crossed
  model.rows.forEach((row, r) => {
    row.cells.forEach((item, c) => {
      if (item && r < boundary && r + item.rowspan > boundary) {
        for (let k = 0; k < item.colspan; k++) crossed.add(c + k + 1)
      }
    })
  })
  return crossed
}

/** Segments de colonnes (1 à n) non traversés par une fusion verticale. */
function freeSegments(model: TableModel, boundary: number): [number, number][] {
  const crossed = crossedColumns(model, boundary)
  const segments: [number, number][] = []
  let start: number | null = null
  for (let c = 1; c <= model.columns.length + 1; c++) {
    const free = c <= model.columns.length && !crossed.has(c)
    if (free && start === null) start = c
    if (!free && start !== null) {
      segments.push([start, c - 1])
      start = null
    }
  }
  return segments
}

/** Vrai si la frontière porte un filet (complet ou partiel). */
export function hasHorizontalRule(model: TableModel, boundary: number): boolean {
  return (model.rules[boundary] ?? []).some(isLine)
}

/**
 * Ajoute ou retire le filet de la frontière `boundary` (0 : au-dessus de la première ligne) dans
 * le style du tableau (booktabs par défaut) ; une fusion verticale traversée donne des filets
 * partiels (`\cline`, `\cmidrule`). Les commandes brutes de la frontière sont gardées.
 */
export function setHorizontalRule(model: TableModel, boundary: number, on: boolean): TableModel {
  const next = cloneTable(model)
  const current = next.rules[boundary]
  if (current === undefined) return next
  const kept = current.filter((rule) => !isLine(rule))
  if (!on) {
    next.rules[boundary] = kept
    return next
  }
  const style = tableRuleStyle(model) === 'classic' ? 'classic' : 'booktabs'
  const crossed = crossedColumns(next, boundary)
  let lines: TableRule[]
  if (crossed.size === 0) lines = [ruleFor(style, boundary, next.rows.length)]
  else
    lines = freeSegments(next, boundary).map(([from, to]) =>
      style === 'classic' ? { kind: 'cline', from, to } : { kind: 'cmidrule', from, to },
    )
  next.rules[boundary] = [...lines, ...kept]
  return next
}

/**
 * Change le style des filets : booktabs (`\toprule`, `\midrule`, `\bottomrule`, `\cmidrule`),
 * classique (`\hline`, `\cline`) ou aucun filet. Les frontières gardent leur filet.
 */
export function setTableRuleStyle(model: TableModel, style: TableRuleStyle): TableModel {
  const next = cloneTable(model)
  const rows = next.rows.length
  next.rules = next.rules.map((rules, boundary) => {
    if (style === 'none') return rules.filter((rule) => !isLine(rule))
    return rules.map((rule): TableRule => {
      switch (rule.kind) {
        case 'hline':
        case 'toprule':
        case 'midrule':
        case 'bottomrule':
          return ruleFor(style, boundary, rows)
        case 'cline':
          return style === 'classic' ? rule : { kind: 'cmidrule', from: rule.from, to: rule.to }
        case 'cmidrule':
          // Un `\cmidrule` gardé en booktabs conserve sa largeur et son rognage.
          return style === 'classic' ? { kind: 'cline', from: rule.from, to: rule.to } : rule
        case 'raw':
          return rule
      }
    })
  })
  // `\hline\hline` (double filet) devient un seul filet booktabs.
  if (style === 'booktabs') {
    next.rules = next.rules.map((rules) =>
      rules.filter(
        (rule, index) =>
          rule.kind === 'raw' ||
          rule.kind === 'cmidrule' ||
          !rules.slice(0, index).some((other) => other.kind === rule.kind),
      ),
    )
  }
  return next
}

/** Vrai si la frontière verticale `index` (0 : bord gauche) porte un filet `|`. */
export function hasVerticalRule(model: TableModel, index: number): boolean {
  return model.separators[index]?.includes('|') ?? false
}

/** Ajoute ou retire le filet vertical `index` (0 : bord gauche, n : bord droit). */
export function setVerticalRule(model: TableModel, index: number, on: boolean): TableModel {
  const next = cloneTable(model)
  const current = next.separators[index]
  if (current === undefined) return next
  next.separators[index] = on
    ? current.includes('|')
      ? current
      : `|${current}`
    : current.replaceAll('|', '')
  return next
}

/** Toutes les frontières verticales avec ou sans filet. */
export function setAllVerticalRules(model: TableModel, on: boolean): TableModel {
  let next = model
  for (let index = 0; index < model.separators.length; index++) {
    next = setVerticalRule(next, index, on)
  }
  return next
}

/** Change l'alignement d'une colonne (`l`, `c`, `r`, ou `p` avec une largeur). */
export function setColumnAlign(
  model: TableModel,
  column: number,
  align: string,
  width?: string,
): TableModel {
  const next = cloneTable(model)
  const target = next.columns[column]
  if (target === undefined) return next
  target.align = align
  if (width !== undefined && /^[pmb]$/.test(align)) target.width = width
  else if (!/^[pmb]$/.test(align)) delete target.width
  else target.width ??= '3cm'
  return next
}

/** Change le contenu d'une cellule (ancre d'une fusion). */
export function setCellContent(
  model: TableModel,
  row: number,
  column: number,
  content: string,
): TableModel {
  const next = cloneTable(model)
  const target = next.rows[row]?.cells[column]
  if (target) target.content = content
  return next
}

/** Ancre (ligne, colonne) de la cellule qui couvre une case, ou null hors du tableau. */
export function cellAnchor(
  model: TableModel,
  row: number,
  column: number,
): { row: number; column: number; cell: TableCell } | null {
  for (let r = row; r >= 0; r--) {
    for (let c = column; c >= 0; c--) {
      const item = model.rows[r]?.cells[c]
      if (item && r + item.rowspan > row && c + item.colspan > column) {
        return { row: r, column: c, cell: item }
      }
    }
  }
  return null
}

export interface CellRange {
  top: number
  left: number
  bottom: number
  right: number
}

/** Plage agrandie pour contenir entièrement les fusions qu'elle touche. */
export function expandRange(model: TableModel, range: CellRange): CellRange {
  let { top, left, bottom, right } = range
  let changed = true
  while (changed) {
    changed = false
    for (let r = top; r <= bottom; r++) {
      for (let c = left; c <= right; c++) {
        const anchor = cellAnchor(model, r, c)
        if (!anchor) continue
        const nextTop = Math.min(top, anchor.row)
        const nextLeft = Math.min(left, anchor.column)
        const nextBottom = Math.max(bottom, anchor.row + anchor.cell.rowspan - 1)
        const nextRight = Math.max(right, anchor.column + anchor.cell.colspan - 1)
        if (nextTop !== top || nextLeft !== left || nextBottom !== bottom || nextRight !== right) {
          ;[top, left, bottom, right] = [nextTop, nextLeft, nextBottom, nextRight]
          changed = true
        }
      }
    }
  }
  return { top, left, bottom, right }
}

/**
 * Fusionne une plage (agrandie aux fusions qu'elle touche) : les contenus non vides sont réunis
 * dans la cellule en haut à gauche, séparés par une espace.
 */
export function mergeCells(model: TableModel, range: CellRange): TableModel {
  const next = cloneTable(model)
  const { top, left, bottom, right } = expandRange(next, range)
  const contents: string[] = []
  for (let r = top; r <= bottom; r++) {
    const row = next.rows[r]
    if (!row) continue
    for (let c = left; c <= right; c++) {
      const item = row.cells[c]
      if (item && item.content.trim() !== '') contents.push(item.content.trim())
      row.cells[c] = null
    }
  }
  const anchor = next.rows[top]
  if (anchor) {
    const merged: TableCell = {
      content: contents.join(' '),
      colspan: right - left + 1,
      rowspan: bottom - top + 1,
    }
    const previous = model.rows[top]?.cells[left]
    if (previous?.spec !== undefined && merged.colspan === previous.colspan)
      merged.spec = previous.spec
    anchor.cells[left] = merged
  }
  return next
}

/** Défait la fusion qui couvre une case : le contenu reste dans la case en haut à gauche. */
export function splitCell(model: TableModel, row: number, column: number): TableModel {
  const next = cloneTable(model)
  const anchor = cellAnchor(next, row, column)
  if (!anchor) return next
  const { cell: item } = anchor
  for (let r = anchor.row; r < anchor.row + item.rowspan; r++) {
    for (let c = anchor.column; c < anchor.column + item.colspan; c++) {
      const target = next.rows[r]
      if (target) target.cells[c] = r === anchor.row && c === anchor.column ? item : cell()
    }
  }
  item.colspan = 1
  item.rowspan = 1
  delete item.spec
  delete item.multirowWidth
  return next
}

/** Insère une ligne vide à l'indice `index` ; une fusion verticale traversée s'agrandit. */
export function insertRow(model: TableModel, index: number): TableModel {
  const next = cloneTable(model)
  const at = Math.max(0, Math.min(index, next.rows.length))
  const cells: (TableCell | null)[] = next.columns.map(() => cell())
  next.rows.forEach((row, r) => {
    row.cells.forEach((item, c) => {
      if (item && r < at && r + item.rowspan > at) {
        item.rowspan++
        for (let k = 0; k < item.colspan; k++) cells[c + k] = null
      }
    })
  })
  next.rows.splice(at, 0, { cells })
  // Les filets de la frontière d'insertion restent au-dessus de la nouvelle ligne.
  next.rules.splice(at + 1, 0, [])
  if (at === next.rows.length - 1 && at > 0) {
    // Ligne ajoutée en bas : le filet de fin la suit (un `\hline` est recopié).
    const previous = next.rules[at] ?? []
    next.rules[at + 1] = previous.filter(
      (rule) => rule.kind === 'bottomrule' || rule.kind === 'hline',
    )
    next.rules[at] = previous.filter((rule) => rule.kind !== 'bottomrule')
  }
  return next
}

/** Retire une ligne ; une fusion qui la traverse rétrécit, son contenu passe à la ligne suivante. */
export function deleteRow(model: TableModel, index: number): TableModel {
  if (model.rows.length <= 1 || index < 0 || index >= model.rows.length) return cloneTable(model)
  const next = cloneTable(model)
  next.rows.forEach((row, r) => {
    row.cells.forEach((item, c) => {
      if (!item || item.rowspan === 1 || r > index || r + item.rowspan <= index) return
      if (r < index) item.rowspan--
      else {
        // Ancre supprimée : la fusion descend d'une ligne.
        const below = next.rows[r + 1]
        if (below) below.cells[c] = { ...item, rowspan: item.rowspan - 1 }
      }
    })
  })
  next.rows.splice(index, 1)
  // Les filets au-dessus et au-dessous de la ligne retirée se rejoignent.
  const above = next.rules[index] ?? []
  const belowRules = next.rules[index + 1] ?? []
  next.rules.splice(index, 2, mergeRules(above, belowRules))
  clampRules(next)
  return next
}

function mergeRules(a: TableRule[], b: TableRule[]): TableRule[] {
  const out = [...a]
  for (const rule of b) {
    if (!out.some((other) => JSON.stringify(other) === JSON.stringify(rule))) out.push(rule)
  }
  // Un filet de fin l'emporte sur un filet intermédiaire.
  if (out.some((rule) => rule.kind === 'bottomrule')) {
    return out.filter((rule) => rule.kind !== 'midrule')
  }
  if (out.some((rule) => rule.kind === 'toprule'))
    return out.filter((rule) => rule.kind !== 'midrule')
  return out
}

/** Filets partiels limités aux colonnes existantes. */
function clampRules(model: TableModel): void {
  const n = model.columns.length
  model.rules = model.rules.map((rules) =>
    rules.flatMap((rule): TableRule[] => {
      if (rule.kind !== 'cline' && rule.kind !== 'cmidrule') return [rule]
      const to = Math.min(rule.to, n)
      return rule.from > to ? [] : [{ ...rule, to }]
    }),
  )
}

/** Ancre d'une fusion, placée ailleurs qu'en (row, column), qui couvre cette case. */
function coveringAnchor(model: TableModel, row: number, column: number): boolean {
  return model.rows.some((line, r) =>
    line.cells.some(
      (item, c) =>
        item !== null &&
        (r !== row || c !== column) &&
        r <= row &&
        row < r + item.rowspan &&
        c <= column &&
        column < c + item.colspan,
    ),
  )
}

/** Insère une colonne vide à l'indice `index` (alignement `l`) ; une fusion traversée s'élargit. */
export function insertColumn(model: TableModel, index: number, align = 'l'): TableModel {
  const next = cloneTable(model)
  const at = Math.max(0, Math.min(index, next.columns.length))
  next.columns.splice(at, 0, { align })
  // Le nouveau séparateur reprend le filet vertical de gauche (sans `@{}` ni autre réglage).
  next.separators.splice(at + 1, 0, stripEdge(next.separators[at] ?? ''))
  for (const row of next.rows) {
    for (const [c, item] of row.cells.entries()) {
      if (item && c < at && c + item.colspan > at) item.colspan++
    }
    row.cells.splice(at, 0, cell())
  }
  // Une case couverte par une fusion élargie (y compris sur plusieurs lignes) devient couverte.
  next.rows.forEach((row, r) => {
    if (coveringAnchor(next, r, at)) row.cells[at] = null
  })
  next.rules = next.rules.map((rules) =>
    rules.map((rule) =>
      (rule.kind === 'cline' || rule.kind === 'cmidrule') && rule.to > at
        ? { ...rule, from: rule.from > at ? rule.from + 1 : rule.from, to: rule.to + 1 }
        : rule,
    ),
  )
  return next
}

function stripEdge(separator: string): string {
  return separator.includes('|') ? '|' : ''
}

/** Retire une colonne ; une fusion qui la traverse rétrécit. */
export function deleteColumn(model: TableModel, index: number): TableModel {
  if (model.columns.length <= 1 || index < 0 || index >= model.columns.length) {
    return cloneTable(model)
  }
  const next = cloneTable(model)
  next.rows.forEach((row) => {
    row.cells.forEach((item, c) => {
      if (!item || c > index || c + item.colspan <= index) return
      if (c < index) {
        item.colspan--
        if (item.colspan === 1) delete item.spec
      } else if (item.colspan > 1) {
        const moved: TableCell = { ...item, colspan: item.colspan - 1 }
        if (moved.colspan === 1) delete moved.spec
        row.cells[c + 1] = moved
      }
    })
    row.cells.splice(index, 1)
  })
  next.columns.splice(index, 1)
  next.separators.splice(index + 1, 1)
  next.rules = next.rules.map((rules) =>
    rules.flatMap((rule): TableRule[] => {
      if (rule.kind !== 'cline' && rule.kind !== 'cmidrule') return [rule]
      const from = rule.from > index + 1 ? rule.from - 1 : rule.from
      const to = rule.to >= index + 1 ? rule.to - 1 : rule.to
      return from > to ? [] : [{ ...rule, from, to }]
    }),
  )
  return next
}

/**
 * Problèmes d'une grille : dimensions incohérentes, case non couverte, fusion qui déborde ou en
 * chevauche une autre. Vide pour une grille valide.
 */
export function checkTable(model: TableModel): string[] {
  const problems: string[] = []
  const width = model.columns.length
  if (model.separators.length !== width + 1) problems.push('separators')
  if (model.rules.length !== model.rows.length + 1) problems.push('rules')
  const owner: (string | null)[][] = model.rows.map(() => Array.from({ length: width }, () => null))
  model.rows.forEach((row, r) => {
    if (row.cells.length !== width) problems.push(`row ${r}: ${row.cells.length} cells`)
    row.cells.forEach((item, c) => {
      if (!item) return
      if (item.colspan < 1 || item.rowspan < 1) problems.push(`cell ${r},${c}: span`)
      for (let dr = 0; dr < item.rowspan; dr++) {
        for (let dc = 0; dc < item.colspan; dc++) {
          const line = owner[r + dr]
          if (line === undefined || c + dc >= width) {
            problems.push(`cell ${r},${c}: overflow`)
            continue
          }
          if (line[c + dc] !== null) problems.push(`cell ${r},${c}: overlap`)
          line[c + dc] = `${r},${c}`
        }
      }
    })
  })
  owner.forEach((line, r) => {
    line.forEach((value, c) => {
      if (value === null) problems.push(`cell ${r},${c}: uncovered`)
      else if (value !== `${r},${c}` && model.rows[r]?.cells[c] !== null) {
        problems.push(`cell ${r},${c}: should be covered`)
      }
    })
  })
  return problems
}

/** Vrai si deux modèles décrivent le même tableau. */
export function tablesEqual(a: TableModel, b: TableModel): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([, item]) => item !== undefined)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, canonical(item)]),
    )
  }
  return value
}
