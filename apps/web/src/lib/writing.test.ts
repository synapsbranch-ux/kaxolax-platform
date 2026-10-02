import { createTable, generateTable, mergeCells, parseTable } from '@kaxolax/editor'
import { describe, expect, it } from 'vitest'
import {
  checkPackages,
  insertStatusMessage,
  isFormulaPayload,
  isGridPaste,
  isSymbolsPayload,
  isTablePayload,
  moveInGrid,
  nextInReadingOrder,
  pasteIntoTable,
  rangeBetween,
} from './writing'

const DOC =
  '\\documentclass{article}\n\\usepackage{amsmath}\n\\begin{document}\nx\n\\end{document}\n'

describe('payload guards', () => {
  it('recognises each dialog payload by its kind', () => {
    expect(isFormulaPayload({ kind: 'formula' })).toBe(true)
    expect(isSymbolsPayload({ kind: 'symbols', math: false })).toBe(true)
    expect(isTablePayload({ kind: 'table' })).toBe(true)
    expect(isTablePayload({ kind: 'formula' })).toBe(false)
    expect(isFormulaPayload(null)).toBe(false)
    expect(isFormulaPayload('formula')).toBe(false)
  })
})

describe('insertStatusMessage', () => {
  it('stays silent on success and explains failures', () => {
    expect(insertStatusMessage('inserted')).toBeNull()
    expect(insertStatusMessage('replaced')).toBeNull()
    expect(insertStatusMessage('unchanged')).toBeNull()
    expect(insertStatusMessage('stale')?.level).toBe('warning')
    expect(insertStatusMessage('read-only')?.level).toBe('error')
  })
})

describe('checkPackages', () => {
  it('lists missing packages, providers taken into account', () => {
    expect(checkPackages(DOC, [])).toEqual({ kind: 'ok' })
    expect(checkPackages(DOC, ['amsmath'])).toEqual({ kind: 'ok' })
    expect(checkPackages(DOC, ['amssymb', 'amsmath'])).toEqual({
      kind: 'missing',
      names: ['amssymb'],
    })
    expect(checkPackages(DOC.replace('amsmath', 'mathtools'), ['amsmath'])).toEqual({ kind: 'ok' })
  })

  it('points to the main document for a file without preamble', () => {
    expect(checkPackages('\\section{A}\n$\\mathbb{R}$', ['amssymb', 'amssymb'])).toEqual({
      kind: 'no-preamble',
      names: ['amssymb'],
    })
  })
})

describe('grid navigation', () => {
  // A1:B1 fusionnées, A2:A3 fusionnées.
  const merged = mergeCells(
    mergeCells(createTable(3, 3), { top: 0, left: 0, bottom: 0, right: 1 }),
    { top: 1, left: 0, bottom: 2, right: 0 },
  )

  it('skips the cells covered by a merge', () => {
    expect(moveInGrid(merged, { row: 0, column: 0 }, 'right')).toEqual({ row: 0, column: 2 })
    expect(moveInGrid(merged, { row: 0, column: 2 }, 'left')).toEqual({ row: 0, column: 0 })
    expect(moveInGrid(merged, { row: 0, column: 1 }, 'down')).toEqual({ row: 1, column: 1 })
    expect(moveInGrid(merged, { row: 1, column: 0 }, 'down')).toBeNull()
    expect(moveInGrid(merged, { row: 2, column: 1 }, 'left')).toEqual({ row: 1, column: 0 })
    expect(moveInGrid(merged, { row: 0, column: 0 }, 'up')).toBeNull()
  })

  it('tabs through anchors in reading order', () => {
    const order = []
    let position: { row: number; column: number } | null = { row: 0, column: 0 }
    while (position) {
      order.push(`${String(position.row)}${String(position.column)}`)
      position = nextInReadingOrder(merged, position)
    }
    expect(order).toEqual(['00', '02', '10', '11', '12', '21', '22'])
    expect(nextInReadingOrder(merged, { row: 1, column: 0 }, true)).toEqual({ row: 0, column: 2 })
  })

  it('expands a selection to the merges it touches', () => {
    expect(rangeBetween(merged, { row: 0, column: 1 }, { row: 1, column: 1 })).toEqual({
      top: 0,
      left: 0,
      bottom: 2,
      right: 1,
    })
  })
})

describe('pasteIntoTable', () => {
  it('fills the grid from the cursor, grows it and escapes LaTeX', () => {
    const table = createTable(2, 2)
    const next = pasteIntoTable(table, { row: 1, column: 1 }, 'a\t50 %\nb & c\td\n')
    expect(next.rows.length).toBe(3)
    expect(next.columns.length).toBe(3)
    expect(next.rows[1]?.cells[1]?.content).toBe('a')
    expect(next.rows[1]?.cells[2]?.content).toBe('50 \\%')
    expect(next.rows[2]?.cells[1]?.content).toBe('b \\& c')
    // Le modèle reçu n'est pas modifié.
    expect(table.rows[1]?.cells[1]?.content).toBe('')
  })

  it('reads CSV and produces a table that round-trips', () => {
    const next = pasteIntoTable(createTable(1, 1), { row: 0, column: 0 }, 'x;y\n"1;2";3')
    expect(next.rows[1]?.cells[0]?.content).toBe('1;2')
    const { text } = generateTable(next)
    const parsed = parseTable(text)
    expect(parsed.ok && generateTable(parsed.model).text).toBe(text)
  })

  it('only treats multi-cell text as a grid paste', () => {
    expect(isGridPaste('plain text')).toBe(false)
    expect(isGridPaste('one line\n')).toBe(false)
    expect(isGridPaste('a\tb')).toBe(true)
    expect(isGridPaste('a\nb')).toBe(true)
  })
})
