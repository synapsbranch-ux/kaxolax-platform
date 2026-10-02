import type {
  AdminAuditAction,
  AdminAuditEntry,
  AdminAuditLogResponse,
  AdminAuditOutcome,
  AdminAuditTargetType,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { type DateTime } from 'luxon'
import AdminAuditLog from '#models/admin_audit_log'
import User from '#models/user'
import { isoString } from '#services/dates'

/** Une action de l'admin : auteur, action, cible et détails propres à l'action. */
export interface AdminAction {
  admin: User
  action: AdminAuditAction
  targetType: AdminAuditTargetType
  targetId: string | null
  metadata?: Record<string, unknown>
}

/**
 * Écrit une entrée du journal, dans la transaction de l'effet quand il y en a une : l'entrée et
 * l'effet sont validés ou annulés ensemble. Le résultat est rangé dans `metadata.outcome`.
 */
export async function recordAdminAction(
  action: AdminAction,
  trx?: TransactionClientContract,
  outcome: AdminAuditOutcome = 'success',
): Promise<AdminAuditLog> {
  return AdminAuditLog.create(
    {
      adminId: action.admin.id,
      action: action.action,
      targetType: action.targetType,
      targetId: action.targetId,
      metadata: { ...action.metadata, outcome },
    },
    { client: trx },
  )
}

/** Échec significatif : service externe en erreur ou erreur interne (pas un refus 4xx). */
function isSignificantFailure(error: unknown): boolean {
  return !(error instanceof Exception) || error.status >= 500
}

/**
 * Exécute une action de l'admin. Un échec significatif (Clerk en erreur, erreur interne) est
 * journalisé avec son code avant d'être relevé ; un refus (404, 409, 422) ne l'est pas, rien
 * n'ayant été tenté.
 */
export async function auditFailures<T>(action: AdminAction, run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (error) {
    if (isSignificantFailure(error)) {
      const failure =
        error instanceof Exception
          ? { code: error.code ?? 'E_INTERNAL', status: error.status }
          : { code: 'E_INTERNAL', status: 500 }
      try {
        await recordAdminAction(
          { ...action, metadata: { ...action.metadata, error: failure } },
          undefined,
          'failure',
        )
      } catch (auditError) {
        logger.error({ err: auditError, action: action.action }, 'could not record admin failure')
      }
    }
    throw error
  }
}

/** Entrée du journal pour l'API (contrat `adminAuditEntrySchema`). */
export function serializeAuditEntry(entry: AdminAuditLog, admin: User): AdminAuditEntry {
  const { outcome, ...metadata } = entry.metadata
  return {
    id: entry.id,
    admin: { id: admin.id, email: admin.email, fullName: admin.fullName },
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    outcome: outcome === 'failure' ? 'failure' : 'success',
    metadata,
    createdAt: isoString(entry.createdAt),
  }
}

/** Filtres du journal (tous facultatifs). */
export interface AuditLogFilters {
  adminId?: string | undefined
  action?: AdminAuditAction | undefined
  targetType?: AdminAuditTargetType | undefined
  targetId?: string | undefined
  outcome?: AdminAuditOutcome | undefined
  from?: DateTime | undefined
  to?: DateTime | undefined
  page: number
  perPage: number
}

/** Journal des actions, les plus récentes d'abord, filtrable par auteur, action, cible, résultat et période. */
export async function listAuditLog(filters: AuditLogFilters): Promise<AdminAuditLogResponse> {
  const query = AdminAuditLog.query().orderBy('created_at', 'desc').orderBy('id')
  if (filters.adminId !== undefined) void query.where('admin_id', filters.adminId)
  if (filters.action !== undefined) void query.where('action', filters.action)
  if (filters.targetType !== undefined) void query.where('target_type', filters.targetType)
  if (filters.targetId !== undefined) void query.where('target_id', filters.targetId)
  if (filters.outcome === 'failure') void query.whereRaw(`metadata->>'outcome' = 'failure'`)
  if (filters.outcome === 'success') {
    void query.whereRaw(`metadata->>'outcome' IS DISTINCT FROM 'failure'`)
  }
  if (filters.from !== undefined) void query.where('created_at', '>=', filters.from.toJSDate())
  if (filters.to !== undefined) void query.where('created_at', '<', filters.to.toJSDate())
  const page = await query.paginate(filters.page, filters.perPage)
  const entries = page.all()
  const adminIds = [...new Set(entries.map((entry) => entry.adminId))]
  const admins = adminIds.length === 0 ? [] : await User.query().whereIn('id', adminIds)
  const byId = new Map(admins.map((admin) => [admin.id, admin]))
  return {
    entries: entries.flatMap((entry) => {
      const admin = byId.get(entry.adminId)
      // admin_id est en RESTRICT : l'auteur existe toujours.
      return admin ? [serializeAuditEntry(entry, admin)] : []
    }),
    pagination: {
      page: page.currentPage,
      perPage: page.perPage,
      total: page.total,
      lastPage: page.lastPage,
    },
  }
}
