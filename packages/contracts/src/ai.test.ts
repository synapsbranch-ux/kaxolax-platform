import { describe, expect, it } from 'vitest'
import {
  AI_CREDIT_MICROS,
  AI_DEFAULT_MODEL,
  aiContentBlockSchema,
  aiCreditsSchema,
  aiDisabledErrorSchema,
  aiHealthResponseSchema,
  aiMessageSchema,
  aiPageQuerySchema,
  projectAiSettingsSchema,
  updateAiSettingsInputSchema,
} from './ai.js'

const id = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'

describe('ai contracts', () => {
  it('uses the exact model id and a cent per credit', () => {
    expect(AI_DEFAULT_MODEL).toBe('claude-opus-5-5')
    expect(AI_CREDIT_MICROS * 100).toBe(1_000_000)
  })

  it('keeps the content blocks of the API as they are', () => {
    const blocks = [
      { type: 'thinking', thinking: '', signature: 'c2lnbmF0dXJl' },
      { type: 'text', text: 'Bonjour', citations: null },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'main.tex' } },
      { type: 'tool_result', tool_use_id: 'toolu_1', content: 'x', is_error: true },
      { type: 'redacted_thinking', data: 'opaque' },
      // Bloc inconnu (repli serveur, outils serveur) : gardé tel quel, champs compris.
      {
        type: 'fallback',
        from: { model: 'claude-opus-5-5' },
        to: { model: 'claude-opus-5' },
        trigger: { type: 'refusal', category: 'cyber' },
      },
    ]
    for (const block of blocks) expect(aiContentBlockSchema.parse(block)).toEqual(block)
  })

  it('rejects a malformed known block', () => {
    for (const block of [
      { type: 'text' },
      { type: 'thinking', thinking: 'x' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: 'main.tex' },
      { type: 'tool_result' },
      { text: 'sans type' },
    ]) {
      expect(aiContentBlockSchema.safeParse(block).success).toBe(false)
    }
  })

  it('describes a stored message with its usage', () => {
    const message = {
      id,
      conversationId: id,
      role: 'assistant',
      content: [{ type: 'text', text: 'Voici' }],
      model: 'claude-opus-5-5',
      status: 'truncated',
      stopReason: 'max_tokens',
      usage: {
        inputTokens: 10,
        outputTokens: 20,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 5,
        costMicros: 465,
      },
      createdAt: '2026-10-03T10:00:00.000Z',
    }
    expect(aiMessageSchema.parse(message)).toEqual(message)
    expect(aiMessageSchema.safeParse({ ...message, role: 'system' }).success).toBe(false)
  })

  it('pages with a bounded limit', () => {
    expect(aiPageQuerySchema.parse({})).toEqual({ limit: 30 })
    expect(aiPageQuerySchema.parse({ limit: '5', cursor: 'abc' })).toEqual({
      limit: 5,
      cursor: 'abc',
    })
    expect(aiPageQuerySchema.safeParse({ limit: '500' }).success).toBe(false)
  })

  it('describes the AI settings and their refusal', () => {
    const settings = {
      projectId: id,
      projectEnabled: true,
      workspaceEnabled: false,
      configured: true,
      enabled: false,
      canManage: true,
    }
    expect(projectAiSettingsSchema.parse(settings)).toEqual(settings)
    expect(updateAiSettingsInputSchema.safeParse({ enabled: false }).success).toBe(true)
    expect(updateAiSettingsInputSchema.safeParse({ enabled: 'no' }).success).toBe(false)
    expect(updateAiSettingsInputSchema.safeParse({ enabled: true, other: 1 }).success).toBe(false)
    expect(
      aiDisabledErrorSchema.parse({ code: 'E_AI_DISABLED', message: 'x', scope: 'workspace' }),
    ).toEqual({ code: 'E_AI_DISABLED', message: 'x', scope: 'workspace' })
  })

  it('describes the monthly credits and the health check', () => {
    const credits = {
      periodStart: '2026-10-01T00:00:00.000Z',
      resetsAt: '2026-11-01T00:00:00.000Z',
      ai: { monthly: 100, used: 0.01, remaining: 99.99 },
      images: { monthly: 5, used: 5, remaining: 0 },
    }
    expect(aiCreditsSchema.parse(credits)).toEqual(credits)
    expect(
      aiCreditsSchema.safeParse({ ...credits, images: { monthly: 5, used: 6, remaining: -1 } })
        .success,
    ).toBe(false)
    const health = {
      configured: false,
      model: 'claude-opus-5-5',
      ok: false,
      latencyMs: null,
      error: 'E_AI_UNAVAILABLE',
      checkedAt: '2026-10-03T10:00:00.000Z',
    }
    expect(aiHealthResponseSchema.parse(health)).toEqual(health)
  })
})
