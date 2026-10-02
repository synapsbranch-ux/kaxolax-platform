import { describe, expect, it } from 'vitest'
import {
  CHAT_MESSAGE_MAX_LENGTH,
  chatMessagesQuerySchema,
  createChatMessageInputSchema,
  extractMentionIds,
  mentionToken,
  parseChatBody,
} from './chat.js'

const ADA = '0b9f8d3e-5a4c-4b1e-9f2a-3c4d5e6f7a8b'
const BOB = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'

describe('chat mentions', () => {
  it('extracts distinct mentioned ids, lowercased, in order', () => {
    const body = `Salut ${mentionToken(BOB)} et <@${ADA.toUpperCase()}>, encore ${mentionToken(BOB)}`
    expect(extractMentionIds(body)).toEqual([BOB, ADA])
    expect(extractMentionIds('écrire à <@pas-un-uuid> ou @Bob')).toEqual([])
  })
})

describe('parseChatBody', () => {
  it('splits text, mentions and file references', () => {
    expect(parseChatBody(`Regarde main.tex:42 ${mentionToken(ADA)} !`)).toEqual([
      { kind: 'text', text: 'Regarde ' },
      { kind: 'file-ref', path: 'main.tex', line: 42, text: 'main.tex:42' },
      { kind: 'text', text: ' ' },
      { kind: 'mention', userId: ADA },
      { kind: 'text', text: ' !' },
    ])
  })

  it('accepts folders and punctuation around a reference', () => {
    expect(parseChatBody('(chapitres/intro-1.tex:7).')).toEqual([
      { kind: 'text', text: '(' },
      { kind: 'file-ref', path: 'chapitres/intro-1.tex', line: 7, text: 'chapitres/intro-1.tex:7' },
      { kind: 'text', text: ').' },
    ])
    expect(parseChatBody('résumé.tex:3')).toEqual([
      { kind: 'file-ref', path: 'résumé.tex', line: 3, text: 'résumé.tex:3' },
    ])
  })

  it('ignores lookalikes: URLs, line 0, glued text, no extension', () => {
    for (const text of [
      'http://exemple.org/a.tex:3',
      'main.tex:0',
      'main.tex:12abc',
      'a/main.tex:4x',
      'Makefile:3',
      'à 10:30',
    ]) {
      expect(parseChatBody(text).every((segment) => segment.kind === 'text')).toBe(true)
    }
  })

  it('keeps HTML as plain text', () => {
    expect(parseChatBody('<img src=x onerror=alert(1)>')).toEqual([
      { kind: 'text', text: '<img src=x onerror=alert(1)>' },
    ])
    expect(parseChatBody('')).toEqual([])
  })
})

describe('chat inputs', () => {
  it('trims and bounds the message body', () => {
    expect(createChatMessageInputSchema.parse({ body: '  bonjour \n' })).toEqual({
      body: 'bonjour',
    })
    expect(createChatMessageInputSchema.safeParse({ body: '   ' }).success).toBe(false)
    expect(
      createChatMessageInputSchema.safeParse({ body: 'a'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1) })
        .success,
    ).toBe(false)
  })

  it('reads the history query and rejects two cursors', () => {
    expect(chatMessagesQuerySchema.parse({ limit: '10', before: ADA })).toEqual({
      limit: 10,
      before: ADA,
    })
    expect(chatMessagesQuerySchema.parse({}).limit).toBe(50)
    expect(chatMessagesQuerySchema.safeParse({ before: ADA, after: BOB }).success).toBe(false)
    expect(chatMessagesQuerySchema.safeParse({ limit: '1000' }).success).toBe(false)
  })
})
