import type { MePlanResponse, PlanFeature } from '@kaxolax/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { BILLING_URL, planUsageView, sessionPlan } from '@/lib/plan-usage'
import { PlanUsageCard } from './plan-usage'

const MIB = 1024 * 1024

const free: MePlanResponse = {
  plan: 'free',
  source: 'default',
  features: [],
  limits: {
    maxCompileSeconds: 20,
    maxCollaborators: 1,
    historyRetentionDays: 1,
    storageBytes: 500 * MIB,
  },
  usage: { storageBytes: 125 * MIB, maxCollaboratorsInProject: 1 },
  credits: {
    periodStart: '2026-10-01T00:00:00.000Z',
    resetsAt: '2026-11-01T00:00:00.000Z',
    ai: { monthly: 100, used: 12.5, remaining: 87.5 },
    images: { monthly: 5, used: 0, remaining: 5 },
  },
  subscription: null,
  upgradeUrl: 'http://localhost:3000/pricing',
}

const pro: MePlanResponse = {
  ...free,
  plan: 'pro',
  source: 'claims',
  features: ['long_compile', 'unlimited_collaborators', 'full_history', 'extra_storage'],
  limits: {
    maxCompileSeconds: 240,
    maxCollaborators: null,
    historyRetentionDays: null,
    storageBytes: 20 * 1024 * MIB,
  },
  subscription: { status: 'active', periodEnd: '2026-11-01T00:00:00.000Z' },
}

const none = (): boolean => false

describe('plan and usage', () => {
  it('describes the storage used, the limits and the subscription', () => {
    const view = planUsageView(free)
    expect(view.plan).toBe('Free')
    expect(view.rows).toEqual([
      { label: 'Stockage', value: '125 Mo sur 500 Mo', ratio: 0.25 },
      { label: 'Durée de compilation', value: '20 s au plus par compilation' },
      { label: 'Collaborateurs', value: '1 par projet (le plus grand de vos projets : 1)' },
      { label: 'Historique', value: '1 jour' },
      {
        label: 'Crédits IA',
        value: '12,5 sur 100, remis à zéro le 1 novembre 2026',
        ratio: 0.125,
      },
      { label: 'Images', value: '0 sur 5, remis à zéro le 1 novembre 2026', ratio: 0 },
    ])
    expect(view.subscription).toBeNull()
    expect(view.storageFull).toBe(false)

    const paid = planUsageView(pro)
    expect(paid.rows.map((row) => row.value)).toEqual([
      '125 Mo sur 20 Go',
      '4 min au plus par compilation',
      'Illimités (le plus grand de vos projets : 1)',
      'Complet',
      '12,5 sur 100, remis à zéro le 1 novembre 2026',
      '0 sur 5, remis à zéro le 1 novembre 2026',
    ])
    expect(paid.subscription).toBe('Abonnement actif, renouvelé le 1 novembre 2026')
    expect(
      planUsageView({ ...pro, subscription: { status: 'past_due', periodEnd: null } }).subscription,
    ).toContain('Paiement en retard')
  })

  it('caps the gauge and flags a full storage', () => {
    const full = planUsageView({ ...free, usage: { ...free.usage, storageBytes: 600 * MIB } })
    expect(full.rows[0]?.ratio).toBe(1)
    expect(full.storageFull).toBe(true)
  })

  it('shows the session plan from Clerk until the API answers', () => {
    expect(sessionPlan(true)).toBe('pro')
    expect(sessionPlan(false)).toBe('free')
    const html = renderToStaticMarkup(
      <PlanUsageCard plan={null} error={null} sessionPlanSlug="pro" hasFeature={none} />,
    )
    expect(html).toContain('>Pro<')
    expect(html).toContain('aria-busy')
    expect(html).toContain(`href="${BILLING_URL}"`)
    expect(html).toContain('Voir les plans')
  })

  it('renders the usage, the features and the links to pricing and billing', () => {
    const included = new Set<PlanFeature>(['long_compile'])
    const html = renderToStaticMarkup(
      <PlanUsageCard
        plan={free}
        error={null}
        sessionPlanSlug="free"
        hasFeature={(feature) => included.has(feature)}
      />,
    )
    expect(html).toContain('125 Mo sur 500 Mo')
    expect(html).toContain('aria-valuenow="25"')
    expect(html).toContain('Compilations longues')
    expect(html).toContain('data-included="true"')
    expect(html).toContain('href="http://localhost:3000/pricing"')
    expect(html).toContain('Passer à Pro')
    expect(html).toContain('href="/account/billing"')
  })

  it('reports an unavailable plan', () => {
    const html = renderToStaticMarkup(
      <PlanUsageCard plan={null} error="Erreur réseau" sessionPlanSlug="free" hasFeature={none} />,
    )
    expect(html).toContain('Plan et usage indisponibles : Erreur réseau')
  })
})
