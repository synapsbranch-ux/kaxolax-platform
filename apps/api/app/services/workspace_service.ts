import { randomUUID } from 'node:crypto'
import {
  hasWorkspacePermission,
  PERSONAL_WORKSPACE_NAME,
  type Workspace as WorkspaceEntry,
  type WorkspaceMemberEntry,
  type WorkspacePermission,
  type WorkspaceRole,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type User from '#models/user'
import Workspace from '#models/workspace'
import { isoString } from '#services/dates'
import { hasActiveOrganizationPlan } from '#services/entitlements'
import { isUuid } from '#services/project_access'

export class WorkspaceNotFoundException extends Exception {
  static override status = 404
  static override code = 'E_WORKSPACE_NOT_FOUND'
  static override message = 'Workspace not found'
}

export class WorkspaceForbiddenException extends Exception {
  static override status = 403
  static override code = 'E_WORKSPACE_FORBIDDEN'
  static override message = 'Your role in this workspace does not allow this action'
}

export class NoActiveOrganizationException extends Exception {
  static override status = 422
  static override code = 'E_NO_ACTIVE_ORGANIZATION'
  static override message = 'The session has no active organization'
}

/** Équipe sans plan actif : aucun projet ne peut y entrer (création, import, déplacement). */
export class TeamPlanRequiredException extends Exception {
  static override status = 403
  static override code = 'E_TEAM_PLAN_REQUIRED'
  static override message = 'This team has no active plan: subscribe to a team plan to add projects'
}

/** Workspace d'équipe d'une organisation Clerk dont l'utilisateur est membre, ou null. */
export async function teamWorkspaceOf(
  user: User,
  clerkOrganizationId: string,
): Promise<WorkspaceEntry | null> {
  const workspace = await Workspace.query()
    .join('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
    .where('workspaces.clerk_organization_id', clerkOrganizationId)
    .where('workspaces.type', 'team')
    .where('workspace_members.user_id', user.id)
    .select('workspaces.*', 'workspace_members.role as member_role')
    .select(db.raw(MEMBER_COUNT_SQL), db.raw(SLUG_SQL))
    .first()
  if (!workspace) return null
  return serializeWorkspace(
    workspace,
    (workspace.$extras as { member_role: WorkspaceRole }).member_role,
  )
}

export interface WorkspaceAccess {
  workspace: Workspace
  role: WorkspaceRole
}

/** Colonnes ajoutées à chaque workspace lu avec le rôle de l'utilisateur. */
const MEMBER_COUNT_SQL =
  '(SELECT COUNT(*)::int FROM workspace_members c WHERE c.workspace_id = workspaces.id) AS member_count'
const SLUG_SQL =
  '(SELECT o.slug FROM clerk_organizations o WHERE o.clerk_organization_id = workspaces.clerk_organization_id) AS org_slug'

export function serializeWorkspace(workspace: Workspace, role: WorkspaceRole): WorkspaceEntry {
  const extras = workspace.$extras as { member_count?: number; org_slug?: string | null }
  return {
    id: workspace.id,
    name: workspace.name,
    type: workspace.type,
    ownerId: workspace.ownerId,
    role,
    aiEnabled: workspace.aiEnabled,
    clerkOrganizationId: workspace.clerkOrganizationId,
    slug: extras.org_slug ?? null,
    memberCount: extras.member_count ?? 1,
    createdAt: isoString(workspace.createdAt),
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
      .select(db.raw(MEMBER_COUNT_SQL), db.raw(SLUG_SQL))
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
 * Charge un workspace dont l'utilisateur est membre, avec son rôle ; si `permission` est donnée,
 * son rôle doit l'accorder (403 sinon). Un workspace dont il n'est pas membre répond 404, pour ne
 * pas révéler son existence.
 */
export async function workspaceFor(
  user: User,
  workspaceId: string,
  trx?: TransactionClientContract,
  permission?: WorkspacePermission,
): Promise<WorkspaceAccess> {
  if (!isUuid(workspaceId)) throw new WorkspaceNotFoundException()
  const workspace = await Workspace.query({ client: trx })
    .join('workspace_members', 'workspace_members.workspace_id', 'workspaces.id')
    .where('workspaces.id', workspaceId)
    .where('workspace_members.user_id', user.id)
    .select('workspaces.*', 'workspace_members.role as member_role')
    .select(db.raw(MEMBER_COUNT_SQL), db.raw(SLUG_SQL))
    .first()
  if (!workspace) throw new WorkspaceNotFoundException()
  const role = (workspace.$extras as { member_role: WorkspaceRole }).member_role
  if (permission !== undefined && !hasWorkspacePermission(role, permission)) {
    throw new WorkspaceForbiddenException()
  }
  return { workspace, role }
}

/**
 * Refuse (403 `E_TEAM_PLAN_REQUIRED`) d'ajouter un projet à un workspace d'équipe dont
 * l'organisation n'a pas de plan actif (`hasActiveOrganizationPlan`, claims de `user` compris) :
 * sans cela, chaque organisation créée gratuitement apporterait son stockage Free et des membres
 * hors limite de collaborateurs. Un workspace personnel accepte toujours.
 */
export async function assertWorkspaceAcceptsProjects(
  user: User,
  workspace: Pick<Workspace, 'type' | 'clerkOrganizationId'>,
  client?: TransactionClientContract,
): Promise<void> {
  if (workspace.type !== 'team' || workspace.clerkOrganizationId === null) return
  if (!(await hasActiveOrganizationPlan(workspace.clerkOrganizationId, user, client))) {
    throw new TeamPlanRequiredException()
  }
}

/**
 * Workspace d'un nouveau projet : celui demandé, dont l'utilisateur doit être membre avec la
 * permission `createProject` (et, pour une équipe, dont l'organisation a un plan actif), sinon son
 * workspace personnel.
 */
export async function workspaceForNewProject(
  user: User,
  workspaceId: string | undefined,
  trx: TransactionClientContract,
): Promise<Workspace> {
  if (workspaceId === undefined) return ensurePersonalWorkspace(user, trx)
  const { workspace } = await workspaceFor(user, workspaceId, trx, 'createProject')
  await assertWorkspaceAcceptsProjects(user, workspace, trx)
  return workspace
}

/**
 * Contrôle anticipé (hors transaction) du workspace d'un futur projet, avant un upload ou un
 * téléchargement : mêmes refus que `workspaceForNewProject`, refaits à la création.
 */
export async function checkNewProjectWorkspace(
  user: User,
  workspaceId: string | undefined,
): Promise<void> {
  if (workspaceId === undefined) return
  const { workspace } = await workspaceFor(user, workspaceId, undefined, 'createProject')
  await assertWorkspaceAcceptsProjects(user, workspace)
}

interface WorkspaceMemberRow {
  user_id: string
  role: WorkspaceRole
  created_at: Date
  email: string
  full_name: string | null
  avatar_url: string | null
}

const ROLE_ORDER: Record<WorkspaceRole, number> = { owner: 0, admin: 1, member: 2 }

/**
 * Membres d'un workspace (tout membre) : propriétaire et administrateurs d'abord, puis par date
 * d'arrivée. Les emails ne vont qu'aux administrateurs (et chacun voit le sien), comme pour les
 * membres d'un projet. Les comptes supprimés n'y figurent plus.
 */
export async function workspaceMembers(
  user: User,
  workspaceId: string,
): Promise<WorkspaceMemberEntry[]> {
  const { workspace, role } = await workspaceFor(user, workspaceId)
  const manager = hasWorkspacePermission(role, 'manageProjects')
  const rows = (await db
    .from('workspace_members as m')
    .join('users as u', 'u.id', 'm.user_id')
    .where('m.workspace_id', workspace.id)
    .whereNull('u.deleted_at')
    .orderBy('m.created_at')
    .select(
      'm.user_id',
      'm.role',
      'm.created_at',
      'u.email',
      'u.full_name',
      'u.avatar_url',
    )) as WorkspaceMemberRow[]
  return rows
    .toSorted((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])
    .map((row) => ({
      user: {
        id: row.user_id,
        email: manager || row.user_id === user.id ? row.email : null,
        fullName: row.full_name,
        avatarUrl: row.avatar_url,
      },
      role: row.role,
      joinedAt: row.created_at.toISOString(),
    }))
}
