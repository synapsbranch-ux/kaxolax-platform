import { describe, expect, it } from 'vitest'
import {
  adminAuditEntrySchema,
  adminStatsSchema,
  createBannerInputSchema,
  updateBannerInputSchema,
} from './admin.js'

const id = '0b9f8d3e-5a4c-4b1e-9f2a-3c4d5e6f7a8b'

describe('admin contracts', () => {
  it('requires a banner to end after it starts', () => {
    const banner = { message: 'Maintenance ce soir', level: 'maintenance' }
    expect(createBannerInputSchema.safeParse(banner).success).toBe(true)
    expect(
      createBannerInputSchema.safeParse({
        ...banner,
        startsAt: '2026-10-01T20:00:00+02:00',
        endsAt: '2026-10-01T19:00:00Z',
      }).success,
    ).toBe(true)
    const backwards = createBannerInputSchema.safeParse({
      ...banner,
      startsAt: '2026-10-01T20:00:00Z',
      endsAt: '2026-10-01T20:00:00Z',
    })
    expect(backwards.success).toBe(false)
    expect(backwards.error?.issues[0]?.path).toEqual(['endsAt'])
    expect(createBannerInputSchema.safeParse({ ...banner, endsAt: null }).success).toBe(true)
  })

  it('rejects an empty or unknown banner', () => {
    expect(createBannerInputSchema.safeParse({ message: '  ', level: 'info' }).success).toBe(false)
    expect(createBannerInputSchema.safeParse({ message: 'x', level: 'danger' }).success).toBe(false)
    expect(
      createBannerInputSchema.safeParse({ message: 'x'.repeat(501), level: 'info' }).success,
    ).toBe(false)
    // Une modification partielle ne compare que les dates fournies ensemble.
    expect(updateBannerInputSchema.safeParse({ endsAt: '2026-10-01T20:00:00Z' }).success).toBe(true)
  })

  it('accepts an audit entry and refuses an unknown action', () => {
    const entry = {
      id,
      admin: { id, email: 'admin@example.com', fullName: null },
      action: 'user.ban',
      targetType: 'user',
      targetId: id,
      outcome: 'success',
      metadata: { reason: 'spam' },
      createdAt: '2026-10-01T12:00:00.000Z',
    }
    expect(adminAuditEntrySchema.parse(entry)).toEqual(entry)
    expect(adminAuditEntrySchema.safeParse({ ...entry, action: 'user.promote' }).success).toBe(
      false,
    )
  })

  it('requires every compile status in the statistics', () => {
    const stats = {
      period: { from: '2026-09-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z' },
      signups: { total: 1, byDay: [{ date: '2026-09-01', count: 1 }] },
      activeUsers: { last7Days: 1, last30Days: 1 },
      subscriptions: { pro: 0, byPlan: [] },
      compiles: {
        total: 0,
        byStatus: { success: 0, failure: 0, timeout: 0, error: 0 },
        averageDurationMs: null,
        failureRate: null,
        byAgent: [],
      },
    }
    expect(adminStatsSchema.parse(stats)).toEqual(stats)
    const missing = { ...stats, compiles: { ...stats.compiles, byStatus: { success: 0 } } }
    expect(adminStatsSchema.safeParse(missing).success).toBe(false)
  })
})
