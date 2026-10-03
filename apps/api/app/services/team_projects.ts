import type { TeamAccess, TeamMemberRole } from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type User from '#models/user'
import Workspace from '#models/workspace'
import { accountOfProject, accountOfWorkspace } from '#services/entitlements'
import { assertMoveWithinLimits } from '#services/plan_enforcement'
import { ProjectForbiddenException, projectFor } from '#services/project_access'
import { serializeProject } from '#services/project_service'
import type RealtimeClient from '#services/realtime_client'
import { assertWorkspaceAcceptsProjects, workspaceFor } from '#services/workspace_service'

/**
 * Projets d'un workspace d'équipe : déplacement d'un projet personnel vers une équipe, et rôle
 * des membres de l'équipe sur un projet (réglable par projet). Les changements d'accès sont
 * signalés au service temps réel une fois la transaction validée (`notifyTeamAccess`).
 */

export class InvalidProjectMoveException extends Exception {
  static override status = 422
  static override code = 'E_INVALID_PROJECT_MOVE'
  static override message = 'Only a personal project can be moved, into a team workspace'
}

export class NotTeamProjectException extends Exception {
  static override status = 422
  static override code = 'E_NOT_TEAM_PROJECT'
  static override message = 'This project does not belong to a team workspace'
}

/** Accès à revérifier après validation : membres de l'équipe sur un projet. */
export interface TeamAccessNotice {
  projectId: string
  userIds: string[]
}

async function teamMemberIds(
  workspaceId: string,
  trx: TransactionClientContract,
  role?: 'member',
): Promise<string[]> {
  const query = trx.from('workspace_members').where('workspace_id', workspaceId).select('user_id')
  if (role !== undefined) void query.where('role', role)
  const rows = (await query) as { user_id: string }[]
  return rows.map((row) => row.user_id)
}

/**
 * Déplace un projet personnel vers un workspace d'équipe (`POST /projects/:id/move`) : seul son
 * propriétaire le fait, s'il est membre de l'équipe (permission `createProject`) et que
 * l'organisation a un plan actif (403 `E_TEAM_PLAN_REQUIRED` sinon). Le projet doit
 * tenir dans les limites du plan de l'organisation (stockage mutualisé, collaborateurs), sinon
 * 403 `E_PLAN_LIMIT` et rien ne change. Le propriétaire reste propriétaire ; les membres de
 * l'équipe y accèdent avec leur rôle dérivé, les membres invités gardent leur rôle.
 */
export async function moveProjectToTeam(
  user: User,
  projectId: string,
  workspaceId: string,
): Promise<{ project: ReturnType<typeof serializeProject>; notice: TeamAccessNotice }> {
  return db.transaction(async (trx) => {
    const { project, role } = await projectFor(user, projectId, 'manageProject', {
      trx,
      lock: true,
    })
    // Propriétaire réel seulement (pas un administrateur d'une autre équipe).
    if (project.ownerId !== user.id) throw new ProjectForbiddenException()
    const current = await Workspace.query({ client: trx })
      .where('id', project.workspaceId)
      .firstOrFail()
    const { workspace: target } = await workspaceFor(user, workspaceId, trx, 'createProject')
    if (current.type !== 'personal' || target.type !== 'team' || target.id === current.id) {
      throw new InvalidProjectMoveException()
    }
    // Équipe sans plan actif : 403 `E_TEAM_PLAN_REQUIRED` (pas de stockage Free par organisation).
    await assertWorkspaceAcceptsProjects(user, target, trx)
    const targetAccount = await accountOfWorkspace(target.id, trx)
    if (!targetAccount) throw new InvalidProjectMoveException()
    await assertMoveWithinLimits(
      project.id,
      await accountOfProject(project, trx),
      targetAccount,
      trx,
      user,
    )
    project.workspaceId = target.id
    await project.useTransaction(trx).save()
    const userIds = await teamMemberIds(target.id, trx)
    return {
      project: serializeProject(project, role),
      notice: { projectId: project.id, userIds },
    }
  })
}

/**
 * Rôle des membres `member` de l'équipe sur un projet d'équipe (`PUT /projects/:id/team-access`,
 * permission `manageMembers` : propriétaire, administrateur de l'équipe). Les administrateurs
 * restent propriétaires effectifs ; une invitation individuelle plus élevée l'emporte.
 */
export async function setTeamAccess(
  user: User,
  projectId: string,
  role: TeamMemberRole,
): Promise<{ access: TeamAccess; notice: TeamAccessNotice }> {
  return db.transaction(async (trx) => {
    const { project } = await projectFor(user, projectId, 'manageMembers', { trx, lock: true })
    const workspace = await Workspace.query({ client: trx })
      .where('id', project.workspaceId)
      .firstOrFail()
    if (workspace.type !== 'team') throw new NotTeamProjectException()
    const changed = project.teamRole !== role
    if (changed) {
      project.teamRole = role
      await project.useTransaction(trx).save()
    }
    return {
      access: { projectId: project.id, workspaceId: workspace.id, role },
      notice: {
        projectId: project.id,
        userIds: changed ? await teamMemberIds(workspace.id, trx, 'member') : [],
      },
    }
  })
}

/** Après validation : rôles relus par le service temps réel (au mieux). */
export async function notifyTeamAccess(
  realtime: RealtimeClient,
  notice: TeamAccessNotice,
): Promise<void> {
  if (notice.userIds.length === 0) return
  await realtime.membersChanged(notice.projectId, notice.userIds)
}
