import { clerk } from '@clerk/testing/playwright'
import { expect, type Page } from '@playwright/test'
import type { Account } from './accounts'
import { api, rawApi } from './api'
import { clerkBackend } from './clerk'

/**
 * Équipes des parcours (Organisations Clerk de l'instance de développement). Le webhook Clerk
 * n'atteint pas une pile locale sans tunnel : le workspace d'une équipe est alors créé (et ses
 * adhésions rattrapées) par `POST /workspaces/sync`, que la page de l'équipe appelle d'elle-même
 * et que ces outils appellent pour préparer un parcours ou constater un retrait.
 */

/** Délai entre deux rattrapages d'une même organisation par l'API (`ORGANIZATION_SYNC_INTERVAL_MS`). */
const SYNC_INTERVAL_MS = 10_000

/** Fait de l'organisation l'organisation active de la session de la page (claim `o`). */
export async function activateTeam(page: Page, organizationId: string): Promise<void> {
  await clerk.loaded({ page })
  await page.evaluate(async (id) => {
    await window.Clerk.setActive({ organization: id })
  }, organizationId)
}

interface SyncedWorkspace {
  id: string
  role: string
  memberCount: number
}

/**
 * Rattrape l'organisation active de la page (`POST /workspaces/sync`) jusqu'à ce que `until`
 * accepte le workspace de l'appelant (ou son absence : null), en respectant l'intervalle de l'API.
 */
export async function syncTeam(
  page: Page,
  until: (workspace: SyncedWorkspace | null) => boolean,
): Promise<SyncedWorkspace | null> {
  let last: SyncedWorkspace | null = null
  await expect
    .poll(
      async () => {
        const response = await rawApi(page, 'POST', '/workspaces/sync')
        if (response.status !== 200) return false
        last = (response.body as { workspace: SyncedWorkspace | null }).workspace
        return until(last)
      },
      { timeout: 60_000, intervals: [1_000, SYNC_INTERVAL_MS] },
    )
    .toBe(true)
  return last
}

/**
 * Équipe préparée par l'API Backend de Clerk (sans l'interface) : `owner` administrateur
 * (créateur), `members` membres ; workspace rattrapé depuis la session du propriétaire.
 */
export async function createTeam(
  owner: Account,
  name: string,
  members: readonly Account[] = [],
): Promise<{ organizationId: string; workspaceId: string }> {
  const organization = await clerkBackend().organizations.createOrganization({
    name,
    createdBy: owner.user.clerkId,
  })
  for (const member of members) {
    await clerkBackend().organizations.createOrganizationMembership({
      organizationId: organization.id,
      userId: member.user.clerkId,
      role: 'org:member',
    })
  }
  await activateTeam(owner.page, organization.id)
  const workspace = await syncTeam(
    owner.page,
    (synced) => synced !== null && synced.memberCount === members.length + 1,
  )
  if (workspace === null) throw new Error(`the team ${name} was not synchronized`)
  return { organizationId: organization.id, workspaceId: workspace.id }
}

/**
 * Vrai si l'organisation a un plan d'équipe actif (`GET /workspaces/:id/plan`) : sans lui, l'API
 * refuse d'y créer ou d'y déplacer un projet (`E_TEAM_PLAN_REQUIRED`). Le plan Team s'active
 * dans le Dashboard Clerk de développement (abonnement de l'organisation, carte de test).
 */
export async function teamPlanActive(page: Page, organizationId: string): Promise<boolean> {
  const { workspaces } = await api<{
    workspaces: { id: string; clerkOrganizationId: string | null }[]
  }>(page, 'GET', '/workspaces')
  const workspace = workspaces.find((entry) => entry.clerkOrganizationId === organizationId)
  if (workspace === undefined) return false
  const plan = await api<{ active: boolean }>(page, 'GET', `/workspaces/${workspace.id}/plan`)
  return plan.active
}

/** Supprime une organisation de test chez Clerk (sans erreur si elle n'existe plus). */
export async function deleteTeam(organizationId: string): Promise<void> {
  try {
    await clerkBackend().organizations.deleteOrganization(organizationId)
  } catch (error) {
    console.warn(`could not delete the Clerk test organization ${organizationId}`, error)
  }
}

/** Identifiant de l'organisation d'une page d'équipe (`/team/<org_…>`). */
export function organizationIdOf(page: Page): string {
  const id = /\/team\/(org_[A-Za-z0-9]+)/.exec(new URL(page.url()).pathname)?.[1]
  if (id === undefined) throw new Error(`not a team page: ${page.url()}`)
  return id
}
