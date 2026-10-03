import { describe, expect, it } from 'vitest'
import { parseProjectEventMessage, projectEventMessage, projectEventSchema } from './events.js'
import {
  applySuggestionsRequestSchema,
  createSuggestionInputSchema,
  decideSuggestionsInputSchema,
  SUGGESTION_APPLY_BATCH,
  SUGGESTION_DECIDE_MAX,
  SUGGESTION_TEXT_MAX_LENGTH,
  suggestionSchema,
  suggestionsQuerySchema,
  suggestionTextsMatchKind,
  updateSuggestionInputSchema,
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

describe('suggestion routes', () => {
  it('validates the change of an open suggestion by its author', () => {
    const change = { kind: 'replace', anchor: 'AQAAAAUBAgME', originalText: 'a', proposedText: 'b' }
    expect(updateSuggestionInputSchema.parse(change)).toEqual(change)
    expect(updateSuggestionInputSchema.safeParse({ ...change, proposedText: 'a' }).success).toBe(
      false,
    )
    expect(updateSuggestionInputSchema.safeParse({ ...change, documentId }).success).toBe(false)
  })

  it('lists open suggestions by default and bounds the page', () => {
    expect(suggestionsQuerySchema.parse({})).toEqual({ status: 'open', limit: 500 })
    expect(
      suggestionsQuerySchema.parse({ status: 'decided', limit: '20', authorId: documentId }),
    ).toEqual({ status: 'decided', limit: 20, authorId: documentId })
    expect(suggestionsQuerySchema.safeParse({ limit: '5000' }).success).toBe(false)
    expect(suggestionsQuerySchema.safeParse({ status: 'pending' }).success).toBe(false)
    const after = `1790000000123456_${documentId}`
    expect(suggestionsQuerySchema.parse({ after })).toMatchObject({ after })
    expect(suggestionsQuerySchema.safeParse({ after: documentId }).success).toBe(false)
  })

  it('decides exactly one target: ids, all or one author', () => {
    for (const valid of [
      { decision: 'accept', ids: [documentId] },
      { decision: 'reject', all: true },
      { decision: 'accept', all: true, documentId },
      { decision: 'reject', authorId: documentId },
    ]) {
      expect(decideSuggestionsInputSchema.safeParse(valid).success).toBe(true)
    }
    for (const invalid of [
      { decision: 'accept' },
      { decision: 'accept', ids: [] },
      { decision: 'accept', ids: [documentId], all: true },
      { decision: 'accept', all: true, authorId: documentId },
      { decision: 'accept', all: false },
      { decision: 'accept', ids: [documentId], documentId },
      { decision: 'maybe', all: true },
      {
        decision: 'accept',
        ids: Array.from({ length: SUGGESTION_DECIDE_MAX + 1 }, () => documentId),
      },
    ]) {
      expect(decideSuggestionsInputSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('bounds a batch applied by the realtime service', () => {
    const suggestion = {
      id: documentId,
      authorId: documentId,
      kind: 'insert',
      anchor: 'AQAAAAUBAgME',
      originalText: '',
      proposedText: 'x',
    }
    const request = { decidedBy: documentId, suggestions: [suggestion] }
    expect(applySuggestionsRequestSchema.parse(request)).toEqual(request)
    expect(
      applySuggestionsRequestSchema.safeParse({
        decidedBy: documentId,
        suggestions: Array.from({ length: SUGGESTION_APPLY_BATCH + 1 }, () => suggestion),
      }).success,
    ).toBe(false)
  })

  it('carries the suggestion events on the meta document', () => {
    const events = [
      { type: 'suggestion.created', suggestionId: documentId, documentId, authorId: documentId },
      {
        type: 'suggestion.updated',
        suggestionId: documentId,
        documentId,
        change: 'deleted',
        actorId: documentId,
      },
      {
        type: 'suggestion.decided',
        decisions: [{ suggestionId: documentId, documentId, status: 'stale' }],
        actorId: documentId,
      },
    ]
    for (const event of events) {
      const parsed = projectEventSchema.parse(event)
      const message = parseProjectEventMessage(JSON.stringify(projectEventMessage(parsed)))
      expect(message?.event).toEqual(event)
    }
    expect(
      projectEventSchema.safeParse({
        type: 'suggestion.decided',
        decisions: [{ suggestionId: documentId, documentId, status: 'open' }],
        actorId: documentId,
      }).success,
    ).toBe(false)
  })
})
