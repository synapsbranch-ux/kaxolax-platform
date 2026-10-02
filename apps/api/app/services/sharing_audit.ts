import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

/** Actions de partage journalisées (table `project_sharing_events` et journal applicatif). */
export type SharingAction =
  | 'member.role_changed'
  | 'member.removed'
  | 'member.left'
  | 'ownership.transferred'
  | 'invitation.created'
  | 'invitation.resent'
  | 'invitation.cancelled'
  | 'invitation.accepted'
  | 'invitation.auto_accepted'
  | 'invitation.send_failed'
  | 'share_link.enabled'
  | 'share_link.disabled'
  | 'share_link.regenerated'
  | 'share_link.joined'

export interface SharingEvent {
  projectId: string
  /** Compte à l'origine de l'action (l'invité lui-même pour une acceptation à l'inscription). */
  actorId: string
  action: SharingAction
  targetUserId?: string | null
  /** Rôles, type de lien, identifiant d'invitation… Jamais de jeton, d'URL de lien ni d'email. */
  metadata?: Record<string, string | number | boolean | null>
}

/**
 * Enregistre une action de partage dans la transaction de l'effet (validée ou annulée avec lui)
 * et l'écrit dans le journal applicatif (ligne structurée).
 */
export async function recordSharingEvent(
  event: SharingEvent,
  trx?: TransactionClientContract,
): Promise<void> {
  const metadata = event.metadata ?? {}
  await (trx ?? db).table('project_sharing_events').insert({
    project_id: event.projectId,
    actor_id: event.actorId,
    action: event.action,
    target_user_id: event.targetUserId ?? null,
    metadata: JSON.stringify(metadata),
  })
  logger.info(
    {
      sharing: event.action,
      projectId: event.projectId,
      actorId: event.actorId,
      targetUserId: event.targetUserId ?? null,
      ...metadata,
    },
    `sharing: ${event.action}`,
  )
}
