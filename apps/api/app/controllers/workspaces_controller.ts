import {
  type WorkspaceMembersResponse,
  type WorkspacePlanResponse,
  type WorkspacesResponse,
  type WorkspaceSyncResponse,
} from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { pricingUrl } from '#exceptions/plan_limit'
import Subscription from '#models/subscription'
import { creditsSummary } from '#services/ai_credits'
import { isoString } from '#services/dates'
import ClerkBackend from '#services/clerk_backend'
import {
  accountOfWorkspace,
  activeOrganizationOf,
  isActiveOrganizationPlan,
  limitsOfAccount,
} from '#services/entitlements'
import ObjectStorage, { CompileOutputStorage } from '#services/object_storage'
import { storageUsage } from '#services/plan_enforcement'
import RealtimeClient from '#services/realtime_client'
import { syncOrganizationFromClerk } from '#services/team_catchup'
import { applyTeamEffects } from '#services/team_sync'
import {
  listWorkspaces,
  NoActiveOrganizationException,
  teamWorkspaceOf,
  WorkspaceNotFoundException,
  workspaceFor,
  workspaceMembers,
} from '#services/workspace_service'

@inject()
export default class WorkspacesController {
  constructor(
    private readonly clerk: ClerkBackend,
    private readonly realtime: RealtimeClient,
    private readonly storage: ObjectStorage,
    private readonly outputs: CompileOutputStorage,
  ) {}

  /** Workspaces de l'utilisateur avec son rôle : le personnel, puis ses équipes. */
  async index({ auth }: HttpContext): Promise<WorkspacesResponse> {
    return { workspaces: await listWorkspaces(auth.getUserOrFail()) }
  }

  /**
   * `POST /workspaces/sync` : rattrapage de l'organisation active de la session (claim `o.id`,
   * que Clerk ne pose que pour un membre) depuis l'API Backend, quand le webhook tarde (équipe
   * tout juste créée, invitation acceptée) ou n'arrive pas (développement sans tunnel). Au plus
   * une lecture de Clerk par organisation toutes les 10 s, et un nombre borné par compte et par
   * minute (429 `E_WORKSPACE_SYNC_RATE_LIMITED`) ; renvoie le workspace de l'appelant.
   */
  async sync({ auth }: HttpContext): Promise<WorkspaceSyncResponse> {
    const guard = auth.use('clerk')
    const user = guard.getUserOrFail()
    const organization = activeOrganizationOf(guard.getClaimsOrFail().raw)
    if (organization === null) throw new NoActiveOrganizationException()
    const effects = await syncOrganizationFromClerk(this.clerk, organization.id, user.id)
    if (effects !== null) {
      await applyTeamEffects(
        { realtime: this.realtime, storage: this.storage, outputs: this.outputs },
        effects,
      )
    }
    return { workspace: await teamWorkspaceOf(user, organization.id) }
  }

  /** Membres d'un workspace (tout membre ; emails réservés aux administrateurs). */
  async members({ auth, params }: HttpContext): Promise<WorkspaceMembersResponse> {
    return { members: await workspaceMembers(auth.getUserOrFail(), String(params.id)) }
  }

  /**
   * Plan d'un workspace d'équipe (tout membre) : plan de l'organisation, limites mutualisées,
   * stockage du workspace, crédits du mois de la réserve d'équipe. Affichage seulement. Un
   * workspace personnel répond 404 (son plan est celui de `GET /me/plan`).
   */
  async plan({ auth, params }: HttpContext): Promise<WorkspacePlanResponse> {
    const user = auth.getUserOrFail()
    const { workspace } = await workspaceFor(user, String(params.id))
    const account = await accountOfWorkspace(workspace.id)
    if (account?.type !== 'team') throw new WorkspaceNotFoundException()
    const limits = await limitsOfAccount(account, user)
    const subscription = await Subscription.query()
      .where('clerkOrganizationId', account.clerkOrganizationId)
      .where('planSlug', limits.entitlements.plan)
      .orderBy('updatedAt', 'desc')
      .first()
    return {
      workspaceId: workspace.id,
      plan: limits.entitlements.plan,
      active: await isActiveOrganizationPlan(limits.entitlements),
      source: limits.entitlements.source,
      features: [...limits.entitlements.features].sort(),
      limits: {
        maxCompileSeconds: limits.maxCompileSeconds,
        maxCollaborators: limits.maxCollaborators,
        historyRetentionDays: limits.historyRetentionDays,
        storageBytes: limits.storageBytes,
      },
      seats: limits.seats,
      perSeat: limits.perSeat,
      usage: { storageBytes: await storageUsage(account) },
      credits: await creditsSummary(user, { limits, account }),
      subscription: subscription
        ? {
            status: subscription.status,
            periodEnd: subscription.periodEnd ? isoString(subscription.periodEnd) : null,
          }
        : null,
      upgradeUrl: pricingUrl(),
    }
  }
}
