import { describe, expect, it } from 'vitest'
import {
  mePlanResponseSchema,
  PLAN_FEATURES,
  PLAN_LIMIT_FEATURES,
  planLimitErrorSchema,
  storageStateMessageSchema,
} from './billing.js'
import { compileResultSchema } from './compile.js'

const refusal = {
  code: 'E_PLAN_LIMIT',
  message: 'Collaborator limit reached',
  limit: { name: 'collaborators', plan: 'free', max: 1 },
  feature: 'unlimited_collaborators',
  upgradeUrl: 'http://localhost:3000/pricing',
}

describe('billing contracts', () => {
  it('carries the limit, the feature and the pricing link in a plan limit refusal', () => {
    expect(planLimitErrorSchema.parse(refusal)).toEqual(refusal)
    const withUsage = { ...refusal, limit: { ...refusal.limit, name: 'storage' }, current: 42 }
    expect(planLimitErrorSchema.parse(withUsage)).toEqual(withUsage)
    expect(planLimitErrorSchema.safeParse({ ...refusal, limit: undefined }).success).toBe(false)
    expect(planLimitErrorSchema.safeParse({ ...refusal, feature: 'unknown' }).success).toBe(false)
    expect(planLimitErrorSchema.safeParse({ ...refusal, upgradeUrl: '/pricing' }).success).toBe(
      false,
    )
  })

  it('lifts each limit with exactly one feature', () => {
    expect(new Set(Object.values(PLAN_LIMIT_FEATURES))).toEqual(new Set(PLAN_FEATURES))
  })

  it('describes the plan of the signed-in account', () => {
    const plan = {
      plan: 'pro',
      source: 'claims',
      features: ['long_compile', 'full_history'],
      limits: {
        maxCompileSeconds: 240,
        maxCollaborators: null,
        historyRetentionDays: null,
        storageBytes: 1024,
      },
      usage: { storageBytes: 12, maxCollaboratorsInProject: 3 },
      subscription: { status: 'active', periodEnd: '2026-11-01T00:00:00.000Z' },
      upgradeUrl: 'http://localhost:3000/pricing',
    }
    expect(mePlanResponseSchema.parse(plan)).toEqual(plan)
    expect(mePlanResponseSchema.safeParse({ ...plan, source: 'cookie' }).success).toBe(false)
  })

  it('accepts a compile result that points to the compile time limit', () => {
    const result = {
      buildId: '0b9f8d3e-5a4c-4b1e-9f2a-3c4d5e6f7a8b',
      status: 'timeout',
      durationMs: 20_000,
      pdfUrl: null,
      logUrl: null,
      entries: [],
      planLimit: {
        ...refusal,
        limit: { name: 'compile_time', plan: 'free', max: 20 },
        feature: 'long_compile',
      },
    }
    expect(compileResultSchema.parse(result)).toEqual(result)
  })

  it('describes the storage state pushed by the realtime service', () => {
    const message = { type: 'plan.storage', full: true, plan: 'free', max: 100, current: 120 }
    expect(storageStateMessageSchema.parse(message)).toEqual(message)
    expect(storageStateMessageSchema.safeParse({ ...message, current: -1 }).success).toBe(false)
  })
})
