import { randomUUID } from 'node:crypto'
import { PERSONAL_WORKSPACE_NAME, type WorkspaceRole } from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type User from '#models/user'
import Workspace from '#models/workspace'
import { isUuid } from '#services/project_access'

export class WorkspaceNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_WORKSPACE_NOT_FOUND'
  static override message = 'Workspace not found'
}

export interface WorkspaceAccess {
  workspace: Workspace
  role: WorkspaceRole
}

export function serializeWorkspace(workspace: Workspace, role: WorkspaceRole) {
  return {
    id: workspace.id,
    name: workspace.name,
    type: workspace.type,
    ownerId: workspace.ownerId,
    role,
    createdAt: workspace.createdAt.toUTC().toISO(),
  }
}

/**
 * Workspace personnel de l'utilisateur, créé au besoin avec son propriétaire comme membre.
 * Idempotent, y compris en concurrence : l'index unique partiel arbitre deux créations simultanées
 * (`ON CONFLICT DO NOTHING`), puis la ligne gagnante est relue.
 */
export async function ensurePersonalWorkspace(
  user: User,
  client?: TransactionClientContract,
): Promise<Workspace> {
  const run = async (trx: TransactionClientContract) => {
    await trx.rawQuery(
      `INSERT INTO workspaces (id, name, type, owner_id) VALUES (?, ?, 'personal', ?)
       ON CONFLICT (owner_id) WHERE type = 'personal' DO NOTHING`,
      [randomUUID(), PERSONAL_WORKSPACE_NAME, user.id],
    )
    const workspace = await Workspace.query({ client: trx })
      .where({ ownerId: user.id, type: 'personal' })
      .firstOrFail()
    await trx.rawQuery(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role) VALUES (?, ?, ?, 'owner')
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [randomUUID(), workspace.id, user.id],
    )
    return workspace
  }
  return client ? run(client) : db.transaction(run)
}

/** Workspaces dont l'utilisateur est membre, le personnel d'abord, avec son rôle. */
async function memberWorkspaces(user: User): Promise<Workspace[]> {
  return (
    Workspace.query()
      .join('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
      .where('workspace_members.user_id', user.id)
      .select('workspaces.*', 'workspace_members.role as member_role')
      // « personal » < « team » : le workspace personnel vient en premier.
      .orderBy([
        { column: 'workspaces.type', order: 'asc' },
        { column: 'workspaces.name', order: 'asc' },
        { column: 'workspaces.created_at', order: 'asc' },
      ])
  )
}

/**
 * Workspaces de l'utilisateur avec son rôle. Un compte sans workspace personnel (miroir créé par
 * une version antérieure pendant un déploiement, ligne importée en SQL) le reçoit ici : aucune
 * écriture dans le cas courant, une seule réparation sinon.
 */
export async function listWorkspaces(user: User) {
  let workspaces = await memberWorkspaces(user)
  const hasPersonal = workspaces.some(
    (workspace) => workspace.type === 'personal' && workspace.ownerId === user.id,
  )
  if (!hasPersonal) {
    await ensurePersonalWorkspace(user)
    workspaces = await memberWorkspaces(user)
  }
  return workspaces.map((workspace) =>
    serializeWorkspace(
      workspace,
      (workspace.$extras as { member_role: WorkspaceRole }).member_role,
    ),
  )
}

/**
 * Charge un workspace dont l'utilisateur est membre. Un workspace dont il n'est pas membre répond
 * 404, pour ne pas révéler son existence.
 */
export async function workspaceFor(
  user: User,
  workspaceId: string,
  trx?: TransactionClientContract,
): Promise<WorkspaceAccess> {
  if (!isUuid(workspaceId)) throw new WorkspaceNotFoundException()
  const workspace = await Workspace.query({ client: trx })
    .join('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
    .where('workspaces.id', workspaceId)
    .where('workspace_members.user_id', user.id)
    .select('workspaces.*', 'workspace_members.role as member_role')
    .first()
  if (!workspace) throw new WorkspaceNotFoundException()
  return { workspace, role: (workspace.$extras as { member_role: WorkspaceRole }).member_role }
}

/**
 * Workspace d'un nouveau projet : celui demandé, dont l'utilisateur doit être membre, sinon son
 * workspace personnel.
 */
export async function workspaceForNewProject(
  user: User,
  workspaceId: string | undefined,
  trx: TransactionClientContract,
): Promise<Workspace> {
  if (workspaceId === undefined) return ensurePersonalWorkspace(user, trx)
  return (await workspaceFor(user, workspaceId, trx)).workspace
}
