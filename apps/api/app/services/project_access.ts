import { hasPermission, type ProjectPermission } from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import { type TransactionClientContract } from '@adonisjs/lucid/types/database'
import Project from '#models/project'
import type { ProjectRole } from '#models/project_member'
import type User from '#models/user'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export class ProjectNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_PROJECT_NOT_FOUND'
  static override message = 'Project not found'
}

export class ProjectForbiddenException extends Exception {
  static override status = 403
  static override code = 'E_PROJECT_FORBIDDEN'
  static override message = 'Your role on this project does not allow this action'
}

export interface ProjectAccess {
  project: Project
  role: ProjectRole
}

/**
 * Exigence d'une route : une permission de la matrice (`@kaxolax/contracts`), jamais un rôle
 * minimal. La compilation (lancer, arrêter, vider le cache, SyncTeX, réveil du compilateur)
 * demande `compile` ; lire son résultat, `read`.
 */
export type ProjectRequirement = ProjectPermission

/**
 * Charge un projet dont l'utilisateur est membre, si son rôle accorde la permission demandée
 * (403 sinon). Un projet dont il n'est pas membre répond 404, pour ne pas révéler son existence.
 */
export async function projectFor(
  user: User,
  projectId: string,
  requirement: ProjectRequirement,
  options: { trx?: TransactionClientContract; lock?: boolean } = {},
): Promise<ProjectAccess> {
  if (!UUID.test(projectId)) throw new ProjectNotFoundException()
  const query = (options.trx ?? db)
    .from('project_members')
    .where({ project_id: projectId, user_id: user.id })
    .select('role')
    .first()
  const member = (await query) as { role: ProjectRole } | null
  if (!member) throw new ProjectNotFoundException()

  const projectQuery = Project.query({ client: options.trx }).where('id', projectId)
  if (options.lock === true) void projectQuery.forUpdate()
  const project = await projectQuery.first()
  if (!project) throw new ProjectNotFoundException()
  if (!hasPermission(member.role, requirement)) throw new ProjectForbiddenException()
  return { project, role: member.role }
}

export function isUuid(value: string): boolean {
  return UUID.test(value)
}
