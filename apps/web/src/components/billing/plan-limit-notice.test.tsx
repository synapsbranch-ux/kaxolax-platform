import type { PlanLimitError } from '@kaxolax/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, ApiError, setTokenGetter } from '@/lib/api'
import {
  formatBytes,
  formatSeconds,
  markPlanLimitHandled,
  onPlanLimit,
  planLimitMessage,
  planLimitOf,
  reportRealtimePlanLimit,
} from '@/lib/plan-limits'
import { PlanLimitNotice } from './plan-limit-notice'

const storage: PlanLimitError = {
  code: 'E_PLAN_LIMIT',
  message: 'The storage limit of the project owner plan is reached',
  limit: { name: 'storage', plan: 'free', max: 500 * 1024 * 1024 },
  feature: 'extra_storage',
  current: 524_288_000,
  upgradeUrl: 'http://localhost:3000/pricing',
}

describe('plan limits', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('formats sizes and durations in French', () => {
    expect(formatBytes(500 * 1024 * 1024)).toBe('500 Mo')
    expect(formatBytes(1.5 * 1024 ** 3)).toBe('1,5 Go')
    expect(formatBytes(12)).toBe('12 octets')
    expect(formatSeconds(20)).toBe('20 s')
    expect(formatSeconds(240)).toBe('4 min')
  })

  it('explains each limit with its value', () => {
    expect(planLimitMessage(storage).description).toContain('500 Mo')
    const compile = planLimitMessage({
      ...storage,
      limit: { name: 'compile_time', plan: 'free', max: 20 },
      feature: 'long_compile',
    })
    expect(compile.title).toBe('Durée de compilation dépassée')
    expect(compile.description).toContain('20 s')
    const collaborators = planLimitMessage({
      ...storage,
      limit: { name: 'collaborators', plan: 'free', max: 1 },
      feature: 'unlimited_collaborators',
    })
    expect(collaborators.description).toContain('1 collaborateur ')
  })

  it('recognizes an E_PLAN_LIMIT body only', () => {
    expect(planLimitOf(storage)).toEqual(storage)
    expect(planLimitOf({ code: 'E_PLAN_LIMIT', message: 'x' })).toBeNull()
    expect(planLimitOf(null)).toBeNull()
  })

  it('renders the limit and a button to the pricing page', () => {
    const html = renderToStaticMarkup(<PlanLimitNotice error={storage} />)
    expect(html).toContain('Espace de stockage plein')
    expect(html).toContain('500 Mo')
    expect(html).toContain('href="http://localhost:3000/pricing"')
    expect(html).toContain('Voir les plans')
    expect(html).toContain('data-limit="storage"')
    expect(renderToStaticMarkup(<PlanLimitNotice error={storage} compact />)).not.toContain(
      'Espace de stockage plein',
    )
  })

  it('reports a refusal from the API unless the caller shows it', async () => {
    setTokenGetter(() => Promise.resolve('token'))
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response(JSON.stringify(storage), { status: 403 }))),
    )
    const reported: boolean[] = []
    const stop = onPlanLimit((_error, handled) => {
      // Lu après le `catch` de l'appelant, comme la boîte de dialogue globale.
      setTimeout(() => reported.push(handled()), 0)
    })

    const shown = await api.createDocument('p1', 'a.tex', null).catch((error: unknown) => error)
    expect(shown).toBeInstanceOf(ApiError)
    expect((shown as ApiError).planLimit).toEqual(storage)
    const inline = await api.createDocument('p1', 'b.tex', null).catch((error: unknown) => {
      markPlanLimitHandled(error)
      return error
    })
    expect((inline as ApiError).status).toBe(403)
    await new Promise((resolve) => setTimeout(resolve, 5))
    stop()
    expect(reported).toEqual([false, true])
  })

  it('reports a full storage pushed by the realtime service, and only that', () => {
    const reported: PlanLimitError[] = []
    const stop = onPlanLimit((error) => reported.push(error))
    const full = { type: 'plan.storage', full: true, plan: 'free', max: 100, current: 120 }
    expect(reportRealtimePlanLimit(JSON.stringify({ ...full, full: false }))).toBeNull()
    expect(reportRealtimePlanLimit('{"type":"member.role-changed"}')).toBeNull()
    expect(reportRealtimePlanLimit('not json')).toBeNull()
    const error = reportRealtimePlanLimit(JSON.stringify(full))
    stop()
    expect(error?.limit).toEqual({ name: 'storage', plan: 'free', max: 100 })
    expect(planLimitOf(error)).toEqual(error)
    expect(reported).toEqual([error])
  })
})
