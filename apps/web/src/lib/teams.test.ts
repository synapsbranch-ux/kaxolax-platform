import type { PlanLimitError, Workspace, WorkspacePlanResponse } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import { planLimitMessage } from './plan-limits'
import { USER_PRO_PLAN, userFeature } from './plan-usage'
import {
  dashboardUrl,
  moveTargets,
  seatsText,
  splitWorkspaces,
  TEAM_PLAN_REQUIRED_MESSAGE,
  teamAccessText,
  teamErrorMessage,
  teamOfProject,
  teamPlanView,
  teamUrl,
  workspaceLabel,
} from './teams'

const GIB = 1024 * 1024 * 1024

function workspace(overrides: Partial<Workspace> & Pick<Workspace, 'id' | 'name'>): Workspace {
  return {
    type: 'team',
    ownerId: '00000000-0000-4000-8000-000000000001',
    role: 'member',
    aiEnabled: true,
    clerkOrganizationId: `org_${overrides.id.slice(-4)}`,
    slug: null,
    memberCount: 2,
    createdAt: '2026-10-01T08:00:00.000Z',
    ...overrides,
  }
}

const personal = workspace({
  id: '00000000-0000-4000-8000-000000000010',
  name: 'Personal workspace',
  type: 'personal',
  role: 'owner',
  clerkOrganizationId: null,
  memberCount: 1,
})
const optics = workspace({ id: '00000000-0000-4000-8000-000000000020', name: 'optique' })
const acoustics = workspace({
  id: '00000000-0000-4000-8000-000000000030',
  name: 'Acoustique',
  role: 'admin',
})
const all = [optics, personal, acoustics]

describe('team workspaces', () => {
  it('lists the personal workspace, then the teams by name', () => {
    expect(splitWorkspaces(all)).toEqual({ personal, teams: [acoustics, optics] })
    expect(splitWorkspaces([optics]).personal).toBeNull()
  })

  it('names the personal workspace in French', () => {
    expect(workspaceLabel(personal)).toBe('Personnel')
    expect(workspaceLabel(optics)).toBe('optique')
  })

  it('builds the team and dashboard addresses', () => {
    expect(teamUrl('org_2abc')).toBe('/team/org_2abc')
    expect(dashboardUrl(null)).toBe('/dashboard')
    expect(dashboardUrl(optics.id)).toBe(`/dashboard?workspace=${optics.id}`)
  })

  it('finds the team of a project', () => {
    expect(teamOfProject({ workspaceId: optics.id }, all)).toBe(optics)
    expect(teamOfProject({ workspaceId: personal.id }, all)).toBeNull()
    expect(teamOfProject({ workspaceId: 'unknown' }, all)).toBeNull()
  })

  it('offers to move only an owned personal project, to the teams of the user', () => {
    expect(moveTargets({ workspaceId: personal.id, role: 'owner' }, all)).toEqual([
      acoustics,
      optics,
    ])
    expect(moveTargets({ workspaceId: personal.id, role: 'editor' }, all)).toEqual([])
    expect(moveTargets({ workspaceId: optics.id, role: 'owner' }, all)).toEqual([])
    // Projet partagé par quelqu'un d'autre : son workspace n'est pas dans la liste.
    expect(moveTargets({ workspaceId: 'someone-else', role: 'owner' }, all)).toEqual([])
  })

  it('describes the team access of a project', () => {
    expect(seatsText(1)).toBe('1 membre')
    expect(teamAccessText({ name: 'Optique', memberRole: 'reviewer', memberCount: 3 })).toBe(
      'Les 3 membres de l’équipe « Optique » y ont accès : administrateurs comme propriétaires, membres comme relecteurs.',
    )
  })
})

const teamPlan: WorkspacePlanResponse = {
  workspaceId: optics.id,
  plan: 'team',
  active: true,
  source: 'subscription',
  features: ['ai', 'extra_storage', 'full_history', 'long_compile', 'unlimited_collaborators'],
  limits: {
    maxCompileSeconds: 240,
    maxCollaborators: null,
    historyRetentionDays: null,
    storageBytes: 50 * GIB,
  },
  seats: 3,
  perSeat: true,
  usage: { storageBytes: 5 * GIB },
  credits: {
    periodStart: '2026-10-01T00:00:00.000Z',
    resetsAt: '2026-11-01T00:00:00.000Z',
    ai: { monthly: 6000, used: 1500, remaining: 4500 },
    images: { monthly: 300, used: 0, remaining: 300 },
  },
  subscription: { status: 'active', periodEnd: '2026-11-01T00:00:00.000Z' },
  upgradeUrl: 'http://localhost:3000/pricing',
}

describe('team plan and usage', () => {
  it('shows the seats, the pooled storage and the per-seat credits', () => {
    const view = teamPlanView(teamPlan)
    expect(view.plan).toBe('Team')
    expect(view.paid).toBe(true)
    expect(view.subscription).toBe('Abonnement actif, renouvelé le 1 novembre 2026')
    expect(view.storageFull).toBe(false)
    expect(view.rows).toEqual([
      { label: 'Sièges', value: '3 membres, facturés par siège' },
      { label: 'Stockage mutualisé', value: '5 Go sur 50 Go', ratio: 0.1 },
      { label: 'Durée de compilation', value: '4 min au plus par compilation' },
      { label: 'Invités par projet', value: 'Illimités (les membres de l’équipe ne comptent pas)' },
      { label: 'Historique', value: 'Complet' },
      {
        label: 'Crédits IA',
        value: '1 500 sur 6 000, remis à zéro le 1 novembre 2026 (2 000 par membre)',
        ratio: 0.25,
      },
      {
        label: 'Images',
        value: '0 sur 300, remis à zéro le 1 novembre 2026 (100 par membre)',
        ratio: 0,
      },
    ])
  })

  it('shows a free team without per-seat credits and a full storage', () => {
    const view = teamPlanView({
      ...teamPlan,
      plan: 'free',
      active: false,
      perSeat: false,
      seats: 1,
      limits: { ...teamPlan.limits, storageBytes: GIB, maxCollaborators: 1 },
      usage: { storageBytes: 2 * GIB },
      subscription: null,
    })
    expect(view.paid).toBe(false)
    expect(view.plan).toBe('Free')
    expect(view.storageFull).toBe(true)
    expect(view.rows[0]).toEqual({ label: 'Sièges', value: '1 membre' })
    expect(view.rows[1]?.ratio).toBe(1)
    expect(view.rows[3]?.value).toBe('1 (les membres de l’équipe ne comptent pas)')
    expect(view.rows[5]?.value).toBe('Pas de réserve d’équipe : crédits personnels de chacun')
    expect(view.inactiveNotice).toContain('n’accepte pas de nouveaux projets')
  })

  it('names the team in a plan limit refusal of a team project', () => {
    const refusal: PlanLimitError = {
      code: 'E_PLAN_LIMIT',
      message: 'Storage limit reached',
      limit: { name: 'storage', plan: 'team', max: 50 * GIB },
      feature: 'extra_storage',
      upgradeUrl: 'http://localhost:3000/pricing',
    }
    expect(planLimitMessage(refusal).description).toContain('Le plan Team de l’équipe offre 50 Go')
    expect(
      planLimitMessage({ ...refusal, limit: { name: 'ai_credits', plan: 'team', max: 6000 } })
        .description,
    ).toContain('Le plan Team de l’équipe inclut 6000 crédits IA')
    expect(
      planLimitMessage({ ...refusal, limit: { ...refusal.limit, plan: 'free' } }).description,
    ).toContain('Le plan Free du propriétaire du projet')
  })

  it('asks Clerk for the personal plan only (never the active organization’s)', () => {
    expect(USER_PRO_PLAN).toBe('u:pro')
    expect(userFeature('long_compile')).toBe('u:long_compile')
  })

  it('explains in French that a team without an active plan accepts no project', () => {
    const fallback = () => 'other'
    expect(teamErrorMessage({ code: 'E_TEAM_PLAN_REQUIRED' }, fallback)).toBe(
      TEAM_PLAN_REQUIRED_MESSAGE,
    )
    expect(teamErrorMessage({ code: 'E_WORKSPACE_FORBIDDEN' }, fallback)).toBe('other')
    expect(teamErrorMessage(new Error('boom'), fallback)).toBe('other')
  })
})
