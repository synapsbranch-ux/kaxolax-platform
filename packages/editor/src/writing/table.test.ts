import { describe, expect, it } from 'vitest'
import { detectDelimiter, parseDelimited, tableFromDelimited } from './table-import.js'
import {
  captionIssue,
  cellIssue,
  escapeLatex,
  fixCellContent,
  fixTableCells,
  generateTable,
  parseColumnsSpec,
  parseTable,
  tableAt,
  tableCellIssues,
  type TableParseResult,
} from './table-latex.js'
import {
  checkTable,
  cloneTable,
  createTable,
  deleteColumn,
  deleteRow,
  insertColumn,
  insertRow,
  mergeCells,
  setAllVerticalRules,
  setCellContent,
  setColumnAlign,
  setHorizontalRule,
  setTableRuleStyle,
  splitCell,
  tableRuleStyle,
  tablesEqual,
  type TableModel,
} from './table-model.js'

/** Grille d'un résultat d'analyse réussi. */
function grid(result: TableParseResult): TableModel {
  if (!result.ok) throw new Error(result.reason)
  return result.model
}

/** Contenus visibles (null : case couverte). */
function contents(model: TableModel): (string | null)[][] {
  return model.rows.map((row) => row.cells.map((cell) => cell?.content ?? null))
}

/** Génère, relit et vérifie l'aller-retour sans perte (modèle et texte). */
function roundTrip(model: TableModel): string {
  expect(checkTable(model)).toEqual([])
  const { text } = generateTable(model)
  const parsed = parseTable(text)
  const back = grid(parsed)
  expect(parsed.ok && parsed.warnings).toEqual([])
  expect(back).toEqual(model)
  expect(tablesEqual(back, model)).toBe(true)
  expect(generateTable(back).text).toBe(text)
  return text
}

describe('escapeLatex', () => {
  it('escapes every special character', () => {
    expect(escapeLatex('a & b % c $ d # e _ f { g } h ~ i ^ j \\ k')).toBe(
      'a \\& b \\% c \\$ d \\# e \\_ f \\{ g \\} h \\textasciitilde{} i \\textasciicircum{} j \\textbackslash{} k',
    )
    expect(escapeLatex('x < y > z | w')).toBe('x \\textless{} y \\textgreater{} z \\textbar{} w')
    expect(escapeLatex('two\r\nlines')).toBe('two lines')
  })

  it('flags cell contents that would break the grid', () => {
    expect(cellIssue('a \\& b')).toBeNull()
    expect(cellIssue('$\\begin{matrix} a & b \\\\ c \\end{matrix}$')).toBeNull()
    expect(cellIssue('a & b')).toMatch(/colonne/)
    expect(cellIssue('{a & b}')).toMatch(/colonne/)
    expect(cellIssue('\\shortstack{a \\\\ b}')).toBeNull()
    expect(cellIssue('a \\\\ b')).toMatch(/ligne/)
    expect(cellIssue('{a')).toMatch(/accolade/)
  })
})

describe('generateTable', () => {
  it('writes a booktabs table in a float with caption and label', () => {
    const model = createTable([
      ['Nom', 'Valeur'],
      ['a', '1'],
    ])
    model.caption = 'Résultats'
    model.label = 'tab:res'
    expect(generateTable(model)).toEqual({
      text: [
        '\\begin{table}[htbp]',
        '\t\\centering',
        '\t\\caption{Résultats}',
        '\t\\label{tab:res}',
        '\t\\begin{tabular}{ll}',
        '\t\t\\toprule',
        '\t\tNom & Valeur \\\\',
        '\t\t\\midrule',
        '\t\ta   & 1 \\\\',
        '\t\t\\bottomrule',
        '\t\\end{tabular}',
        '\\end{table}',
      ].join('\n'),
      packages: ['booktabs'],
      warnings: [],
    })
  })

  it('writes a classic table with vertical rules and merged cells', () => {
    let model = createTable(
      [
        ['A', 'B', 'C'],
        ['x', 'y', 'z'],
        ['u', 'v', 'w'],
      ],
      undefined,
      { style: 'classic', float: false },
    )
    model = setAllVerticalRules(model, true)
    model = mergeCells(model, { top: 0, left: 1, bottom: 0, right: 2 })
    model = mergeCells(model, { top: 1, left: 0, bottom: 2, right: 0 })
    const { text, packages } = generateTable(model)
    expect(text).toBe(
      [
        '\\begin{tabular}{|l|l|l|}',
        '\t\\hline',
        '\tA                    & \\multicolumn{2}{l|}{B C} \\\\',
        '\t\\hline',
        '\t\\multirow{2}{*}{x u} & y & z \\\\',
        '\t                     & v & w \\\\',
        '\t\\hline',
        '\\end{tabular}',
      ].join('\n'),
    )
    expect(packages).toEqual(['multirow'])
  })

  it('reports cells that would break the grid and a caption without float', () => {
    const model = createTable([['a & b']], undefined, { float: false })
    model.caption = 'x'
    const { warnings } = generateTable(model)
    expect(warnings).toHaveLength(2)
  })

  it('lists the packages of the columns and environment', () => {
    const model = setColumnAlign(createTable(1, 2), 0, 'm', '2cm')
    model.environment = 'tabularx'
    model.width = '\\linewidth'
    model.columns[1] = { align: 'X' }
    expect(generateTable(model).packages.sort()).toEqual(['array', 'booktabs', 'tabularx'])
    expect(generateTable(model).text).toContain('\\begin{tabularx}{\\linewidth}{m{2cm}X}')
  })
})

describe('round trip of generated tables', () => {
  it('keeps simple, merged, styled and floating tables identical', () => {
    roundTrip(
      createTable([
        ['a', 'b'],
        ['c', 'd'],
      ]),
    )
    roundTrip(createTable(3, 3, { style: 'none', float: false }))
    let model = createTable(
      [
        ['Groupe', 'Mesure', '', 'Note'],
        ['', 'min', 'max', ''],
        ['A', '$x_1$', '\\textbf{2}', '\\SI{3}{\\metre}'],
        ['B', '\\{a \\& b\\}', '$\\frac{1}{2}$', ''],
      ],
      undefined,
      { style: 'booktabs' },
    )
    model = mergeCells(model, { top: 0, left: 1, bottom: 0, right: 2 })
    model = mergeCells(model, { top: 0, left: 0, bottom: 1, right: 0 })
    model = mergeCells(model, { top: 0, left: 3, bottom: 1, right: 3 })
    model = mergeCells(model, { top: 3, left: 2, bottom: 3, right: 3 })
    model = setHorizontalRule(model, 1, true)
    model = setHorizontalRule(model, 2, true)
    model.caption = 'Une légende avec $x$'
    model.label = 'tab:x'
    model.captionPosition = 'below'
    model = setColumnAlign(model, 1, 'c')
    model = setColumnAlign(model, 3, 'p', '3cm')
    const text = roundTrip(model)
    expect(text).toContain('\\cmidrule{2-3}')
    expect(text).toContain('\\multicolumn{2}{c}{Mesure}')
    expect(text).toContain('\\multirow{2}{*}{Groupe}')
    roundTrip(setTableRuleStyle(model, 'classic'))
    roundTrip(setAllVerticalRules(setTableRuleStyle(model, 'classic'), true))
  })

  it('keeps a merged block spanning rows and columns', () => {
    let model = createTable(3, 3)
    model = mergeCells(model, { top: 0, left: 0, bottom: 1, right: 1 })
    model.rows[0]?.cells.splice(0, 1, { content: 'big', colspan: 2, rowspan: 2 })
    const text = roundTrip(model)
    expect(text).toContain('\\multicolumn{2}{l}{\\multirow{2}{*}{big}}')
    expect(text).toContain('\\multicolumn{2}{l}{}')
  })

  it('keeps a longtable with its caption', () => {
    const model = createTable([['a', 'b']], undefined, { float: false })
    model.environment = 'longtable'
    model.caption = 'Long'
    model.label = 'tab:long'
    const text = roundTrip(model)
    expect(text.split('\n')[1]).toBe('\t\\caption{Long} \\label{tab:long} \\\\')
  })
})

describe('parseTable', () => {
  it('reads an existing tabular with rules, merges, math and commands', () => {
    const source = String.raw`\begin{tabular}{|l||c|r@{}|}
  \hline\hline
  \multicolumn{2}{|c|}{\textbf{Head}} & $x + y$ \\ % commentaire
  \cline{1-2}
  $\alpha$ & \emph{b} & \begin{tabular}{@{}cc@{}} 1 & 2 \end{tabular} \\[2pt]
  \multirow{2}{3cm}{m} & \verb|a&b| & \\
   & d & e \\
  \hline
\end{tabular}`
    const result = parseTable(source)
    const model = grid(result)
    expect(model.columns.map((column) => column.align)).toEqual(['l', 'c', 'r'])
    expect(model.separators).toEqual(['|', '||', '|', '@{}|'])
    expect(contents(model)).toEqual([
      ['\\textbf{Head}', null, '$x + y$'],
      ['$\\alpha$', '\\emph{b}', '\\begin{tabular}{@{}cc@{}} 1 & 2 \\end{tabular}'],
      ['m', '\\verb|a&b|', ''],
      [null, 'd', 'e'],
    ])
    expect(model.rows[0]?.cells[0]).toMatchObject({ colspan: 2, spec: '|c|' })
    expect(model.rows[2]?.cells[0]).toMatchObject({ rowspan: 2, multirowWidth: '3cm' })
    expect(model.rows[1]?.spacing).toBe('[2pt]')
    expect(model.rules).toEqual([
      [{ kind: 'hline' }, { kind: 'hline' }],
      [{ kind: 'cline', from: 1, to: 2 }],
      [],
      [],
      [{ kind: 'hline' }],
    ])
    expect(result.ok && result.warnings.map((warning) => warning.code)).toEqual(['comments'])
    // Relecture du texte produit : même grille.
    expect(grid(parseTable(generateTable(model).text))).toEqual(model)
    expect(tableRuleStyle(model)).toBe('classic')
  })

  it('reads booktabs rules with options', () => {
    const model = grid(
      parseTable(
        '\\begin{tabular}{cc}\\toprule[1pt] a & b \\\\ \\cmidrule(lr){1-2} \\addlinespace c & d \\\\ \\bottomrule\\end{tabular}',
      ),
    )
    expect(model.rules).toEqual([
      [{ kind: 'toprule', width: '1pt' }],
      [
        { kind: 'cmidrule', from: 1, to: 2, trim: 'lr' },
        { kind: 'raw', text: '\\addlinespace' },
      ],
      [{ kind: 'bottomrule' }],
    ])
    expect(generateTable(model).text).toContain('\\cmidrule(lr){1-2} \\addlinespace')
  })

  it('normalizes repeated columns and incomplete rows with a warning', () => {
    const result = parseTable('\\begin{tabular}{*{3}{c}} a & b \\\\ c \\end{tabular}')
    const model = grid(result)
    expect(model.columns).toHaveLength(3)
    expect(contents(model)).toEqual([
      ['a', 'b', ''],
      ['c', '', ''],
    ])
    expect(result.ok && result.warnings.map((warning) => warning.code).sort()).toEqual([
      'missing-cells',
      'normalized',
      'normalized',
    ])
  })

  it('keeps an overlapping \\multirow as raw content', () => {
    const result = parseTable(
      '\\begin{tabular}{ll} \\multirow{2}{*}{a} & b \\\\ c & d \\\\ \\end{tabular}',
    )
    expect(contents(grid(result))).toEqual([
      ['\\multirow{2}{*}{a}', 'b'],
      ['c', 'd'],
    ])
    expect(result.ok && result.warnings[0]?.code).toBe('raw-cell')
  })

  it('falls back to raw text when the table is not representable', () => {
    const source = '\\begin{tabular}{ll} a & b & c \\\\ \\end{tabular}'
    expect(parseTable(source)).toEqual({
      ok: false,
      reason: 'Une ligne a 3 cellules pour 2 colonnes.',
      raw: source,
    })
    expect(parseTable('\\begin{tabular}{l?} a \\end{tabular}').ok).toBe(false)
    expect(parseTable('no table').ok).toBe(false)
  })

  it('reads tabular* and tabularx widths and positions', () => {
    const star = grid(parseTable('\\begin{tabular*}{\\textwidth}[t]{l} a \\\\ \\end{tabular*}'))
    expect(star).toMatchObject({ environment: 'tabular*', width: '\\textwidth', position: 't' })
    const x = grid(
      parseTable('\\begin{tabularx}{0.5\\linewidth}{>{\\bfseries}lX} a & b \\\\ \\end{tabularx}'),
    )
    expect(x.columns).toEqual([{ align: 'l', before: '\\bfseries' }, { align: 'X' }])
    expect(generateTable(x).text).toContain('\\begin{tabularx}{0.5\\linewidth}{>{\\bfseries}lX}')
  })

  it('parses column specifications', () => {
    expect(parseColumnsSpec('|p{3cm}|>{\\centering}m{2cm}<{x}|')).toEqual({
      columns: [
        { align: 'p', width: '3cm' },
        { align: 'm', width: '2cm', before: '\\centering', after: 'x' },
      ],
      separators: ['|', '|', '|'],
      normalized: false,
    })
  })
})

describe('tableAt', () => {
  const doc = [
    'Avant',
    '\\begin{table}[h]',
    '  \\centering',
    '  \\begin{tabular}{ll}',
    '    a & b \\\\',
    '  \\end{tabular}',
    '  \\caption{Cap}',
    '  \\label{tab:a}',
    '\\end{table}',
    'Après',
  ].join('\n')

  it('selects the whole float when it holds only the table', () => {
    const match = tableAt(doc, doc.indexOf('a & b'))
    expect(match?.scope).toBe('float')
    expect(match?.text).toBe(doc.slice(doc.indexOf('\\begin{table}'), doc.indexOf('\nAprès')))
    const model = match?.result.ok ? match.result.model : null
    expect(model).toMatchObject({
      float: { environment: 'table', placement: 'h', centering: true },
      caption: 'Cap',
      label: 'tab:a',
      captionPosition: 'below',
    })
    // Curseur sur la légende : même tableau.
    expect(tableAt(doc, doc.indexOf('Cap'))?.from).toBe(match?.from)
    expect(tableAt(doc, 2)).toBeNull()
  })

  it('selects only the tabular when the float holds something else', () => {
    const other = doc.replace('\\centering', '\\small')
    const match = tableAt(other, other.indexOf('a & b'))
    expect(match?.scope).toBe('tabular')
    expect(match?.text.startsWith('\\begin{tabular}')).toBe(true)
    expect(match?.result.ok && match.result.warnings.map((warning) => warning.code)).toEqual([
      'float-content',
    ])
  })

  it('picks the innermost table and ignores commented ones', () => {
    const nested =
      '\\begin{tabular}{l} \\begin{tabular}{c} x \\\\ \\end{tabular} \\\\ \\end{tabular}'
    expect(tableAt(nested, nested.indexOf('x'))?.text).toBe(
      '\\begin{tabular}{c} x \\\\ \\end{tabular}',
    )
    expect(tableAt('% \\begin{tabular}{l} x \\end{tabular}', 20)).toBeNull()
  })
})

describe('grid operations', () => {
  it('merges and splits cells', () => {
    let model = createTable([
      ['a', 'b', 'c'],
      ['d', 'e', 'f'],
    ])
    model = mergeCells(model, { top: 0, left: 0, bottom: 1, right: 1 })
    expect(contents(model)).toEqual([
      ['a b d e', null, 'c'],
      [null, null, 'f'],
    ])
    expect(checkTable(model)).toEqual([])
    // Une plage qui touche une fusion l'englobe.
    const bigger = mergeCells(model, { top: 1, left: 1, bottom: 1, right: 2 })
    expect(contents(bigger)).toEqual([
      ['a b d e c f', null, null],
      [null, null, null],
    ])
    model = splitCell(model, 1, 1)
    expect(contents(model)).toEqual([
      ['a b d e', '', 'c'],
      ['', '', 'f'],
    ])
    expect(checkTable(model)).toEqual([])
  })

  it('inserts and deletes rows and columns around merges', () => {
    let model = mergeCells(createTable(3, 3), { top: 0, left: 0, bottom: 1, right: 1 })
    model = insertRow(model, 1)
    expect(model.rows[0]?.cells[0]?.rowspan).toBe(3)
    expect(checkTable(model)).toEqual([])
    model = insertColumn(model, 1)
    expect(model.rows[0]?.cells[0]?.colspan).toBe(3)
    expect(checkTable(model)).toEqual([])
    model = deleteRow(model, 0)
    expect(model.rows[0]?.cells[0]).toMatchObject({ rowspan: 2, colspan: 3 })
    expect(checkTable(model)).toEqual([])
    model = deleteColumn(model, 0)
    expect(model.rows[0]?.cells[0]).toMatchObject({ rowspan: 2, colspan: 2 })
    expect(checkTable(model)).toEqual([])
    expect(model.columns).toHaveLength(3)
    expect(model.separators).toHaveLength(4)
    expect(model.rules).toHaveLength(model.rows.length + 1)
  })

  it('keeps the bottom rule at the bottom when a row is appended', () => {
    const model = insertRow(createTable(2, 2), 2)
    expect(model.rules.map((rules) => rules.map((rule) => rule.kind))).toEqual([
      ['toprule'],
      ['midrule'],
      [],
      ['bottomrule'],
    ])
    expect(deleteRow(model, 2).rules.map((rules) => rules.map((rule) => rule.kind))).toEqual([
      ['toprule'],
      ['midrule'],
      ['bottomrule'],
    ])
  })

  it('draws partial rules across a vertical merge and converts styles', () => {
    let model = mergeCells(createTable(3, 3), { top: 0, left: 1, bottom: 1, right: 1 })
    model = setHorizontalRule(model, 1, true)
    expect(model.rules[1]).toEqual([
      { kind: 'cmidrule', from: 1, to: 1 },
      { kind: 'cmidrule', from: 3, to: 3 },
    ])
    const classic = setTableRuleStyle(model, 'classic')
    expect(classic.rules[0]).toEqual([{ kind: 'hline' }])
    expect(classic.rules[1]?.[0]).toEqual({ kind: 'cline', from: 1, to: 1 })
    expect(tableRuleStyle(classic)).toBe('classic')
    expect(setTableRuleStyle(classic, 'booktabs').rules[3]).toEqual([{ kind: 'bottomrule' }])
    expect(tableRuleStyle(setTableRuleStyle(model, 'none'))).toBe('none')
    expect(setHorizontalRule(model, 1, false).rules[1]).toEqual([])
  })
})

describe('import', () => {
  it('detects the delimiter', () => {
    expect(detectDelimiter('a\tb\nc\td')).toBe('\t')
    expect(detectDelimiter('a;b;c\n1,5;2,5;3')).toBe(';')
    expect(detectDelimiter('a,b\n1,2')).toBe(',')
    expect(detectDelimiter('"a;b",c')).toBe(',')
  })

  it('reads quoted CSV fields with separators, quotes and newlines', () => {
    expect(parseDelimited('﻿name,"a, b","say ""hi"""\r\nx,"multi\nline",\r\n')).toEqual([
      ['name', 'a, b', 'say "hi"'],
      ['x', 'multi\nline', ''],
    ])
    expect(parseDelimited('a;b\n1')).toEqual([
      ['a', 'b'],
      ['1', ''],
    ])
  })

  it('builds an escaped table from a spreadsheet paste', () => {
    const model = tableFromDelimited('Produit\tPrix\nA&B\t12,5\n50%\t3\n\n')
    expect(contents(model ?? createTable(1, 1))).toEqual([
      ['Produit', 'Prix'],
      ['A\\&B', '12,5'],
      ['50\\%', '3'],
    ])
    expect(model?.columns.map((column) => column.align)).toEqual(['l', 'r'])
    expect(tableFromDelimited('  \n ')).toBeNull()
    expect(tableFromDelimited('$x$,y', { escape: false })?.rows[0]?.cells[0]?.content).toBe('$x$')
  })
})

describe('cells that would not compile', () => {
  it('reports special characters typed as text', () => {
    expect(cellIssue('20%')).toMatch(/%/)
    expect(cellIssue('n° #3')).toMatch(/#/)
    expect(cellIssue('5$')).toMatch(/\$/)
    expect(cellIssue('x_1')).toMatch(/_/)
    expect(cellIssue('2^3')).toMatch(/\^/)
    expect(cellIssue('20\\%, \\#3, \\$5, $x_1^2$, \\(y_2\\)')).toBeNull()
    // Colonne mathématique (`>{$}c<{$}`) : `_` est permis.
    expect(cellIssue('x_1', { math: true })).toBeNull()
  })

  it('escapes them in one click and keeps valid LaTeX', () => {
    expect(fixCellContent('20%')).toBe('20\\%')
    expect(fixCellContent('R&D #1 a_b 2^3')).toBe('R\\&D \\#1 a\\_b 2\\textasciicircum{}3')
    expect(fixCellContent('$x_1$ coûte 5$')).toBe('$x_1$ coûte 5\\$')
    expect(fixCellContent('\\textbf{20%}')).toBe('\\textbf{20\\%}')
    expect(cellIssue(fixCellContent('a \\\\ b'))).toMatch(/ligne/)
  })

  it('lists the cells to fix before insertion', () => {
    const model = setCellContent(createTable(2, 2), 1, 1, '20%')
    expect(generateTable(model).warnings).toEqual([
      'Ligne 2, colonne 2 : « % » non échappé commente la fin de la ligne',
    ])
    expect(tableCellIssues(model)).toEqual([
      { row: 1, column: 1, message: expect.stringMatching(/%/) as unknown, fixable: true },
    ])
    const fixed = fixTableCells(model)
    expect(fixed.rows[1]?.cells[1]?.content).toBe('20\\%')
    expect(tableCellIssues(fixed)).toEqual([])
    const math = cloneTable(model)
    const column = math.columns[0]
    if (column) column.before = '$'
    math.rows[0]?.cells.splice(0, 1, { content: 'x_1', colspan: 1, rowspan: 1 })
    expect(tableCellIssues(math).map((issue) => issue.column)).toEqual([1])
  })
})

describe('tables already in a float', () => {
  it('flags a lone tabular that cannot receive its own float', () => {
    const inFloat =
      '\\begin{table}\n\\small\n\\begin{tabular}{l}\nx \\\\\n\\end{tabular}\n\\end{table}'
    expect(tableAt(inFloat, inFloat.indexOf('x \\\\'))).toMatchObject({
      scope: 'tabular',
      nested: true,
    })
    const boxed = '\\resizebox{\\linewidth}{!}{%\n\\begin{tabular}{l}\nx \\\\\n\\end{tabular}}'
    expect(tableAt(boxed, boxed.indexOf('x \\\\'))?.nested).toBe(true)
    const alone = 'Text\n\\begin{tabular}{l}\nx \\\\\n\\end{tabular}\n'
    expect(tableAt(alone, alone.indexOf('x \\\\'))?.nested).toBe(false)
  })
})

describe('review fixes (round 2)', () => {
  it('writes the width of tabular* and tabularx before their position', () => {
    for (const source of [
      '\\begin{tabularx}{\\linewidth}[t]{XX} a & b \\\\ \\end{tabularx}',
      '\\begin{tabular*}{\\textwidth}[b]{ll} a & b \\\\ \\end{tabular*}',
    ]) {
      const model = grid(parseTable(source))
      const edited = setCellContent(model, 0, 0, 'z')
      const text = generateTable(edited).text
      expect(text).toMatch(/\\begin\{tabular[x*]\}\{\\(line|text)width\}\[[tb]\]\{/)
      roundTrip(edited)
    }
  })

  it('keeps a longtable continuation caption as a raw row', () => {
    const source = [
      '\\begin{longtable}{ll}',
      '\\caption{Résultats}\\label{tab:r} \\\\',
      '\\toprule',
      'A & B \\\\',
      '\\midrule',
      '\\endfirsthead',
      '\\caption[]{Résultats (suite)} \\\\',
      '\\toprule',
      'A & B \\\\',
      '\\midrule',
      '\\endhead',
      'a & b \\\\',
      '\\bottomrule',
      '\\end{longtable}',
    ].join('\n')
    const parsed = parseTable(source)
    const model = grid(parsed)
    expect(parsed.ok && parsed.warnings).toEqual([])
    expect(model.caption).toBe('Résultats')
    expect(model.rows).toHaveLength(3)
    const text = generateTable(setCellContent(model, 2, 0, 'x')).text
    expect(text).toContain('\\caption[]{Résultats (suite)} \\\\')
    expect(text).not.toMatch(/\\caption\[\]\{Résultats \(suite\)\}\s*&/)
    roundTrip(setCellContent(model, 2, 0, 'x'))
  })

  it('reads \\cmidrule with a width and keeps \\rowcolor at the start of its row', () => {
    const model = grid(
      parseTable(
        '\\begin{tabular}{cc} a & b \\\\ \\cmidrule[0.4pt](lr){1-2} \\rowcolor[gray]{0.9} c & d \\\\ \\end{tabular}',
      ),
    )
    expect(model.rules[1]).toEqual([
      { kind: 'cmidrule', from: 1, to: 2, trim: 'lr', width: '0.4pt' },
    ])
    expect(model.rows[1]).toEqual({
      prefix: '\\rowcolor[gray]{0.9}',
      cells: [
        { content: 'c', colspan: 1, rowspan: 1 },
        { content: 'd', colspan: 1, rowspan: 1 },
      ],
    })
    const widened = insertColumn(model, 0)
    const text = generateTable(widened).text
    expect(text).toContain('\\cmidrule[0.4pt](lr){2-3}')
    expect(text).toMatch(/\n\t\\rowcolor\[gray\]\{0\.9\} +& c +& d \\\\/)
    roundTrip(model)
    // Le style booktabs gardé conserve largeur et rognage.
    expect(setTableRuleStyle(model, 'booktabs').rules[1]).toEqual(model.rules[1])
  })

  it('flags and escapes a caption that would not compile', () => {
    const model = createTable([['a', 'b']])
    model.caption = 'Taux de 50% & co #1'
    expect(captionIssue(model)).toEqual({ message: expect.any(String) as string, fixable: true })
    expect(generateTable(model).warnings.join(' ')).toContain('Légende')
    const fixed = fixTableCells(model)
    expect(fixed.caption).toBe('Taux de 50\\% \\& co \\#1')
    expect(captionIssue(fixed)).toBeNull()
    model.caption = 'a {b'
    expect(captionIssue(model)?.fixable).toBe(false)
    // Légende ignorée (tableau seul) : rien à signaler.
    model.float = null
    expect(captionIssue(model)).toBeNull()
  })

  it('does not split a column of French decimal numbers', () => {
    expect(detectDelimiter('3,5\n4,2')).toBe('\t')
    expect(detectDelimiter('3,5\n12\n-1 234,56')).toBe('\t')
    expect(detectDelimiter('Valeur\n3,5\n4,2')).toBe('\t')
    expect(detectDelimiter('a,b\n3,5')).toBe(',')
    expect(parseDelimited('3,5\n4,2')).toEqual([['3,5'], ['4,2']])
    expect(tableFromDelimited('3,5\n4,2', { header: false })?.columns).toHaveLength(1)
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',')
    expect(detectDelimiter('3,5;4,2\n1,0;2,0')).toBe(';')
  })
})
