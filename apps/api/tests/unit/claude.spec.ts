import { test } from '@japa/runner'
import { OPERATION_SETTINGS } from '#services/claude/operations'
import {
  callCost,
  estimateCostMicros,
  lineCostMicros,
  MODEL_PRICING,
  outputTokensWithin,
  pricingOf,
  visibleOutputTokens,
  worstCaseCostMicros,
} from '#services/claude/pricing'
import { AiRateLimiter } from '#services/claude/rate_limiter'

const usage = {
  input_tokens: 0,
  output_tokens: 0,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: 0,
  cache_creation: null,
  fallback_credit: null,
  inference_geo: null,
  iterations: null,
  output_tokens_details: null,
  server_tool_use: null,
  service_tier: null,
  speed: null,
} as const

test.group('claude: pricing', () => {
  test('keeps one price table, Opus 5.5 at $4 / $20 and $0.20 for cache reads', ({ assert }) => {
    assert.deepEqual(MODEL_PRICING['claude-opus-5-5'], {
      input: 4,
      output: 20,
      cacheRead: 0.2,
      cacheWrite5m: 5,
      cacheWrite1h: 8,
    })
    // Un million de tokens d'entrée : 4 $ = 4 000 000 micro-dollars.
    assert.equal(
      lineCostMicros({
        model: 'claude-opus-5-5',
        inputTokens: 1_000_000,
        outputTokens: 0,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheCreation1hInputTokens: 0,
      }),
      4_000_000,
    )
  })

  test('prices input, output, cache reads and both cache lifetimes', ({ assert }) => {
    const cost = callCost({
      model: 'claude-opus-5-5',
      usage: {
        ...usage,
        input_tokens: 1000,
        output_tokens: 300,
        cache_read_input_tokens: 10_000,
        cache_creation_input_tokens: 3000,
        cache_creation: { ephemeral_5m_input_tokens: 2000, ephemeral_1h_input_tokens: 1000 },
      },
    })
    // 1000 × 4 + 300 × 20 + 10 000 × 0,2 + 2000 × 5 + 1000 × 8.
    assert.equal(cost.costMicros, 30_000)
    assert.deepEqual(cost.totals, {
      inputTokens: 1000,
      outputTokens: 300,
      cacheReadInputTokens: 10_000,
      cacheCreationInputTokens: 3000,
      cacheCreation1hInputTokens: 1000,
    })
    assert.deepEqual(cost.unknownModels, [])
  })

  test('rounds up to the micro-dollar', ({ assert }) => {
    const cost = callCost({
      model: 'claude-opus-5-5',
      usage: { ...usage, cache_read_input_tokens: 3 },
    })
    // 3 × 0,2 = 0,6 µ$ : compté 1.
    assert.equal(cost.costMicros, 1)
  })

  test('counts every iteration at the price of its model', ({ assert }) => {
    const cost = callCost({
      model: 'claude-opus-4-8',
      usage: {
        ...usage,
        input_tokens: 500,
        output_tokens: 100,
        iterations: [
          {
            type: 'message',
            model: null,
            input_tokens: 500,
            output_tokens: 10,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null,
          },
          {
            type: 'compaction',
            input_tokens: 1000,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null,
          },
          {
            type: 'fallback_message',
            model: 'claude-opus-4-8',
            input_tokens: 500,
            output_tokens: 100,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null,
          },
        ],
      },
    })
    // Sans modèle, une itération est comptée au modèle de la réponse (Opus 4.8 : 5 $ / 25 $).
    assert.deepEqual(
      cost.lines.map((line) => line.model),
      ['claude-opus-4-8', 'claude-opus-4-8', 'claude-opus-4-8'],
    )
    assert.equal(cost.costMicros, (500 + 1000 + 500) * 5 + (10 + 50 + 100) * 25)
    assert.equal(cost.totals.inputTokens, 2000)
  })

  test('uses the highest prices for an unknown model, never less', ({ assert }) => {
    const { pricing, known } = pricingOf('claude-future-9')
    assert.isFalse(known)
    assert.deepEqual(pricing, {
      input: 5,
      output: 25,
      cacheRead: 0.5,
      cacheWrite5m: 6.25,
      cacheWrite1h: 10,
    })
    const cost = callCost({ model: 'claude-future-9', usage: { ...usage, input_tokens: 10 } })
    assert.deepEqual(cost.unknownModels, ['claude-future-9'])
    assert.equal(cost.costMicros, 50)
  })

  test('estimates a reservation from the request size and the expected output', ({ assert }) => {
    const request = { system: 'x'.repeat(2990), tools: [], messages: [] }
    // JSON de 3000 caractères ≈ 1000 tokens × 4 + 500 tokens × 20.
    assert.equal(estimateCostMicros('claude-opus-5-5', request, 500), 14_000)
    // `[null,null,[]]` : 14 caractères, 5 tokens.
    assert.equal(estimateCostMicros('claude-opus-5-5', { messages: [] }, 0), 20)
  })

  test('reserves the worst case: whole max_tokens at the highest price of the table', ({
    assert,
  }) => {
    const request = { system: 'x'.repeat(2990), tools: [], messages: [] }
    // 1000 tokens × 5 + 8000 × 25 (prix d'Opus 5, cible possible du repli serveur).
    assert.equal(worstCaseCostMicros(request, 8000), 205_000)
    assert.equal(outputTokensWithin(request, 205_000, 64_000), 8000)
    assert.equal(outputTokensWithin(request, 205_024, 64_000), 8000)
    assert.equal(outputTokensWithin(request, 1_000_000, 8000), 8000)
    assert.equal(outputTokensWithin(request, 4000, 8000), 0)
  })

  test('estimates the visible output of an interrupted response', ({ assert }) => {
    assert.equal(
      visibleOutputTokens([
        { type: 'text', text: 'x'.repeat(30), citations: null },
        { type: 'thinking', thinking: 'y'.repeat(9), signature: '' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'a' } },
      ]),
      // 30 + 9 + 12 caractères (`{"path":"a"}`) ÷ 3.
      17,
    )
  })
})

test.group('claude: settings and rate limit', () => {
  test('sets an explicit effort and a bounded output for every operation', ({ assert }) => {
    for (const settings of Object.values(OPERATION_SETTINGS)) {
      assert.oneOf(settings.effort, ['low', 'medium', 'high', 'xhigh', 'max'])
      assert.isAtMost(settings.maxTokens, 128_000)
      assert.isAtMost(settings.expectedOutputTokens, settings.maxTokens)
    }
    assert.equal(OPERATION_SETTINGS.assistant.effort, 'medium')
  })

  test('allows a burst, then asks to wait until the window slides', ({ assert }) => {
    let now = 1_000_000
    const limiter = new AiRateLimiter({ requests: 3, windowSeconds: 60, concurrent: 10 }, () => now)
    for (let index = 0; index < 3; index++) limiter.acquire('ada')()
    const refused = (() => {
      try {
        limiter.acquire('ada')
        return null
      } catch (error) {
        return error as { retryAfterSeconds: number; code: string }
      }
    })()
    assert.equal(refused?.code, 'E_AI_RATE_LIMITED')
    assert.equal(refused?.retryAfterSeconds, 60)
    // Un autre compte n'est pas concerné ; la fenêtre glisse.
    limiter.acquire('grace')()
    now += 60_001
    limiter.acquire('ada')()
  })

  test('caps the calls running at once for a user', ({ assert }) => {
    const limiter = new AiRateLimiter({ requests: 100, windowSeconds: 60, concurrent: 2 })
    const first = limiter.acquire('ada')
    limiter.acquire('ada')
    assert.throws(() => limiter.acquire('ada'))
    first()
    // Libérer deux fois ne rend pas deux places.
    first()
    limiter.acquire('ada')
    assert.throws(() => limiter.acquire('ada'))
  })
})
