import { describe, expect, it } from 'vitest'
import { logicalLines, plainLines } from './lines.js'

const encoder = new TextEncoder()

function bytes(...parts: (string | number[])[]): Uint8Array {
  const chunks = parts.map((part) =>
    typeof part === 'string' ? encoder.encode(part) : new Uint8Array(part),
  )
  const result = new Uint8Array(chunks.reduce((sum, chunk) => sum + chunk.length, 0))
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.length
  }
  return result
}

describe('logicalLines', () => {
  it('joins pdfTeX lines of exactly 79 bytes, even inside a UTF-8 character', () => {
    // « ç » = C3 A7 : pdfTeX coupe entre les deux octets.
    const first = 'a'.repeat(78)
    const log = bytes('This is pdfTeX, Version 3.14\n', first, [0xc3], '\n', [0xa7], ' suite\n')
    expect(logicalLines(log)).toEqual(['This is pdfTeX, Version 3.14', `${first}ç suite`, ''])
  })

  it('counts characters, not bytes, for XeTeX and LuaTeX', () => {
    const wide = 'é'.repeat(79)
    const log = `This is XeTeX, Version 3.14\n${wide}\nnext\nshort\n`
    expect(logicalLines(log)).toEqual(['This is XeTeX, Version 3.14', `${wide}next`, 'short', ''])
    // En octets, la même ligne (158 octets) ne serait pas recollée.
    const pdftex = `This is pdfTeX, Version 3.14\n${wide}\nnext\n`
    expect(logicalLines(pdftex)).toEqual(['This is pdfTeX, Version 3.14', wide, 'next', ''])
  })

  it('joins several consecutive wrapped lines and supports another max_print_line', () => {
    const log = `This is pdfTeX\n${'x'.repeat(10)}\n${'y'.repeat(10)}\nz\n`
    expect(logicalLines(log, 10)).toEqual([
      'This is pdfTeX',
      `${'x'.repeat(10)}${'y'.repeat(10)}z`,
      '',
    ])
  })

  it('handles CRLF line endings and a missing final newline', () => {
    expect(logicalLines('This is pdfTeX\r\nline')).toEqual(['This is pdfTeX', 'line'])
  })
})

describe('plainLines', () => {
  it('splits without joining', () => {
    expect(plainLines(`${'a'.repeat(79)}\nb`)).toEqual(['a'.repeat(79), 'b'])
  })
})
