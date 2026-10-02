import { randomUUID } from 'node:crypto'
import type {
  AdminProjectDetail,
  AdminProjectSummary,
  AdminProjectsResponse,
  AdminProjectView,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import { ProjectNotTrashedException } from '#controllers/projects_controller'
import Compile from '#models/compile'
import Project from '#models/project'
import ProjectMember, { type ProjectRole } from '#models/project_member'
import User from '#models/user'
import Workspace from '#models/workspace'
import { type AdminAction, auditFailures, recordAdminAction } from '#services/admin_audit'
import { likePattern, paginationOf } from '#services/admin_users'
import { isoString, isoStringOrNull } from '#services/dates'
import type ObjectStorage from '#services/object_storage'
import { isUuid, ProjectNotFoundException } from '#services/project_access'
import { deleteProjectRows, releaseDeletedProject } from '#services/project_service'
import type RealtimeClient from '#services/realtime_client'
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

const ROLE_ORDER: Record<ProjectRole, number> = { owner: 0, editor: 1, reviewer: 2, viewer: 3 }

/**
 * Colonnes calculées en SQL, sans jamais lire le contenu : taille des fichiers binaires et des
 * états Yjs (octet_length), nombre de membres.
 */
const SIZE_SQL = `(SELECT COALESCE(SUM(f.size_bytes), 0) FROM files f WHERE f.project_id = projects.id)
  + (SELECT COALESCE(SUM(octet_length(d.yjs_state)), 0) FROM documents d WHERE d.project_id = projects.id)`
const MEMBER_COUNT_SQL = `(SELECT COUNT(*) FROM project_members pm WHERE pm.project_id = projects.id)`

interface SummaryExtras {
  owner_email: string
  owner_full_name: string | null
  size_bytes: string | number
  member_count: string | number
}

function summaryQuery(client?: TransactionClientContract) {
  return Project.query({ client })
    .join('users as owners', 'owners.id', 'projects.owner_id')
    .select('projects.*', 'owners.email as owner_email', 'owners.full_name as owner_full_name')
    .select(db.raw(`${SIZE_SQL} AS size_bytes`))
    .select(db.raw(`${MEMBER_COUNT_SQL} AS member_count`))
}

function serializeSummary(project: Project): AdminProjectSummary {
  const extras = project.$extras as SummaryExtras
  return {
    id: project.id,
    name: project.name,
    owner: { id: project.ownerId, email: extras.owner_email, fullName: extras.owner_full_name },
    workspaceId: project.workspaceId,
    compiler: project.compiler,
    sizeBytes: Number(extras.size_bytes),
    memberCount: Number(extras.member_count),
    archivedAt: isoStringOrNull(project.archivedAt),
    trashedAt: isoStringOrNull(project.trashedAt),
    lastCompiledAt: isoStringOrNull(project.lastCompiledAt),
    createdAt: isoString(project.createdAt),
    updatedAt: isoString(project.updatedAt),
  }
}

/**
 * Recherche par nom du projet, email ou nom du propriétaire (sous-chaîne, sans casse), ou par identifiant exact
 * du projet ou du propriétaire ; les plus récemment modifiés d'abord.
 */
export async function searchProjects(filters: {
  q?: string | undefined
  view: AdminProjectView
  page: number
  perPage: number
}): Promise<AdminProjectsResponse> {
  const term = filters.q?.trim() ?? ''
  const query = summaryQuery().orderBy('projects.updated_at', 'desc').orderBy('projects.id')
  if (filters.view === 'active') {
    void query.whereNull('projects.archived_at').whereNull('projects.trashed_at')
  }
  if (filters.view === 'archived') {
    void query.whereNotNull('projects.archived_at').whereNull('projects.trashed_at')
  }
  if (filters.view === 'trashed') void query.whereNotNull('projects.trashed_at')
  if (term !== '') {
    const pattern = likePattern(term)
    void query.where((search) => {
      void search
        .whereILike('projects.name', pattern)
        .orWhereILike('owners.email', pattern)
        .orWhereILike('owners.full_name', pattern)
      if (isUuid(term)) void search.orWhere('projects.id', term).orWhere('projects.owner_id', term)
    })
  }
  const page = await query.paginate(filters.page, filters.perPage)
  return { projects: page.all().map(serializeSummary), pagination: paginationOf(page) }
}

interface ContentCountsRow {
  files_bytes: string | number
  documents_bytes: string | number
  file_count: number
  document_count: number
  folder_count: number
}

/**
 * Fiche d'un projet : métadonnées, tailles et nombres calculés en SQL, membres, dernière
 * compilation et workspace. Aucun nom de fichier, aucun contenu.
 */
export async function projectDetail(projectId: string): Promise<AdminProjectDetail> {
  const project = isUuid(projectId)
    ? await summaryQuery().where('projects.id', projectId).first()
    : null
  if (!project) throw new ProjectNotFoundException()

  const workspace = await Workspace.findOrFail(project.workspaceId)
  const counts = await db.rawQuery<{ rows: ContentCountsRow[] }>(
    `SELECT
         (SELECT COALESCE(SUM(size_bytes), 0) FROM files WHERE project_id = ?) AS files_bytes,
         (SELECT COALESCE(SUM(octet_length(yjs_state)), 0) FROM documents WHERE project_id = ?)
           AS documents_bytes,
         (SELECT COUNT(*)::int FROM files WHERE project_id = ?) AS file_count,
         (SELECT COUNT(*)::int FROM documents WHERE project_id = ?) AS document_count,
         (SELECT COUNT(*)::int FROM folders WHERE project_id = ?) AS folder_count`,
    [project.id, project.id, project.id, project.id, project.id],
  )
  const members = await ProjectMember.query()
    .join('users', 'users.id', 'project_members.user_id')
    .where('project_members.project_id', project.id)
    .select('project_members.*', 'users.email as user_email', 'users.full_name as user_full_name')
    .orderBy('project_members.created_at')
  const lastCompile = await Compile.query()
    .where('project_id', project.id)
    .orderBy('created_at', 'desc')
    .first()
  const row = counts.rows[0]
  return {
    ...serializeSummary(project),
    workspace: {
      id: workspace.id,
      name: workspace.name,
      type: workspace.type,
      ownerId: workspace.ownerId,
    },
    storage: {
      filesBytes: Number(row?.files_bytes ?? 0),
      documentsBytes: Number(row?.documents_bytes ?? 0),
    },
    fileCount: row?.file_count ?? 0,
    documentCount: row?.document_count ?? 0,
    folderCount: row?.folder_count ?? 0,
    members: members
      .toSorted((a, b) => ROLE_ORDER[a.role] - ROLE_ORDER[b.role])
      .map((member) => {
        const extras = member.$extras as { user_email: string; user_full_name: string | null }
        return {
          user: { id: member.userId, email: extras.user_email, fullName: extras.user_full_name },
          role: member.role,
          createdAt: isoString(member.createdAt),
        }
      }),
    lastCompile: lastCompile
      ? {
          id: lastCompile.id,
          status: lastCompile.status,
          compiler: lastCompile.compiler,
          durationMs: lastCompile.durationMs,
          agentId: lastCompile.agentId,
          userId: lastCompile.userId,
          createdAt: isoString(lastCompile.createdAt),
        }
      : null,
  }
}

async function lockProject(projectId: string, trx: TransactionClientContract): Promise<Project> {
  const project = isUuid(projectId)
    ? await Project.query({ client: trx }).where('id', projectId).forUpdate().first()
    : null
  if (!project) throw new ProjectNotFoundException()
  return project
}

function projectMetadata(project: Project): Record<string, unknown> {
  return { name: project.name, ownerId: project.ownerId }
}

/**
 * Entrée d'échec d'une action sur un projet (journalisée par `auditFailures` en cas d'erreur
 * interne) : la cible n'est connue que par son identifiant, l'effet n'ayant pas eu lieu.
 */
function projectFailure(
  admin: User,
  action: AdminAction['action'],
  projectId: string,
): AdminAction {
  return { admin, action, targetType: 'project', targetId: isUuid(projectId) ? projectId : null }
}

export type ProjectStateAction =
  'project.archive' | 'project.unarchive' | 'project.trash' | 'project.restore'

/**
 * Archive, désarchive, met à la corbeille ou restaure un projet, avec l'entrée du journal dans la
 * même transaction. Un projet déjà dans l'état demandé ne change pas (rien n'est journalisé).
 * Le propriétaire voit le changement comme s'il l'avait fait lui-même.
 */
export async function changeProjectState(
  admin: User,
  projectId: string,
  action: ProjectStateAction,
): Promise<void> {
  const field =
    action === 'project.archive' || action === 'project.unarchive' ? 'archivedAt' : 'trashedAt'
  const set = action === 'project.archive' || action === 'project.trash'
  await auditFailures(projectFailure(admin, action, projectId), () =>
    db.transaction(async (trx) => {
      const project = await lockProject(projectId, trx)
      if ((project[field] !== null) === set) return
      project[field] = set ? DateTime.utc() : null
      await project.useTransaction(trx).save()
      await recordAdminAction(
        {
          admin,
          action,
          targetType: 'project',
          targetId: project.id,
          metadata: projectMetadata(project),
        },
        trx,
      )
    }),
  )
}

/**
 * Suppression définitive d'un projet mis à la corbeille (même règle que pour le propriétaire),
 * journalisée dans la transaction ; connexions et objets S3 libérés ensuite.
 */
export async function deleteProject(
  admin: User,
  projectId: string,
  deps: { realtime: RealtimeClient; storage: ObjectStorage },
): Promise<void> {
  const deleted = await auditFailures(projectFailure(admin, 'project.delete', projectId), () =>
    db.transaction(async (trx) => {
      const project = await lockProject(projectId, trx)
      if (project.trashedAt === null) throw new ProjectNotTrashedException()
      const metadata = projectMetadata(project)
      const rows = await deleteProjectRows(project, trx)
      await recordAdminAction(
        {
          admin,
          action: 'project.delete',
          targetType: 'project',
          targetId: rows.projectId,
          metadata,
        },
        trx,
      )
      return rows
    }),
  )
  await releaseDeletedProject(deleted, deps)
}

/**
 * Transfère un projet à un compte existant : il en devient propriétaire (membre ajouté au besoin),
 * l'ancien propriétaire devient éditeur, et le projet rejoint le workspace personnel du nouveau.
 * Projet et membres sont verrouillés le temps de la transaction, journal compris.
 */
export async function transferProject(
  admin: User,
  projectId: string,
  newOwnerId: string,
): Promise<void> {
  const failure = projectFailure(admin, 'project.transfer', projectId)
  await auditFailures({ ...failure, metadata: { toUserId: newOwnerId } }, () =>
    db.transaction(async (trx) => {
      const project = await lockProject(projectId, trx)
      const newOwner = await User.query({ client: trx }).where('id', newOwnerId).first()
      // Un compte banni ne peut pas devenir propriétaire : le projet n'aurait plus de propriétaire actif.
      if (!newOwner || newOwner.deletedAt || newOwner.bannedAt) throw new InvalidNewOwnerException()
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
      const workspace = await ensurePersonalWorkspace(newOwner, trx)
      project.merge({ ownerId: newOwner.id, workspaceId: workspace.id })
      await project.useTransaction(trx).save()

      await recordAdminAction(
        {
          admin,
          action: 'project.transfer',
          targetType: 'project',
          targetId: project.id,
          metadata: {
            name: project.name,
            fromUserId: previous.ownerId,
            toUserId: newOwner.id,
            fromWorkspaceId: previous.workspaceId,
            toWorkspaceId: workspace.id,
          },
        },
        trx,
      )
    }),
  )
}
