import { randomUUID } from 'node:crypto'
import { mePlanResponseSchema, planLimitErrorSchema } from '@kaxolax/contracts'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { PlanLimitException, planLimitBody } from '#exceptions/plan_limit'
import aiConfig from '#config/ai'
import Subscription from '#models/subscription'
import User from '#models/user'
import {
  creditPeriod,
  creditsSummary,
  releaseCredits,
  renewCredits,
  reserveCredits,
  settleCredits,
} from '#services/ai_credits'
import { clerkTokenFor } from '#tests/clerk'
import { createUser } from '#tests/helpers'

const FREE_AI_MICROS = 100 * 10_000

async function periodRow(user: User, key = creditPeriod().key) {
  return (await db
    .from('ai_credit_periods')
    .where({ user_id: user.id, period_start: key })
    .first()) as { ai_used_micros: string; image_used: number } | null
}

async function refusal(promise: Promise<unknown>): Promise<PlanLimitException> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  )
  if (!(error instanceof PlanLimitException)) throw new Error('Expected a plan limit refusal')
  return error
}

test.group('ai credits: reservation and settlement', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('reserves before the call, settles the real cost after', async ({ assert }) => {
    const user = await createUser()
    const reservation = await reserveCredits(user, 'ai', 50_000)
    assert.equal(reservation.periodStart, creditPeriod().key)
    assert.lengthOf(await db.from('ai_credit_reservations').where('user_id', user.id), 1)

    // Le coût réel peut dépasser l'estimation : il est compté en entier.
    await settleCredits(reservation, 72_345.2)
    assert.equal(Number((await periodRow(user))?.ai_used_micros), 72_346)
    assert.lengthOf(await db.from('ai_credit_reservations').where('user_id', user.id), 0)

    const released = await reserveCredits(user, 'ai', 10_000)
    await releaseCredits(released)
    assert.equal(Number((await periodRow(user))?.ai_used_micros), 72_346)
    assert.lengthOf(await db.from('ai_credit_reservations').where('user_id', user.id), 0)

    const image = await reserveCredits(user, 'image', 1)
    await settleCredits(image, 1)
    assert.equal((await periodRow(user))?.image_used, 1)
  })

  test('refuses beyond the monthly credits with E_PLAN_LIMIT (feature ai)', async ({ assert }) => {
    const user = await createUser()
    const first = await reserveCredits(user, 'ai', 600_000)
    // Réservations en cours comprises : 600 000 + 500 000 > 1 000 000.
    const error = await refusal(reserveCredits(user, 'ai', 500_000))
    assert.deepEqual(error.details, { name: 'ai_credits', plan: 'free', max: 100, current: 0 })
    const body = planLimitErrorSchema.parse(planLimitBody(error.details))
    assert.equal(body.feature, 'ai')
    assert.equal(body.message, 'The monthly AI credits of your plan are used up')

    await settleCredits(first, 999_999)
    // Il reste 1 micro-dollar : seule une réservation minuscule passe.
    const last = await reserveCredits(user, 'ai', 1)
    await settleCredits(last, 1)
    const exhausted = await refusal(reserveCredits(user, 'ai', 1))
    assert.equal(exhausted.details.current, 100)

    for (let index = 0; index < 5; index++) {
      await settleCredits(await reserveCredits(user, 'image', 1), 1)
    }
    const images = await refusal(reserveCredits(user, 'image', 1))
    assert.deepEqual(images.details, { name: 'image_credits', plan: 'free', max: 5, current: 5 })
    await assert.rejects(() => reserveCredits(user, 'ai', 0), RangeError)
  })

  test('charges the credits of the plan of the user who acts', async ({ assert }) => {
    const pro = await createUser()
    await Subscription.create({
      userId: pro.id,
      clerkSubscriptionItemId: `csi_${randomUUID()}`,
      planSlug: 'pro',
      status: 'active',
      periodEnd: DateTime.utc().plus({ days: 20 }),
    })
    // 1 500 crédits : refusé sur Free (100), accepté sur Pro (2 000).
    assert.equal((await reserveCredits(pro, 'ai', 15_000_000)).amount, 15_000_000)
    const free = await createUser()
    await refusal(reserveCredits(free, 'ai', 15_000_000))
  })

  test('starts again at zero each calendar month (UTC)', async ({ assert }) => {
    const user = await createUser()
    const september = DateTime.fromISO('2026-09-30T23:59:00Z')
    await settleCredits(await reserveCredits(user, 'ai', 1, { now: september }), FREE_AI_MICROS)
    await refusal(reserveCredits(user, 'ai', 1, { now: september }))

    const october = DateTime.fromISO('2026-10-01T00:00:00Z')
    const fresh = await reserveCredits(user, 'ai', FREE_AI_MICROS, { now: october })
    assert.equal(fresh.periodStart, '2026-10-01')
    const summary = await creditsSummary(user, { now: october })
    assert.deepEqual(summary.ai, { monthly: 100, used: 0, remaining: 100 })
    assert.equal(summary.periodStart, '2026-10-01T00:00:00.000Z')
    assert.equal(summary.resetsAt, '2026-11-01T00:00:00.000Z')
    const previous = await creditsSummary(user, { now: september })
    assert.deepEqual(previous.ai, { monthly: 100, used: 100, remaining: 0 })
  })

  test('forgets a reservation that was never settled once it expires', async ({ assert }) => {
    const user = await createUser()
    const now = DateTime.utc()
    await reserveCredits(user, 'ai', FREE_AI_MICROS, { now })
    await refusal(reserveCredits(user, 'ai', 1, { now: now.plus({ minutes: 39 }) }))
    // Après 40 min, la réservation abandonnée (processus arrêté) ne compte plus et est effacée.
    await reserveCredits(user, 'ai', FREE_AI_MICROS, { now: now.plus({ minutes: 41 }) })
    assert.lengthOf(await db.from('ai_credit_reservations').where('user_id', user.id), 1)
  })

  test('keeps the reservation of a call still running past its lifetime', async ({ assert }) => {
    const user = await createUser()
    const now = DateTime.utc()
    const running = await reserveCredits(user, 'ai', FREE_AI_MICROS, { now })
    // Prolongée par l'appel en cours (toutes les 5 min) : elle compte encore après 40 min.
    await renewCredits(running, { now: now.plus({ minutes: 35 }) })
    await refusal(reserveCredits(user, 'ai', 1, { now: now.plus({ minutes: 70 }) }))
    await reserveCredits(user, 'ai', 1, { now: now.plus({ minutes: 76 }) })
    // Durée de vie plus longue qu'un appel et ses nouvelles tentatives (délai de requête du SDK).
    assert.isAbove(
      aiConfig.reservationTtlSeconds * 1000,
      aiConfig.timeoutMs * (aiConfig.maxRetries + 1),
    )
    assert.isBelow(aiConfig.reservationRenewSeconds, aiConfig.reservationTtlSeconds)
  })

  test('reserves the balance left when a minimum is given', async ({ assert }) => {
    const user = await createUser()
    await settleCredits(await reserveCredits(user, 'ai', 1), 700_000)
    // Pire cas de 500 000 µ$, au moins 100 000 : réservation ramenée aux 300 000 restants.
    const first = await reserveCredits(user, 'ai', 500_000, { minimum: 100_000 })
    assert.equal(first.amount, 300_000)
    const error = await refusal(reserveCredits(user, 'ai', 500_000, { minimum: 1 }))
    assert.equal(error.details.current, 70)
    await releaseCredits(first)
    const whole = await reserveCredits(user, 'ai', 200_000, { minimum: 100_000 })
    assert.equal(whole.amount, 200_000)
    await assert.rejects(() => reserveCredits(user, 'ai', 10, { minimum: 20 }), RangeError)
  })

  test('GET /me/plan shows the credits used and left', async ({ client, assert }) => {
    const user = await createUser()
    await settleCredits(await reserveCredits(user, 'ai', 1), 123_401)
    await settleCredits(await reserveCredits(user, 'image', 1), 2)
    const response = await client
      .get('/api/v1/me/plan')
      .header('authorization', `Bearer ${clerkTokenFor(user)}`)
    response.assertStatus(200)
    const plan = mePlanResponseSchema.parse(response.body())
    // 123 401 µ$ = 12,3401 crédits : 12,35 consommés (arrondi supérieur), 87,65 restants.
    assert.deepEqual(plan.credits.ai, { monthly: 100, used: 12.35, remaining: 87.65 })
    assert.deepEqual(plan.credits.images, { monthly: 5, used: 2, remaining: 3 })
    assert.equal(plan.credits.periodStart, creditPeriod().start.toISO())
    // Les limites existantes ne changent pas de forme.
    assert.notProperty(plan.limits, 'aiCredits')

    const pro = clerkTokenFor(user, {
      pla: 'u:pro',
      fea: 'u:long_compile,u:unlimited_collaborators,u:full_history,u:extra_storage,u:ai',
    })
    const upgraded = await client.get('/api/v1/me/plan').header('authorization', `Bearer ${pro}`)
    const proPlan = mePlanResponseSchema.parse(upgraded.body())
    assert.deepEqual(proPlan.credits.images, { monthly: 100, used: 2, remaining: 98 })
    assert.equal(proPlan.credits.ai.monthly, 2000)
    // Pro sans la feature `ai` dans le jeton : crédits de Free.
    const withoutAi = clerkTokenFor(user, { pla: 'u:pro', fea: 'u:long_compile' })
    const clamped = await client
      .get('/api/v1/me/plan')
      .header('authorization', `Bearer ${withoutAi}`)
    assert.equal(mePlanResponseSchema.parse(clamped.body()).credits.ai.monthly, 100)
  })
})

/**
 * Concurrence réelle : sans transaction globale (chaque réservation a sa propre connexion), les
 * données du test sont supprimées à la fin.
 */
test.group('ai credits: concurrent reservations', (group) => {
  let created: User[] = []
  group.each.teardown(async () => {
    await User.query()
      .whereIn(
        'id',
        created.map((user) => user.id),
      )
      .delete()
    created = []
  })

  test('never reserves more than the monthly credits', async ({ assert }) => {
    const user = await createUser()
    created.push(user)
    const attempts = await Promise.allSettled(
      Array.from({ length: 10 }, () => reserveCredits(user, 'ai', 300_000)),
    )
    const accepted = attempts.flatMap((attempt) =>
      attempt.status === 'fulfilled' ? [attempt.value] : [],
    )
    const refused = attempts.filter(
      (attempt) => attempt.status === 'rejected' && attempt.reason instanceof PlanLimitException,
    )
    assert.lengthOf(accepted, 3)
    assert.lengthOf(refused, 7)

    // Règlements simultanés : aucune perte d'incrément.
    await Promise.all(accepted.map((reservation) => settleCredits(reservation, 100_000)))
    assert.equal(Number((await periodRow(user))?.ai_used_micros), 300_000)
  })
})
