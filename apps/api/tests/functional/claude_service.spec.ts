import { aiHealthResponseSchema } from '@kaxolax/contracts'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { PlanLimitException } from '#exceptions/plan_limit'
import AiUsage from '#models/ai_usage'
import type Project from '#models/project'
import User from '#models/user'
import { creditPeriod } from '#services/ai_credits'
import { estimateCostMicros, worstCaseCostMicros } from '#services/claude/pricing'
import ClaudeService, { type ClaudeRequest } from '#services/claude/claude_service'
import {
  AiCancelledException,
  AiDisabledException,
  AiOverloadedException,
  AiRefusedException,
  AiTruncatedException,
  AiUnavailableException,
  AiUpstreamException,
} from '#services/claude/errors'
import { createProject } from '#services/project_service'
import { adminFakes, createAdmin, useAdminFakes } from '#tests/admin'
import { FakeAnthropicApi, type FakeMessage, useFakeClaude } from '#tests/claude'
import { createUser } from '#tests/helpers'

let api: FakeAnthropicApi

const answer: FakeMessage = {
  content: [
    { type: 'thinking', thinking: '', signature: 'c2lnbmF0dXJl' },
    { type: 'text', text: 'Bonjour' },
  ],
  stop_reason: 'end_turn',
  usage: {
    input_tokens: 1000,
    output_tokens: 500,
    cache_read_input_tokens: 2000,
    cache_creation_input_tokens: 100,
  },
}

const readFile: NonNullable<ClaudeRequest['tools']>[number] = {
  name: 'read_file',
  description: 'Read a file of the project',
  input_schema: {
    type: 'object',
    properties: { path: { type: 'string' } },
    required: ['path'],
    additionalProperties: false,
  },
}

async function service(): Promise<ClaudeService> {
  return app.container.make(ClaudeService)
}

async function setup(): Promise<{ user: User; project: Project; claude: ClaudeService }> {
  const user = await createUser()
  const project = await createProject(user, 'AI')
  return { user, project, claude: await service() }
}

function request(user: User, project: Project, overrides: Partial<ClaudeRequest> = {}) {
  return {
    user,
    project,
    operation: 'quick_action',
    system: 'Tu es un assistant LaTeX.',
    messages: [{ role: 'user', content: 'Reformule : « le chat est sur le tapis ».' }],
    ...overrides,
  } satisfies ClaudeRequest
}

async function usedMicros(user: User): Promise<number> {
  const row = (await db
    .from('ai_credit_periods')
    .where({ user_id: user.id, period_start: creditPeriod().key })
    .first()) as { ai_used_micros: string } | null
  return Number(row?.ai_used_micros ?? 0)
}

async function reservations(user: User): Promise<number> {
  const rows = await db.from('ai_credit_reservations').where('user_id', user.id)
  return rows.length
}

test.group('claude service: requests and usage', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    api = new FakeAnthropicApi()
    return useFakeClaude(api)
  })

  test('sends the rules of the API and records the usage and the cost', async ({ assert }) => {
    const { user, project, claude } = await setup()
    api.reply(answer)
    const events: string[] = []
    const result = await claude.run(
      request(user, project, {
        tools: [readFile],
        aiMessageId: null,
        onEvent: (event) => events.push(event.type),
      }),
    )

    assert.equal(result.text, 'Bonjour')
    assert.equal(result.stopReason, 'end_turn')
    assert.isFalse(result.truncated)
    assert.isFalse(result.fallbackUsed)
    // Bloc `thinking` gardé tel quel, signature comprise (à renvoyer au tour suivant).
    assert.deepInclude(result.message.content[0], {
      type: 'thinking',
      signature: 'c2lnbmF0dXJl',
    })
    assert.includeMembers(events, ['message_start', 'content_block_delta', 'message_stop'])

    const [sent] = api.messageRequests
    const body = sent?.body ?? {}
    assert.equal(body.model, 'claude-opus-5-5')
    assert.isTrue(body.stream)
    assert.equal(body.max_tokens, 8000)
    assert.deepEqual(body.thinking, { type: 'adaptive' })
    assert.deepEqual(body.output_config, { effort: 'low' })
    assert.equal(body.fallbacks, 'default')
    assert.include(sent?.headers.get('anthropic-beta') ?? '', 'server-side-fallback-2026-07-01')
    // Préfixe figé mis en cache, puis cache automatique de la fin de conversation.
    assert.deepEqual(body.system, [
      { type: 'text', text: 'Tu es un assistant LaTeX.', cache_control: { type: 'ephemeral' } },
    ])
    assert.deepEqual(body.cache_control, { type: 'ephemeral' })
    assert.deepEqual(body.tool_choice, { type: 'auto' })
    const [tool] = body.tools as Record<string, unknown>[]
    assert.include(tool, { name: 'read_file', strict: true, eager_input_streaming: true })
    assert.deepEqual(body.metadata, { user_id: user.id })
    for (const forbidden of ['temperature', 'top_p', 'top_k']) assert.notProperty(body, forbidden)
    assert.equal(sent?.headers.get('x-api-key'), 'test-anthropic-key')

    // 1000 × 4 + 500 × 20 + 2000 × 0,2 + 100 × 5 micro-dollars.
    assert.equal(result.costMicros, 14_900)
    const usage = await AiUsage.findOrFail(String(result.usageId))
    assert.include(usage.$attributes, {
      userId: user.id,
      projectId: project.id,
      workspaceId: project.workspaceId,
      operation: 'quick_action',
      creditKind: 'ai',
      model: 'claude-opus-5-5',
      inputTokens: 1000,
      outputTokens: 500,
      cacheReadInputTokens: 2000,
      cacheCreationInputTokens: 100,
      costMicros: 14_900,
      stopReason: 'end_turn',
      requestId: 'req_test_1',
    })
    // Crédits réglés au coût réel, réservation disparue.
    assert.equal(await usedMicros(user), 14_900)
    assert.equal(await reservations(user), 0)
  })

  test('prices each attempt of a server-side fallback at its own model', async ({ assert }) => {
    const { user, project, claude } = await setup()
    api.reply({
      model: 'claude-opus-5',
      content: [
        {
          type: 'fallback',
          from: { model: 'claude-opus-5-5' },
          to: { model: 'claude-opus-5' },
          trigger: { type: 'refusal', category: 'cyber' },
        },
        { type: 'text', text: 'Réponse du modèle de repli' },
      ],
      stop_reason: 'end_turn',
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        iterations: [
          {
            type: 'message',
            model: 'claude-opus-5-5',
            input_tokens: 100,
            output_tokens: 0,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null,
          },
          {
            type: 'fallback_message',
            model: 'claude-opus-5',
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
            cache_creation: null,
          },
        ],
      },
    })
    const result = await claude.run(request(user, project))
    assert.isTrue(result.fallbackUsed)
    assert.equal(result.model, 'claude-opus-5')
    assert.equal(result.text, 'Réponse du modèle de repli')
    // 100 × 4 (Opus 5.5, refusé) + 100 × 5 + 50 × 25 (Opus 5).
    assert.equal(result.costMicros, 2150)
    assert.equal((await AiUsage.findOrFail(String(result.usageId))).model, 'claude-opus-5')
    assert.equal(result.message.content[0]?.type, 'fallback')
  })

  test('checks the stop reason: refusal and max_tokens', async ({ assert }) => {
    const { user, project, claude } = await setup()
    api.reply({
      content: [],
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: 'cyber', explanation: null },
      usage: { input_tokens: 10, output_tokens: 0 },
    })
    const refused = await claude.run(request(user, project)).catch((error: unknown) => error)
    assert.instanceOf(refused, AiRefusedException)
    assert.equal((refused as AiRefusedException).category, 'cyber')
    // Le refus est mesuré : l'entrée a été envoyée.
    const refusal = await AiUsage.query().where('userId', user.id).firstOrFail()
    assert.equal(refusal.stopReason, 'refusal')
    assert.equal(refusal.costMicros, 40)

    const cut: FakeMessage = {
      content: [{ type: 'text', text: 'Début de réponse' }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 8000 },
    }
    api.reply(cut)
    await assert.rejects(() => claude.run(request(user, project)), AiTruncatedException)
    api.reply(cut)
    const accepted = await claude.run(request(user, project, { acceptTruncated: true }))
    assert.isTrue(accepted.truncated)
    assert.equal(accepted.text, 'Début de réponse')
    // Entrée d'outil coupée : jamais rendue, même si la troncature est acceptée.
    api.reply({
      content: [{ type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'ma' } }],
      stop_reason: 'max_tokens',
      usage: { input_tokens: 10, output_tokens: 8000 },
    })
    await assert.rejects(
      () => claude.run(request(user, project, { tools: [readFile], acceptTruncated: true })),
      AiTruncatedException,
    )
    assert.lengthOf(await AiUsage.query().where('userId', user.id), 4)
  })

  test('lets the SDK retry 429 and 529, then reports an overloaded service', async ({ assert }) => {
    const { user, project, claude } = await setup()
    api.fail(429, 'rate_limit_error').fail(529, 'overloaded_error').reply(answer)
    const result = await claude.run(request(user, project))
    assert.equal(result.text, 'Bonjour')
    assert.lengthOf(api.messageRequests, 3)
    assert.lengthOf(await AiUsage.query().where('userId', user.id), 1)

    api.fail(529, 'overloaded_error').fail(529, 'overloaded_error').fail(529, 'overloaded_error')
    await assert.rejects(() => claude.run(request(user, project)), AiOverloadedException)
    assert.lengthOf(api.messageRequests, 6)
    api.fail(429, 'rate_limit_error').fail(429, 'rate_limit_error').fail(429, 'rate_limit_error')
    await assert.rejects(() => claude.run(request(user, project)), AiOverloadedException)
    // Aucun usage pour un appel sans réponse ; réservations libérées.
    assert.lengthOf(await AiUsage.query().where('userId', user.id), 1)
    assert.equal(await reservations(user), 0)
    assert.equal(await usedMicros(user), result.costMicros)
  })

  test('maps the other errors of the SDK without retrying client errors', async ({ assert }) => {
    const { user, project, claude } = await setup()
    api.fail(400, 'invalid_request_error')
    await assert.rejects(() => claude.run(request(user, project)), AiUpstreamException)
    assert.lengthOf(api.messageRequests, 1)
    api.fail(401, 'authentication_error')
    await assert.rejects(() => claude.run(request(user, project)), AiUnavailableException)
    assert.lengthOf(api.messageRequests, 2)

    // Erreur en cours de flux : le début reçu est compté, le crédit réglé.
    api.failMidStream(answer, 'overloaded_error')
    await assert.rejects(() => claude.run(request(user, project)), AiOverloadedException)
    const partial = await AiUsage.query().where('userId', user.id).firstOrFail()
    assert.equal(partial.stopReason, 'error')
    assert.equal(partial.inputTokens, 1000)
    assert.equal(await usedMicros(user), partial.costMicros)
    assert.equal(await reservations(user), 0)

    // Client parti : appel interrompu.
    const controller = new AbortController()
    controller.abort()
    api.reply(answer)
    await assert.rejects(
      () => claude.run(request(user, project, { signal: controller.signal })),
      AiCancelledException,
    )
  })

  test('refuses before any request: not configured, disabled, out of credits', async ({
    assert,
  }) => {
    const { user, project } = await setup()
    const restore = useFakeClaude(null)
    try {
      await assert.rejects(
        async () => (await service()).run(request(user, project)),
        AiUnavailableException,
      )
    } finally {
      restore()
      useFakeClaude(api)
    }
    const claude = await service()

    project.aiEnabled = false
    await project.save()
    const projectOff = await claude.run(request(user, project)).catch((error: unknown) => error)
    assert.instanceOf(projectOff, AiDisabledException)
    assert.equal((projectOff as AiDisabledException).scope, 'project')
    project.aiEnabled = true
    await project.save()
    await db.from('workspaces').where('id', project.workspaceId).update({ ai_enabled: false })
    const workspaceOff = await claude.run(request(user, project)).catch((error: unknown) => error)
    assert.equal((workspaceOff as AiDisabledException).scope, 'workspace')
    await db.from('workspaces').where('id', project.workspaceId).update({ ai_enabled: true })

    // Crédits Free (100 crédits = 1 000 000 µ$) épuisés.
    await db.table('ai_credit_periods').insert({
      user_id: user.id,
      period_start: creditPeriod().key,
      ai_used_micros: 1_000_000,
    })
    const outOfCredits = await claude.run(request(user, project)).catch((error: unknown) => error)
    assert.instanceOf(outOfCredits, PlanLimitException)
    assert.deepInclude((outOfCredits as PlanLimitException).details, {
      name: 'ai_credits',
      plan: 'free',
      max: 100,
      current: 100,
    })
    // Préremplissage de la réponse : refusé avant tout envoi.
    await assert.rejects(
      () =>
        claude.run(
          request(user, project, {
            messages: [
              { role: 'user', content: 'Traduis.' },
              { role: 'assistant', content: 'Voici' },
            ],
          }),
        ),
      /must end with a user turn/,
    )
    assert.lengthOf(api.messageRequests, 0)
  })

  test('charges at least the expected cost of a response cut before its end', async ({
    assert,
  }) => {
    const { user, project, claude } = await setup()
    // Le flux s'arrête avant `message_delta` : l'usage reçu ne compte qu'un token de sortie.
    api.failMidStream(
      { ...answer, usage: { input_tokens: 10, output_tokens: 6000 } },
      'overloaded_error',
    )
    await assert.rejects(() => claude.run(request(user, project)), AiOverloadedException)
    const row = await AiUsage.query().where('userId', user.id).firstOrFail()
    // Plancher : entrée estimée et sortie attendue de l'opération (1 500 tokens), dans la
    // réservation (bien au-dessus des 10 × 4 + 3 × 20 µ$ de l'usage partiel).
    const floor = estimateCostMicros(
      'claude-opus-5-5',
      claude.buildParams(request(user, project)),
      1500,
    )
    assert.isAbove(floor, 30_000)
    assert.equal(row.costMicros, floor)
    assert.equal(await usedMicros(user), floor)
    assert.equal(await reservations(user), 0)
  })

  test('counts the visible output of a long response cut before its end', async ({ assert }) => {
    const { user, project, claude } = await setup()
    api.failMidStream(
      {
        content: [{ type: 'text', text: 'x'.repeat(30_000) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 10, output_tokens: 1 },
      },
      'overloaded_error',
    )
    await assert.rejects(() => claude.run(request(user, project)), AiOverloadedException)
    const row = await AiUsage.query().where('userId', user.id).firstOrFail()
    // 30 000 caractères reçus ≈ 10 000 tokens de sortie, bornés au `max_tokens` envoyé.
    assert.equal(row.outputTokens, 8000)
    assert.equal(row.costMicros, 10 * 4 + 8000 * 20)
    assert.equal(await usedMicros(user), row.costMicros)
  })

  test('returns the response and settles the credits when ai_usage cannot be written', async ({
    assert,
  }) => {
    const { user, project, claude } = await setup()
    api.reply(answer)
    // Message inexistant : la clé étrangère de ai_usage fait échouer l'écriture.
    const result = await claude.run(
      request(user, project, { aiMessageId: '00000000-0000-4000-8000-000000000000' }),
    )
    assert.equal(result.text, 'Bonjour')
    assert.isNull(result.usageId)
    assert.lengthOf(await AiUsage.query().where('userId', user.id), 0)
    assert.equal(await usedMicros(user), 14_900)
    assert.equal(await reservations(user), 0)
  })

  test('reserves the worst case and lowers max_tokens to the credits left', async ({ assert }) => {
    const { user, project, claude } = await setup()
    // 30 crédits restants sur 100 : moins que le pire cas de `markdown_cleanup` (64 000 × 25 µ$).
    await db.table('ai_credit_periods').insert({
      user_id: user.id,
      period_start: creditPeriod().key,
      ai_used_micros: 700_000,
    })
    const cleanup = request(user, project, { operation: 'markdown_cleanup' })
    api.replyFullOutput({
      ...answer,
      model: 'claude-opus-5',
      usage: { input_tokens: 10, output_tokens: 0 },
    })
    const result = await claude.run(cleanup)
    const sent = Number(api.messageRequests[0]?.body?.max_tokens)
    const params = claude.buildParams(cleanup)
    assert.equal(params.max_tokens, 64_000)
    assert.isBelow(sent, 64_000)
    assert.isAtLeast(sent, 8000)
    assert.isAtMost(worstCaseCostMicros(params, sent), 300_000)
    // Sortie entière au prix du modèle de repli le plus cher : toujours dans le plan.
    assert.equal(result.costMicros, 10 * 5 + sent * 25)
    assert.isAtMost(await usedMicros(user), 1_000_000)

    // Solde inférieur au pire cas de la sortie attendue : refus avant tout envoi.
    const refused = await claude.run(cleanup).catch((error: unknown) => error)
    assert.instanceOf(refused, PlanLimitException)
    assert.lengthOf(api.messageRequests, 1)
  })

  test('limits the calls of a user (sliding window)', async ({ assert }) => {
    const { user, project, claude } = await setup()
    for (let index = 0; index < 20; index++) api.reply(answer)
    for (let index = 0; index < 20; index++) await claude.run(request(user, project))
    const limited = await claude.run(request(user, project)).catch((error: unknown) => error)
    assert.equal((limited as { code?: string }).code, 'E_AI_RATE_LIMITED')
    assert.lengthOf(api.messageRequests, 20)
  })

  test('reports the health of the AI to the admin without spending tokens', async ({ assert }) => {
    const claude = await service()
    const healthy = await claude.health()
    assert.include(healthy, { configured: true, model: 'claude-opus-5-5', ok: true, error: null })
    assert.deepEqual(
      api.requests.map((sent) => `${sent.method} ${sent.path}`),
      ['GET /v1/models/claude-opus-5-5'],
    )
    api.modelError = { status: 401, type: 'authentication_error' }
    assert.include(await claude.health(), { ok: false, error: 'E_AI_UNAVAILABLE' })

    const restore = useFakeClaude(null)
    try {
      assert.include(await (await service()).health(), {
        configured: false,
        ok: false,
        latencyMs: null,
        error: 'E_AI_UNAVAILABLE',
      })
    } finally {
      restore()
    }
  })
})

test.group('claude service: admin health route', (group) => {
  useAdminFakes(group)
  group.each.setup(() => useFakeClaude(new FakeAnthropicApi()))

  test('GET /admin/ai/health answers the admins only', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const response = await client
      .get('/api/v1/admin/ai/health')
      .header('authorization', `Bearer ${token}`)
    response.assertStatus(200)
    assert.include(aiHealthResponseSchema.parse(response.body()), { ok: true, configured: true })
    const user = await createUser()
    ;(await client.get('/api/v1/admin/ai/health').loginAs(user)).assertStatus(403)
  })
})

/**
 * Appels simultanés réels : sans transaction globale (chaque réservation a sa propre connexion),
 * les données du test sont supprimées à la fin.
 */
test.group('claude service: simultaneous calls', (group) => {
  let created: User[] = []
  group.each.setup(() => {
    api = new FakeAnthropicApi()
    return useFakeClaude(api)
  })
  group.each.teardown(async () => {
    await User.query()
      .whereIn(
        'id',
        created.map((user) => user.id),
      )
      .delete()
    created = []
  })

  test('never exceeds the plan, even when each call uses its whole max_tokens', async ({
    assert,
  }) => {
    const user = await createUser()
    created.push(user)
    const claude = await service()
    // 30 crédits restants (300 000 µ$) ; `quick_action` : pire cas 8 000 × 25 µ$ plus l'entrée.
    await db.table('ai_credit_periods').insert({
      user_id: user.id,
      period_start: creditPeriod().key,
      ai_used_micros: 700_000,
    })
    let open: () => void = () => undefined
    api.gate = new Promise((resolve) => {
      open = resolve
    })
    const full: FakeMessage = {
      ...answer,
      model: 'claude-opus-5',
      usage: { input_tokens: 10, output_tokens: 0 },
    }
    api.replyFullOutput(full).replyFullOutput(full).replyFullOutput(full)
    const settled = Promise.allSettled(
      Array.from({ length: 3 }, () =>
        claude.run({
          user,
          operation: 'quick_action',
          system: 'Tu es un assistant LaTeX.',
          messages: [{ role: 'user', content: 'Reformule : « le chat est sur le tapis ».' }],
        }),
      ),
    )
    // Les trois réservations ont lieu pendant que les réponses sont retenues.
    for (let wait = 0; wait < 300 && api.messageRequests.length < 2; wait++) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    open()
    const outcomes = await settled
    const done = outcomes.flatMap((outcome) =>
      outcome.status === 'fulfilled' ? [outcome.value] : [],
    )
    const refused = outcomes.filter(
      (outcome) => outcome.status === 'rejected' && outcome.reason instanceof PlanLimitException,
    )
    assert.lengthOf(done, 2)
    assert.lengthOf(refused, 1)
    const sent = api.messageRequests.map((sentRequest) => Number(sentRequest.body?.max_tokens))
    // Sortie réglée égale au `max_tokens` envoyé : le premier garde 8 000 tokens, le second le reste.
    assert.sameMembers(
      done.map((result) => result.usage.outputTokens),
      sent,
    )
    assert.include(sent, 8000)
    assert.isTrue(sent.some((maxTokens) => maxTokens < 8000))
    const used = await usedMicros(user)
    assert.equal(used, 700_000 + done.reduce((total, result) => total + result.costMicros, 0))
    assert.isAtMost(used, 1_000_000)
    assert.equal(await reservations(user), 0)
  })
})
