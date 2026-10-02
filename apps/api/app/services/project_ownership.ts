import { randomUUID } from 'node:crypto'
import { Exception } from '@adonisjs/core/exceptions'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type Project from '#models/project'
import ProjectMember from '#models/project_member'
import type User from '#models/user'
import { assertTransferWithinLimits } from '#services/plan_enforcement'
import { ensurePersonalWorkspace } from '#services/workspace_service'

export class InvalidNewOwnerException extends Exception {
  static override status = 422
  static override code = 'E_INVALID_NEW_OWNER'
  static override message =
    'The new owner must be an existing account that is neither deleted nor banned'
}

export class AlreadyOwnerException extends Exception {
  static override status = 409
  static override code = 'E_ALREADY_OWNER'
  static override message = 'This account already owns the project'
}

export interface OwnershipTransfer {
  fromUserId: string
  toUserId: string
  fromWorkspaceId: string
  toWorkspaceId: string
}

/**
 * Transfert de propriété, commun au propriétaire (`POST /projects/:id/transfer`) et à l'admin :
 * le nouveau propriétaire devient membre `owner` (ajouté au besoin), l'ancien devient `editor`, et
 * le projet rejoint le workspace personnel du nouveau. Le projet doit être verrouillé par
 * l'appelant (`FOR UPDATE`) dans la même transaction. Le projet doit tenir dans les limites du plan
 * du nouveau propriétaire (stockage, collaborateurs), sinon 403 `E_PLAN_LIMIT` et rien ne change :
 * l'admin y est soumis aussi. `requester` : compte qui agit.
 */
export async function transferOwnership(
  project: Project,
  newOwner: User,
  trx: TransactionClientContract,
  requester?: User | null,
): Promise<OwnershipTransfer> {
  // Un compte banni ne peut pas devenir propriétaire : le projet n'aurait plus de propriétaire actif.
  if (newOwner.deletedAt || newOwner.bannedAt) throw new InvalidNewOwnerException()
  if (newOwner.id === project.ownerId) throw new AlreadyOwnerException()

  const previous = { ownerId: project.ownerId, workspaceId: project.workspaceId }
  await ProjectMember.query({ client: trx })
    .where({ projectId: project.id, userId: previous.ownerId })
    .update({ role: 'editor' })
  await trx.rawQuery(
    `INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, 'owner')
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'owner'`,
    [randomUUID(), project.id, newOwner.id],
  )
  await assertTransferWithinLimits(project.id, newOwner.id, trx, requester)
  const workspace = await ensurePersonalWorkspace(newOwner, trx)
  project.merge({ ownerId: newOwner.id, workspaceId: workspace.id })
  await project.useTransaction(trx).save()
  return {
    fromUserId: previous.ownerId,
    toUserId: newOwner.id,
    fromWorkspaceId: previous.workspaceId,
    toWorkspaceId: workspace.id,
  }
}
