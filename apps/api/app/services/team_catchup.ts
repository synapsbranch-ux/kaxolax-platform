import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import { applyBillingEvent } from '#services/billing_webhooks'
import type ClerkBackend from '#services/clerk_backend'
import type {
  ClerkMembershipSnapshot,
  ClerkOrganizationSnapshot,
  ClerkSubscriptionItemSnapshot,
} from '#services/clerk_backend'
import {
  applyMembershipMirror,
  deleteOrganizationMirror,
  lockClerkUser,
  mergeTeamEffects,
  NO_TEAM_EFFECTS,
  reconcileOrganization,
  type TeamSyncEffects,
  upsertOrganizationMirror,
} from '#services/team_sync'

/**
 * Rattrapage des équipes depuis l'API Backend de Clerk (`node ace clerk:sync-organizations`) :
 * webhooks perdus, Organisations activées après coup, première mise en service. L'état lu est
 * daté du début de la lecture : un webhook plus récent l'emporte, un webhook plus ancien encore en
 * route est ignoré à son arrivée. Adhésions absentes de Clerk : retirées. Organisations connues
 * localement mais absentes de Clerk : seulement signalées, ou supprimées avec `prune` (règle des
 * organisations supprimées ; garde-fou contre une instance mal configurée qui n'en listerait
 * aucune) ; une organisation créée ou modifiée après le début de la lecture n'est jamais
 * supprimée. Chaque organisation est appliquée
 * dans sa propre transaction ; un échec n'arrête pas les autres. Idempotent.
 */

export interface OrganizationSyncReport {
  organizations: number
  memberships: number
  subscriptionItems: number
  /** Organisations connues localement mais absentes de Clerk (supprimées avec `prune`). */
  missing: string[]
  /** Vrai si `missing` a été appliqué (organisations supprimées localement). */
  pruned: boolean
  failed: { organizationId: string; error: string }[]
  /** Accès changés, à signaler au service temps réel (`applyTeamEffects`). */
  effects: TeamSyncEffects
}

interface OrganizationState {
  organization: ClerkOrganizationSnapshot
  memberships: ClerkMembershipSnapshot[]
  items: ClerkSubscriptionItemSnapshot[] | null
}

async function applyOrganizationState(
  state: OrganizationState,
  at: DateTime,
): Promise<TeamSyncEffects> {
  return db.transaction(async (trx) => {
    const { organization, memberships, items } = state
    const present = new Set(memberships.map((membership) => membership.clerkUserId))
    // Comptes verrouillés dans un ordre fixe, avant toute écriture et avant le verrou de
    // l'organisation (voir `lockClerkUser`) : une création de compte simultanée voit ces
    // adhésions, et un webhook d'adhésion (qui tient `clerk-user:…` avant d'écrire la ligne de
    // l'organisation) n'attend jamais une transaction qui attendrait son compte.
    for (const clerkUserId of [...present].sort()) await lockClerkUser(clerkUserId, trx)
    await upsertOrganizationMirror(organization, at, trx)
    for (const membership of memberships) {
      await applyMembershipMirror(
        {
          organizationId: organization.id,
          clerkUserId: membership.clerkUserId,
          role: membership.role,
          deleted: false,
        },
        at,
        trx,
      )
    }
    const known = (await trx
      .from('clerk_organization_memberships')
      .where('clerk_organization_id', organization.id)
      .whereNull('deleted_at')
      .select('clerk_user_id', 'role')) as { clerk_user_id: string; role: string }[]
    for (const row of known) {
      if (present.has(row.clerk_user_id)) continue
      await applyMembershipMirror(
        {
          organizationId: organization.id,
          clerkUserId: row.clerk_user_id,
          role: row.role,
          deleted: true,
        },
        at,
        trx,
      )
    }
    if (items !== null && items.length > 0) {
      // Même traitement qu'un webhook `subscription.updated` daté de la lecture.
      await applyBillingEvent(
        {
          type: 'subscription.updated',
          timestamp: at.toMillis(),
          data: { items, payer: { organization_id: organization.id } },
        },
        trx,
      )
    }
    return reconcileOrganization(organization.id, trx)
  })
}

/** Lit toutes les organisations dans Clerk et les applique (voir l'en-tête du module). */
export async function syncOrganizationsFromClerk(
  clerk: ClerkBackend,
  options: { dryRun?: boolean; prune?: boolean } = {},
): Promise<OrganizationSyncReport> {
  // Date prise avant la lecture : l'état lu est au moins aussi récent.
  const at = DateTime.utc()
  const organizations = await clerk.listOrganizations()
  const report: OrganizationSyncReport = {
    organizations: organizations.length,
    memberships: 0,
    subscriptionItems: 0,
    missing: [],
    pruned: options.prune === true && options.dryRun !== true,
    failed: [],
    effects: NO_TEAM_EFFECTS,
  }
  const effects: TeamSyncEffects[] = []
  for (const organization of organizations) {
    try {
      const memberships = await clerk.listOrganizationMemberships(organization.id)
      const items = await clerk.organizationSubscriptionItems(organization.id)
      report.memberships += memberships.length
      report.subscriptionItems += items?.length ?? 0
      if (options.dryRun === true) continue
      effects.push(await applyOrganizationState({ organization, memberships, items }, at))
    } catch (error) {
      logger.error({ err: error, organizationId: organization.id }, 'organization sync failed')
      report.failed.push({
        organizationId: organization.id,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const present = new Set(organizations.map((organization) => organization.id))
  // Seules les organisations connues avant la lecture peuvent manquer : une organisation créée
  // (ou modifiée) dans Clerk pendant le rattrapage, déjà reflétée par son webhook, est plus
  // récente que la liste lue et n'est jamais supprimée.
  const known = (await db
    .from('clerk_organizations')
    .whereNull('deleted_at')
    .where('event_at', '<', at.toJSDate())
    .where('created_at', '<', at.toJSDate())
    .select('clerk_organization_id')) as { clerk_organization_id: string }[]
  for (const { clerk_organization_id: organizationId } of known) {
    if (present.has(organizationId)) continue
    report.missing.push(organizationId)
    if (!report.pruned) continue
    effects.push(
      await db.transaction(async (trx) => {
        // Revérifié sous verrou : un webhook arrivé depuis la liste l'emporte.
        if (!(await pruneOrganizationMirror(organizationId, at, trx))) return NO_TEAM_EFFECTS
        return reconcileOrganization(organizationId, trx)
      }),
    )
  }
  report.effects = mergeTeamEffects(...effects)
  return report
}

/**
 * Organisation absente de Clerk (`--prune`) : pierre tombale datée de la lecture, seulement si
 * l'état connu est antérieur à la lecture (ni créée ni modifiée depuis). Vrai si elle est posée.
 */
async function pruneOrganizationMirror(
  organizationId: string,
  at: DateTime,
  trx: TransactionClientContract,
): Promise<boolean> {
  const result = await trx.rawQuery<{ rows: unknown[] }>(
    `UPDATE clerk_organizations SET deleted_at = ?, event_at = ?
      WHERE clerk_organization_id = ? AND deleted_at IS NULL
        AND event_at < ? AND created_at < ?
      RETURNING clerk_organization_id`,
    [at.toJSDate(), at.toJSDate(), organizationId, at.toJSDate(), at.toJSDate()],
  )
  return result.rows.length > 0
}

/** Rattrapage récent d'une organisation (`syncOrganizationFromClerk`), par identifiant. */
const recentSyncs = new Map<string, number>()
/** Délai minimal entre deux lectures de la même organisation chez Clerk. */
export const ORGANIZATION_SYNC_INTERVAL_MS = 10_000
/**
 * Lectures de Clerk permises par compte (toutes organisations confondues) et par processus sur
 * `SYNC_WINDOW_MS` : un compte qui crée de nombreuses organisations ne peut pas multiplier les
 * appels à l'API Backend. Le client attend une équipe en relançant toutes les 2 s, limité à une
 * lecture par organisation et par 10 s : 6 lectures par minute pour une organisation.
 */
export const USER_SYNC_LIMIT = 10
/** Lectures de Clerk permises par processus, tous comptes confondus, sur `SYNC_WINDOW_MS`. */
export const GLOBAL_SYNC_LIMIT = 120
export const SYNC_WINDOW_MS = 60_000
/** Lectures récentes de chaque compte, et de tout le processus. */
const userSyncs = new Map<string, number[]>()
let globalSyncs: number[] = []

/** Trop de rattrapages : 429, le client réessaie plus tard (le webhook reste la voie normale). */
export class WorkspaceSyncRateLimitedException extends Exception {
  static override status = 429
  static override code = 'E_WORKSPACE_SYNC_RATE_LIMITED'
  static override message = 'Too many workspace synchronizations, try again in a minute'
}

/** Oublie les rattrapages récents (tests). */
export function forgetOrganizationSyncs(): void {
  recentSyncs.clear()
  userSyncs.clear()
  globalSyncs = []
}

/**
 * Réserve une lecture de Clerk pour `userId` (fenêtre glissante, par compte et globale) ; lève
 * `WorkspaceSyncRateLimitedException` sinon. Une lecture en échec compte aussi : elle a appelé
 * Clerk.
 */
function reserveSync(userId: string | null, now: number): void {
  const since = now - SYNC_WINDOW_MS
  globalSyncs = globalSyncs.filter((at) => at > since)
  // Nettoyage : seuls les comptes avec une lecture récente restent suivis.
  for (const [id, times] of userSyncs) {
    const recent = times.filter((at) => at > since)
    if (recent.length === 0) userSyncs.delete(id)
    else userSyncs.set(id, recent)
  }
  const mine = userId === null ? [] : (userSyncs.get(userId) ?? [])
  if (mine.length >= USER_SYNC_LIMIT || globalSyncs.length >= GLOBAL_SYNC_LIMIT) {
    throw new WorkspaceSyncRateLimitedException()
  }
  globalSyncs.push(now)
  if (userId !== null) userSyncs.set(userId, [...mine, now])
}

/**
 * Rattrapage d'une seule organisation (`POST /workspaces/sync`, organisation active de la
 * session) : organisation, adhésions et abonnement lus dans Clerk puis appliqués comme par la
 * commande. Une organisation absente de Clerk n'est supprimée localement que si elle y était
 * connue. Au plus une lecture de Clerk par organisation et par `ORGANIZATION_SYNC_INTERVAL_MS`
 * et par processus (sinon rien n'est relu : `null`), et au plus `USER_SYNC_LIMIT` lectures par
 * compte (`requesterId`) et `GLOBAL_SYNC_LIMIT` par processus et par minute (sinon 429), pour
 * que des appels répétés ne consomment pas le quota de l'API Backend.
 */
export async function syncOrganizationFromClerk(
  clerk: ClerkBackend,
  organizationId: string,
  requesterId: string | null,
  now = Date.now(),
): Promise<TeamSyncEffects | null> {
  const last = recentSyncs.get(organizationId)
  if (last !== undefined && now - last < ORGANIZATION_SYNC_INTERVAL_MS) return null
  reserveSync(requesterId, now)
  recentSyncs.set(organizationId, now)
  // Nettoyage : la table ne garde que les rattrapages encore récents.
  for (const [id, at] of recentSyncs) {
    if (now - at >= ORGANIZATION_SYNC_INTERVAL_MS) recentSyncs.delete(id)
  }
  try {
    return await readAndApplyOrganization(clerk, organizationId)
  } catch (error) {
    // Échec (Clerk injoignable…) : un nouvel essai de l'organisation est permis tout de suite
    // (dans la limite du compte).
    recentSyncs.delete(organizationId)
    throw error
  }
}

async function readAndApplyOrganization(
  clerk: ClerkBackend,
  organizationId: string,
): Promise<TeamSyncEffects> {
  const at = DateTime.utc()
  const organization = await clerk.getOrganization(organizationId)
  if (organization === null) {
    return db.transaction(async (trx) => {
      const known = (await trx
        .from('clerk_organizations')
        .where('clerk_organization_id', organizationId)
        .select('clerk_organization_id')) as { clerk_organization_id: string }[]
      if (known.length === 0) return NO_TEAM_EFFECTS
      await deleteOrganizationMirror(organizationId, at, trx)
      return reconcileOrganization(organizationId, trx)
    })
  }
  const memberships = await clerk.listOrganizationMemberships(organizationId)
  const items = await clerk.organizationSubscriptionItems(organizationId)
  return applyOrganizationState({ organization, memberships, items }, at)
}
