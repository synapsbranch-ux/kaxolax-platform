import type { ProjectEvent, ProjectRole } from '@kaxolax/contracts'
import type RealtimeClient from '#services/realtime_client'

/**
 * Événements des membres d'un projet, diffusés sur son document meta après la validation de la
 * transaction (voir `RealtimeClient.publishProjectEvent`, au mieux).
 */

/** Transfert de propriété : le nouveau propriétaire devient owner, l'ancien editor. */
export function ownershipTransferEvents(
  transfer: { fromUserId: string; toUserId: string },
  actorId: string,
): ProjectEvent[] {
  return [
    { type: 'member.role-updated', userId: transfer.toUserId, role: 'owner', actorId },
    { type: 'member.role-updated', userId: transfer.fromUserId, role: 'editor', actorId },
  ]
}

/**
 * Arrivée par invitation ou lien (`joined`) : nouveau membre, ou rôle relevé d'un membre existant
 * (`raised`). Null si rien n'a changé.
 */
export function joinEvent(
  userId: string,
  join: { role: ProjectRole; joined: boolean },
  raised: boolean,
): ProjectEvent | null {
  if (!join.joined) return null
  return raised
    ? { type: 'member.role-updated', userId, role: join.role, actorId: userId }
    : { type: 'member.added', userId, role: join.role, actorId: userId }
}

/** Publie des événements dans l'ordre (au mieux : un échec est journalisé par le client). */
export async function publishProjectEvents(
  realtime: RealtimeClient,
  projectId: string,
  events: readonly ProjectEvent[],
): Promise<void> {
  for (const event of events) await realtime.publishProjectEvent(projectId, event)
}

/**
 * Inscription : chaque projet rejoint par une invitation acceptée d'office est annoncé à ses
 * membres connectés (au mieux, après la validation de la transaction).
 */
export async function announceAutoJoins(
  realtime: RealtimeClient,
  userId: string,
  joined: readonly { projectId: string; role: ProjectRole }[],
): Promise<void> {
  for (const { projectId, role } of joined) {
    await realtime.publishProjectEvent(projectId, {
      type: 'member.added',
      userId,
      role,
      actorId: userId,
    })
  }
}

/**
 * Compte supprimé : son départ de chaque projet partagé est annoncé à ses membres connectés.
 * `actorId` : l'admin qui l'a supprimé, ou null (webhook Clerk).
 */
export async function announceDepartures(
  realtime: RealtimeClient,
  userId: string,
  projectIds: readonly string[],
  actorId: string | null,
): Promise<void> {
  for (const projectId of projectIds) {
    await realtime.publishProjectEvent(projectId, { type: 'member.removed', userId, actorId })
  }
}
