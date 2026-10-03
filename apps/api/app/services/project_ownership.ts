import { randomUUID } from 'node:crypto'
import { Exception } from '@adonisjs/core/exceptions'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type Project from '#models/project'
import ProjectMember from '#models/project_member'
import type User from '#models/user'
import Workspace from '#models/workspace'
import { accountOfProject, userAccount } from '#services/entitlements'
import { assertMoveWithinLimits } from '#services/plan_enforcement'
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

/** Un projet d'équipe ne change de propriétaire qu'au sein de l'équipe. */
export class NewOwnerNotInTeamException extends Exception {
  static override status = 422
  static override code = 'E_NEW_OWNER_NOT_IN_TEAM'
  static override message = 'The new owner of a team project must be a member of the team'
}

export interface OwnershipTransfer {
  fromUserId: string
  toUserId: string
  fromWorkspaceId: string
  toWorkspaceId: string
}

/**
 * Transfert de propriété, commun au propriétaire (`POST /projects/:id/transfer`), à l'admin et à
 * la synchronisation des équipes : le nouveau propriétaire devient membre `owner` (ajouté au
 * besoin), l'ancien devient `editor`. Un projet personnel rejoint le workspace personnel du
 * nouveau propriétaire et doit tenir dans les limites de son plan (stockage, collaborateurs),
 * sinon 403 `E_PLAN_LIMIT` et rien ne change : l'admin y est soumis aussi. Un projet d'équipe
 * reste dans son workspace (limites de l'organisation, inchangées) : le nouveau propriétaire doit
 * être membre de l'équipe (422 sinon). Le projet doit être verrouillé par l'appelant
 * (`FOR UPDATE`) dans la même transaction. `requester` : compte qui agit.
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
  const current = await Workspace.query({ client: trx }).where('id', project.workspaceId).first()
  const team = current?.type === 'team' ? current : null
  if (team) {
    const member = (await trx
      .from('workspace_members')
      .where({ workspace_id: team.id, user_id: newOwner.id })
      .select('id')
      .first()) as { id: string } | null
    if (!member) throw new NewOwnerNotInTeamException()
  }
  const source = await accountOfProject(project, trx)
  await ProjectMember.query({ client: trx })
    .where({ projectId: project.id, userId: previous.ownerId })
    .update({ role: 'editor' })
  await trx.rawQuery(
    `INSERT INTO project_members (id, project_id, user_id, role) VALUES (?, ?, ?, 'owner')
     ON CONFLICT (project_id, user_id) DO UPDATE SET role = 'owner'`,
    [randomUUID(), project.id, newOwner.id],
  )
  const target = team ? source : userAccount(newOwner.id)
  await assertMoveWithinLimits(project.id, source, target, trx, requester)
  const workspace = team ?? (await ensurePersonalWorkspace(newOwner, trx))
  project.merge({ ownerId: newOwner.id, workspaceId: workspace.id })
  await project.useTransaction(trx).save()
  return {
    fromUserId: previous.ownerId,
    toUserId: newOwner.id,
    fromWorkspaceId: previous.workspaceId,
    toWorkspaceId: workspace.id,
  }
}
