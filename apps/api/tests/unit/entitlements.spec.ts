import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { billingEventTime, mailsForTransition } from '#services/billing_webhooks'
import {
  effectiveLimits,
  type Entitlements,
  entitlementsFromClaims,
  featuresFromLimits,
  has,
  type PlanLimitRow,
  PlanLimitsCache,
  userScopedValues,
} from '#services/entitlements'

const FREE: PlanLimitRow = {
  planSlug: 'free',
  maxCompileSeconds: 20,
  maxCollaborators: 1,
  historyRetentionDays: 1,
  storageBytes: 500,
}
const PRO: PlanLimitRow = {
  planSlug: 'pro',
  maxCompileSeconds: 240,
  maxCollaborators: null,
  historyRetentionDays: null,
  storageBytes: 20_000,
}

function entitlements(plan: string, features: Entitlements['features'] = new Set()): Entitlements {
  return { plan, features, source: 'claims' }
}

test.group('entitlements: claims of the session token', () => {
  test('reads the user scoped values of pla and fea like Clerk', ({ assert }) => {
    assert.deepEqual(userScopedValues('u:pro'), ['pro'])
    assert.deepEqual(userScopedValues('o:team, u:long_compile,uo:full_history,ou:extra'), [
      'long_compile',
      'full_history',
      'extra',
    ])
    // Élément sans portée, portée inconnue, valeur vide, claim absent ou d'un autre type.
    assert.deepEqual(userScopedValues('pro,x:pro,u:'), [])
    assert.deepEqual(userScopedValues(undefined), [])
    assert.deepEqual(userScopedValues(['u:pro']), [])
  })

  test('builds the entitlements from pla and fea, null without a user plan', ({ assert }) => {
    const fromClaims = entitlementsFromClaims({
      pla: 'u:pro',
      fea: 'u:long_compile,u:full_history,u:unknown_feature,o:extra_storage',
    })
    assert.equal(fromClaims?.plan, 'pro')
    assert.equal(fromClaims?.source, 'claims')
    assert.deepEqual([...(fromClaims?.features ?? [])].sort(), ['full_history', 'long_compile'])
    assert.deepEqual([...(entitlementsFromClaims({ pla: 'u:free' })?.features ?? [])], [])
    // Pas de plan utilisateur : repli sur le miroir des webhooks.
    assert.isNull(entitlementsFromClaims({ fea: 'u:long_compile' }))
    assert.isNull(entitlementsFromClaims({ pla: 'o:team' }))
  })

  test('answers has({ plan }) and has({ feature }) with AND semantics', ({ assert }) => {
    const pro = entitlements('pro', new Set(['long_compile'] as const))
    assert.isTrue(has(pro, { plan: 'pro' }))
    assert.isTrue(has(pro, { feature: 'long_compile' }))
    assert.isTrue(has(pro, { plan: 'pro', feature: 'long_compile' }))
    assert.isFalse(has(pro, { plan: 'pro', feature: 'full_history' }))
    assert.isFalse(has(pro, { plan: 'free' }))
    assert.isFalse(has(pro, {}))
  })
})

test.group('entitlements: limits', () => {
  test('derives the features of a plan from its limits (fallback without claims)', ({ assert }) => {
    assert.deepEqual([...featuresFromLimits(PRO, FREE)].sort(), [
      'extra_storage',
      'full_history',
      'long_compile',
      'unlimited_collaborators',
    ])
    assert.deepEqual([...featuresFromLimits(FREE, FREE)], [])
    assert.deepEqual(
      [...featuresFromLimits({ ...FREE, maxCollaborators: 5 }, FREE)],
      ['unlimited_collaborators'],
    )
  })

  test('applies the plan values, and the free values for a missing feature', ({ assert }) => {
    const all = new Set([
      'long_compile',
      'unlimited_collaborators',
      'full_history',
      'extra_storage',
    ] as const)
    assert.deepInclude(effectiveLimits(entitlements('pro', all), PRO, FREE), {
      maxCompileSeconds: 240,
      maxCollaborators: null,
      historyRetentionDays: null,
      storageBytes: 20_000,
    })
    const partial = effectiveLimits(
      entitlements('pro', new Set(['long_compile'] as const)),
      PRO,
      FREE,
    )
    assert.deepInclude(partial, {
      maxCompileSeconds: 240,
      maxCollaborators: 1,
      historyRetentionDays: 1,
      storageBytes: 500,
    })
    // Une feature ne dépasse jamais les valeurs du plan.
    assert.deepInclude(effectiveLimits(entitlements('free', all), FREE, FREE), {
      maxCompileSeconds: 20,
      maxCollaborators: 1,
    })
  })

  test('caches plan_limits rows for a short time, missing rows included', async ({ assert }) => {
    let now = 1_000
    const cache = new PlanLimitsCache(60_000, () => now)
    const loads: string[] = []
    const load = (slug: string) => {
      loads.push(slug)
      return Promise.resolve(slug === 'pro' ? { ...PRO, maxCompileSeconds: loads.length } : null)
    }
    assert.equal((await cache.get('pro', load))?.maxCompileSeconds, 1)
    assert.isNull(await cache.get('team', load))
    now += 59_999
    assert.equal((await cache.get('pro', load))?.maxCompileSeconds, 1)
    assert.isNull(await cache.get('team', load))
    assert.deepEqual(loads, ['pro', 'team'])
    // Expiré : relu.
    now += 1
    assert.equal((await cache.get('pro', load))?.maxCompileSeconds, 3)
    cache.clear()
    assert.equal((await cache.get('pro', load))?.maxCompileSeconds, 4)
  })
})

test.group('billing webhooks: helpers', () => {
  test('sends one email per transition', ({ assert }) => {
    assert.deepEqual(mailsForTransition(null, 'active', true), ['proWelcome'])
    assert.deepEqual(mailsForTransition('upcoming', 'active', true), ['proWelcome'])
    assert.deepEqual(mailsForTransition('incomplete', 'active', true), ['proWelcome'])
    // Plan gratuit, même statut, reprise après un retard de paiement ou une résiliation.
    assert.deepEqual(mailsForTransition(null, 'active', false), [])
    assert.deepEqual(mailsForTransition('active', 'active', true), [])
    assert.deepEqual(mailsForTransition('past_due', 'active', true), [])
    assert.deepEqual(mailsForTransition('canceled', 'active', true), [])
    assert.deepEqual(mailsForTransition('active', 'past_due', true), ['paymentPastDue'])
    assert.deepEqual(mailsForTransition('past_due', 'past_due', true), [])
    assert.deepEqual(mailsForTransition('active', 'canceled', true), [])
  })

  test('dates an event by its envelope timestamp, then by the object', ({ assert }) => {
    const at = Date.UTC(2026, 9, 1, 12)
    assert.equal(billingEventTime({ timestamp: at, data: {} }).toMillis(), at)
    assert.equal(billingEventTime({ data: { updated_at: at } }).toMillis(), at)
    const before = DateTime.utc().toMillis()
    assert.isAtLeast(billingEventTime({ data: null }).toMillis(), before)
  })
})
