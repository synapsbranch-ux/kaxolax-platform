import { describe, expect, it } from 'vitest'
import {
  createSuggestionInputSchema,
  SUGGESTION_TEXT_MAX_LENGTH,
  suggestionSchema,
  suggestionTextsMatchKind,
} from './suggestions.js'

const documentId = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'
const author = { id: documentId, fullName: 'Ada Lovelace', avatarUrl: null }

describe('suggestion contracts', () => {
  it('matches the texts with the kind of change', () => {
    expect(suggestionTextsMatchKind('insert', '', 'nouveau')).toBe(true)
    expect(suggestionTextsMatchKind('insert', 'ancien', 'nouveau')).toBe(false)
    expect(suggestionTextsMatchKind('delete', 'ancien', '')).toBe(true)
    expect(suggestionTextsMatchKind('delete', '', '')).toBe(false)
    expect(suggestionTextsMatchKind('replace', 'ancien', 'nouveau')).toBe(true)
    expect(suggestionTextsMatchKind('replace', 'même', 'même')).toBe(false)
    expect(suggestionTextsMatchKind('replace', '', 'nouveau')).toBe(false)
  })

  it('validates a new suggestion', () => {
    const input = { documentId, kind: 'insert', anchor: 'AQAAAAUBAgME', proposedText: ' et ' }
    expect(createSuggestionInputSchema.parse(input)).toEqual({ ...input, originalText: '' })
    for (const invalid of [
      { ...input, kind: 'delete' },
      { ...input, anchor: 'pas du base64' },
      { ...input, proposedText: 'x'.repeat(SUGGESTION_TEXT_MAX_LENGTH + 1) },
      { ...input, kind: 'move' },
      { ...input, status: 'accepted' },
    ]) {
      expect(createSuggestionInputSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('describes a suggestion made by the AI and accepted', () => {
    const suggestion = {
      id: documentId,
      documentId,
      author,
      origin: 'ai',
      kind: 'replace',
      anchor: 'AQAAAAUBAgME',
      originalText: 'teh',
      proposedText: 'the',
      status: 'accepted',
      decidedBy: author,
      decidedAt: '2026-10-03T10:00:00.000Z',
      aiMessageId: documentId,
      createdAt: '2026-10-03T09:00:00.000Z',
    }
    expect(suggestionSchema.parse(suggestion)).toEqual(suggestion)
    expect(suggestionSchema.safeParse({ ...suggestion, origin: 'bot' }).success).toBe(false)
  })
})
