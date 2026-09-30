import { describe, expect, it } from 'vitest'
import {
  hasTextDocumentExtension,
  isPreviewableImage,
  isTextDocument,
  MAX_TEXT_DOCUMENT_BYTES,
  mimeTypeFor,
} from './files.js'

const encode = (text: string) => new TextEncoder().encode(text)

describe('hasTextDocumentExtension', () => {
  it.each(['main.tex', 'refs.bib', 'STYLE.STY', 'notes.md', 'data.csv', 'a.bbx', 'a.cbx', 'x.bst'])(
    'treats %s as text',
    (name) => {
      expect(hasTextDocumentExtension(name)).toBe(true)
    },
  )

  it.each(['plot.png', 'paper.pdf', 'Makefile', 'main.tex.bak', 'font.otf'])(
    'treats %s as binary',
    (name) => {
      expect(hasTextDocumentExtension(name)).toBe(false)
    },
  )
})

describe('isTextDocument', () => {
  it('accepts a small UTF-8 .tex file', () => {
    expect(isTextDocument('main.tex', encode('\\documentclass{article} é'))).toBe(true)
  })

  it('rejects invalid UTF-8', () => {
    expect(isTextDocument('main.tex', new Uint8Array([0x5c, 0xff, 0xfe]))).toBe(false)
  })

  it('rejects files of 2 MB or more', () => {
    expect(isTextDocument('big.tex', new Uint8Array(MAX_TEXT_DOCUMENT_BYTES))).toBe(false)
    expect(isTextDocument('big.tex', new Uint8Array(MAX_TEXT_DOCUMENT_BYTES - 1))).toBe(true)
  })

  it('rejects a non-text extension even if the content is UTF-8', () => {
    expect(isTextDocument('image.png', encode('hello'))).toBe(false)
  })
})

describe('mimeTypeFor', () => {
  it('derives the type from the extension, whatever its case', () => {
    expect(mimeTypeFor('figures/plot.PNG')).toBe('image/png')
    expect(mimeTypeFor('photo.jpeg')).toBe('image/jpeg')
    expect(mimeTypeFor('diagram.pdf')).toBe('application/pdf')
  })

  it('falls back to application/octet-stream', () => {
    expect(mimeTypeFor('data.bin')).toBe('application/octet-stream')
    expect(mimeTypeFor('Makefile')).toBe('application/octet-stream')
  })

  it('only previews browser images', () => {
    expect(isPreviewableImage('image/png')).toBe(true)
    expect(isPreviewableImage('application/pdf')).toBe(false)
  })
})
