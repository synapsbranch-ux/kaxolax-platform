import type {
  AdminPagination,
  AdminUserDetail,
  AdminUserSummary,
  AdminUsersResponse,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import PlanLimit from '#models/plan_limit'
import Subscription from '#models/subscription'
import User from '#models/user'
import { forgetAdminStatus } from '#services/admin_access'
import { type AdminAction, auditFailures, recordAdminAction } from '#services/admin_audit'
import type ClerkBackend from '#services/clerk_backend'
import { applyBanState, deleteClerkUser } from '#services/clerk_users'
import { isoString, isoStringOrNull } from '#services/dates'
import type ObjectStorage from '#services/object_storage'
import type { CompileOutputStorage } from '#services/object_storage'
import { CURRENT_SUBSCRIPTION_STATUSES, FREE_PLAN_SLUG } from '#services/plans'
import { isUuid } from '#services/project_access'
import { announceDepartures } from '#services/project_events'
import { releaseDeletedProject } from '#services/project_service'
import type RealtimeClient from '#services/realtime_client'

export class AdminUserNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_USER_NOT_FOUND'
  static override message = 'User not found'
}

export class AdminSelfActionException extends Exception {
  static override status = 409
  static override code = 'E_ADMIN_SELF_ACTION'
  static override message = 'An administrator cannot do this to their own account'
}

export class UserDeletedException extends Exception {
  static override status = 409
  static override code = 'E_USER_DELETED'
  static override message = 'This account has been deleted'
}

/** Services externes des actions sur un compte. */
export interface AdminUserDependencies {
  clerk: ClerkBackend
  realtime: RealtimeClient
  storage: ObjectStorage
  outputs: CompileOutputStorage
}

/** Motif ILIKE qui cherche le texte tel quel (%, _ et \ échappés). */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (character) => `\\${character}`)}%`
}

/** Pagination Lucid vers le contrat de l'admin. */
export function paginationOf(paginator: {
  currentPage: number
  perPage: number
  total: number
  lastPage: number
}): AdminPagination {
  return {
    page: paginator.currentPage,
    perPage: paginator.perPage,
    total: paginator.total,
    lastPage: paginator.lastPage,
  }
}

/**
 * Abonnement en cours de chaque compte (statut active ou past_due) : un plan payant passe avant
 * `free`, puis le plus récent.
 */
async function currentSubscriptions(
  userIds: readonly string[],
): Promise<Map<string, Subscription>> {
  const current = new Map<string, Subscription>()
  if (userIds.length === 0) return current
  const subscriptions = await Subscription.query()
    .whereIn('user_id', [...userIds])
    .whereIn('status', CURRENT_SUBSCRIPTION_STATUSES)
    .orderByRaw('(plan_slug = ?) ASC, updated_at DESC', [FREE_PLAN_SLUG])
  for (const subscription of subscriptions) {
    if (!current.has(subscription.userId)) current.set(subscription.userId, subscription)
  }
  return current
}

function serializeSummary(user: User, subscription: Subscription | undefined): AdminUserSummary {
  return {
    id: user.id,
    clerkUserId: user.clerkUserId,
    email: user.email,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
    planSlug: subscription?.planSlug ?? FREE_PLAN_SLUG,
    createdAt: isoString(user.createdAt),
    bannedAt: isoStringOrNull(user.bannedAt),
    deletedAt: isoStringOrNull(user.deletedAt),
  }
}

/** Ligne de la liste pour un seul compte (réponse des actions). */
export async function userSummary(user: User): Promise<AdminUserSummary> {
  return serializeSummary(user, (await currentSubscriptions([user.id])).get(user.id))
}

/**
 * Recherche par email ou nom (sous-chaîne, sans casse), ou par identifiant exact (uuid local ou
 * `user_…` de Clerk) ; comptes supprimés compris, les plus récents d'abord.
 */
export async function searchUsers(filters: {
  q?: string | undefined
  page: number
  perPage: number
}): Promise<AdminUsersResponse> {
  const term = filters.q?.trim() ?? ''
  const query = User.query().orderBy('created_at', 'desc').orderBy('id', 'asc')
  if (term !== '') {
    const pattern = likePattern(term)
    void query.where((search) => {
      void search
        .whereILike('email', pattern)
        .orWhereILike('full_name', pattern)
        .orWhere('clerk_user_id', term)
      if (isUuid(term)) void search.orWhere('id', term)
    })
  }
  const page = await query.paginate(filters.page, filters.perPage)
  const users = page.all()
  const subscriptions = await currentSubscriptions(users.map((user) => user.id))
  return {
    users: users.map((user) => serializeSummary(user, subscriptions.get(user.id))),
    pagination: paginationOf(page),
  }
}

export async function findUserOrFail(userId: string): Promise<User> {
  const user = isUuid(userId) ? await User.find(userId) : null
  if (!user) throw new AdminUserNotFoundException()
  return user
}

interface UserUsageRow {
  owned_projects: number
  member_projects: number
  storage_bytes: string | number
}

/** Projets possédés, projets d'autres comptes dont il est membre, octets des fichiers de ses projets. */
async function userUsage(userId: string) {
  const result = await db.rawQuery<{ rows: UserUsageRow[] }>(
    `SELECT
       (SELECT COUNT(*)::int FROM projects WHERE owner_id = ?) AS owned_projects,
       (SELECT COUNT(*)::int FROM project_members pm JOIN projects p ON p.id = pm.project_id
         WHERE pm.user_id = ? AND p.owner_id <> ?) AS member_projects,
       (SELECT COALESCE(SUM(f.size_bytes), 0) FROM files f JOIN projects p ON p.id = f.project_id
         WHERE p.owner_id = ?) AS storage_bytes`,
    [userId, userId, userId, userId],
  )
  const row = result.rows[0]
  return {
    ownedProjects: row?.owned_projects ?? 0,
    memberProjects: row?.member_projects ?? 0,
    // SUM d'un bigint : numeric, renvoyé en texte par pg.
    storageBytes: Number(row?.storage_bytes ?? 0),
  }
}

/**
 * Fiche d'un compte : plan et limites, projets possédés et partagés avec lui, stockage de ses
 * projets, et dernière connexion lue par l'API Backend de Clerk (null si Clerk ne répond pas).
 */
export async function userDetail(user: User, clerk: ClerkBackend): Promise<AdminUserDetail> {
  const subscription = (await currentSubscriptions([user.id])).get(user.id)
  const planSlug = subscription?.planSlug ?? FREE_PLAN_SLUG
  // L'appel à Clerk part pendant les requêtes SQL, faites à la suite sur la même connexion.
  const pendingAccount = clerk.getAccount(user.clerkUserId).catch((error: unknown) => {
    logger.warn({ err: error, userId: user.id }, 'clerk account unavailable for admin detail')
    return null
  })
  const limits = await PlanLimit.find(planSlug)
  const usage = await userUsage(user.id)
  const account = await pendingAccount
  return {
    ...serializeSummary(user, subscription),
    plan: {
      slug: planSlug,
      status: subscription?.status ?? null,
      periodEnd: isoStringOrNull(subscription?.periodEnd),
      limits: limits
        ? {
            maxCompileSeconds: limits.maxCompileSeconds,
            maxCollaborators: limits.maxCollaborators,
            historyRetentionDays: limits.historyRetentionDays,
            storageBytes: limits.storageBytes,
          }
        : null,
    },
    ...usage,
    clerk: account
      ? {
          lastSignInAt: isoStringOrNull(account.lastSignInAt),
          lastActiveAt: isoStringOrNull(account.lastActiveAt),
          twoFactorEnabled: account.twoFactorEnabled,
          banned: account.banned,
        }
      : null,
  }
}

/**
 * Entrée du journal d'une action sur un compte : identifiants seulement (uuid local et id Clerk),
 * jamais l'email ni le nom, que la suppression anonymise ; la fiche du compte les donne tant qu'il
 * existe.
 */
function userAction(
  admin: User,
  action: 'user.ban' | 'user.unban' | 'user.revoke_sessions' | 'user.delete',
  target: User,
): AdminAction {
  return {
    admin,
    action,
    targetType: 'user',
    targetId: target.id,
    metadata: { clerkUserId: target.clerkUserId },
  }
}

/**
 * Ferme les connexions temps réel du compte, une fois l'effet validé en base (une connexion
 * authentifiée pendant la transaction est refusée par le service temps réel à son attache). Le
 * résultat est journalisé dans une entrée à part, `user.realtime_disconnect`, en échec si le
 * service n'a pas répondu : l'entrée de l'action, écrite avec l'effet, n'est jamais modifiée.
 * Renvoie false en cas d'échec.
 */
async function disconnectRealtime(
  admin: User,
  target: User,
  trigger: AdminAction['action'],
  realtime: RealtimeClient,
): Promise<boolean> {
  const connections = await realtime.disconnectUser(target.id)
  const action: AdminAction = {
    admin,
    action: 'user.realtime_disconnect',
    targetType: 'user',
    targetId: target.id,
    metadata: { clerkUserId: target.clerkUserId, trigger, connectionsClosed: connections },
  }
  try {
    await recordAdminAction(action, undefined, connections === null ? 'failure' : 'success')
  } catch (error) {
    logger.error({ err: error, userId: target.id }, 'could not record realtime disconnect')
  }
  return connections !== null
}

function assertActionable(admin: User, target: User): void {
  if (target.id === admin.id) throw new AdminSelfActionException()
  if (target.deletedAt) throw new UserDeletedException()
}

async function lockUser(userId: string, trx: TransactionClientContract): Promise<User> {
  return User.query({ client: trx }).where('id', userId).forUpdate().firstOrFail()
}

/**
 * Bannit un compte : Clerk révoque ses sessions et refuse ses connexions, puis `banned_at` est
 * posé avec l'entrée du journal (même transaction) et ses connexions temps réel sont fermées.
 * L'API refuse dès lors ses jetons encore valides.
 */
export async function banUser(
  admin: User,
  target: User,
  deps: Pick<AdminUserDependencies, 'clerk' | 'realtime'>,
): Promise<{ user: User; realtimeDisconnected: boolean }> {
  assertActionable(admin, target)
  const action = userAction(admin, 'user.ban', target)
  const user = await auditFailures(action, async () => {
    const changedAt = await deps.clerk.banUser(target.clerkUserId)
    return db.transaction(async (trx) => {
      const locked = await lockUser(target.id, trx)
      await applyBanState(locked, { banned: true, changedAt }, trx)
      await recordAdminAction(action, trx)
      return locked
    })
  })
  forgetAdminStatus(target.clerkUserId)
  const realtimeDisconnected = await disconnectRealtime(admin, target, 'user.ban', deps.realtime)
  return { user, realtimeDisconnected }
}

/** Lève le bannissement dans Clerk puis localement, avec l'entrée du journal. */
export async function unbanUser(
  admin: User,
  target: User,
  deps: Pick<AdminUserDependencies, 'clerk'>,
): Promise<User> {
  assertActionable(admin, target)
  const action = userAction(admin, 'user.unban', target)
  const user = await auditFailures(action, async () => {
    const changedAt = await deps.clerk.unbanUser(target.clerkUserId)
    return db.transaction(async (trx) => {
      const locked = await lockUser(target.id, trx)
      await applyBanState(locked, { banned: false, changedAt }, trx)
      await recordAdminAction(action, trx)
      return locked
    })
  })
  forgetAdminStatus(target.clerkUserId)
  return user
}

/**
 * Révoque toutes les sessions Clerk du compte, pose `sessions_revoked_at` (avec l'entrée du
 * journal, même transaction) puis ferme ses connexions temps réel. Ses jetons Clerk déjà émis
 * restent valides jusqu'à 60 s chez Clerk, mais l'API les refuse (émis avant la coupure) ; ses
 * jetons temps réel aussi, côté service temps réel : la reconnexion exige une nouvelle connexion.
 */
export async function revokeUserSessions(
  admin: User,
  target: User,
  deps: Pick<AdminUserDependencies, 'clerk' | 'realtime'>,
): Promise<{ revokedSessions: number; realtimeDisconnected: boolean }> {
  assertActionable(admin, target)
  const action = userAction(admin, 'user.revoke_sessions', target)
  const revoked = await auditFailures(action, async () => {
    const count = await deps.clerk.revokeSessions(target.clerkUserId)
    await db.transaction(async (trx) => {
      const locked = await lockUser(target.id, trx)
      locked.sessionsRevokedAt = DateTime.utc()
      await locked.useTransaction(trx).save()
      await recordAdminAction(
        { ...action, metadata: { ...action.metadata, revokedSessions: count } },
        trx,
      )
    })
    return count
  })
  const realtimeDisconnected = await disconnectRealtime(
    admin,
    target,
    'user.revoke_sessions',
    deps.realtime,
  )
  return { revokedSessions: revoked, realtimeDisconnected }
}

/**
 * Supprime le compte dans Clerk, puis l'anonymise tout de suite comme le fera le webhook
 * `user.deleted` (qui n'aura alors plus d'effet) : retrait des projets partagés, suppression de
 * ses projets. Un compte déjà absent de Clerk est anonymisé de la même façon.
 */
export async function deleteUser(
  admin: User,
  target: User,
  deps: AdminUserDependencies,
): Promise<{ user: User; realtimeDisconnected: boolean }> {
  assertActionable(admin, target)
  const action = userAction(admin, 'user.delete', target)
  const { user, deleted, leftProjectIds } = await auditFailures(action, async () => {
    const existed = await deps.clerk.deleteUser(target.clerkUserId)
    return db.transaction(async (trx) => {
      const { deleted: projects, leftProjectIds } = await deleteClerkUser(target.clerkUserId, trx)
      await recordAdminAction(
        {
          ...action,
          metadata: {
            ...action.metadata,
            clerkAccountExisted: existed,
            deletedProjects: projects.length,
          },
        },
        trx,
      )
      return { user: await lockUser(target.id, trx), deleted: projects, leftProjectIds }
    })
  })
  forgetAdminStatus(target.clerkUserId)
  for (const project of deleted) await releaseDeletedProject(project, deps)
  const realtimeDisconnected = await disconnectRealtime(admin, target, 'user.delete', deps.realtime)
  await announceDepartures(deps.realtime, target.id, leftProjectIds, admin.id)
  return { user, realtimeDisconnected }
}
