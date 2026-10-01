import { DEFAULT_SPELLCHECK_LANGUAGE } from '@kaxolax/contracts'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { type DateTime } from 'luxon'
import Document from '#models/document'
import Project from '#models/project'
import ProjectMember, { type ProjectRole } from '#models/project_member'
import type User from '#models/user'
import { starterDocument } from '#services/latex'
import type ObjectStorage from '#services/object_storage'
import { projectPrefix } from '#services/object_storage'
import type RealtimeClient from '#services/realtime_client'
import { createDocument } from '#services/tree_service'
import { workspaceFor, workspaceForNewProject } from '#services/workspace_service'

export type ProjectView = 'active' | 'archived' | 'trashed'

/** Date ISO en UTC ; une colonne absente d'un modèle tout juste créé vaut null. */
function iso(value: DateTime | null | undefined): string | null {
  return value ? value.toUTC().toISO() : null
}

export function serializeProject(project: Project, role: ProjectRole) {
  return {
    id: project.id,
    workspaceId: project.workspaceId,
    name: project.name,
    compiler: project.compiler,
    mainDocumentId: project.mainDocumentId,
    spellcheckLanguage: project.spellcheckLanguage,
    role,
    archivedAt: iso(project.archivedAt),
    trashedAt: iso(project.trashedAt),
    lastCompiledAt: iso(project.lastCompiledAt),
    createdAt: iso(project.createdAt),
    updatedAt: iso(project.updatedAt),
  }
}

/**
 * Crée un projet, son propriétaire dans project_members et un main.tex minimal qui compile. Le
 * projet rejoint le workspace demandé (l'utilisateur doit en être membre), sinon son workspace
 * personnel.
 */
export async function createProject(
  user: User,
  name: string,
  workspaceId?: string,
): Promise<Project> {
  return db.transaction(async (trx) => {
    const workspace = await workspaceForNewProject(user, workspaceId, trx)
    const project = await Project.create(
      {
        ownerId: user.id,
        workspaceId: workspace.id,
        name,
        compiler: 'pdflatex',
        spellcheckLanguage: DEFAULT_SPELLCHECK_LANGUAGE,
      },
      { client: trx },
    )
    await ProjectMember.create(
      { projectId: project.id, userId: user.id, role: 'owner' },
      { client: trx },
    )
    const main = await createDocument(trx, project.id, {
      name: 'main.tex',
      folderId: null,
      content: starterDocument(name, user.fullName),
    })
    project.mainDocumentId = main.id
    await project.useTransaction(trx).save()
    return project
  })
}

/**
 * Projets dont l'utilisateur est membre, filtrés par vue, par nom et éventuellement par workspace
 * (dont il doit être membre, sinon 404). Sans workspace : tous ses projets, partagés compris.
 */
export async function listProjects(
  user: User,
  filters: { view: ProjectView; search?: string | undefined; workspaceId?: string | undefined },
) {
  const { view, search, workspaceId } = filters
  if (workspaceId !== undefined) await workspaceFor(user, workspaceId)
  const query = Project.query()
    .join('project_members', 'project_members.project_id', 'projects.id')
    .where('project_members.user_id', user.id)
    .select('projects.*', 'project_members.role as member_role')
    .orderBy('projects.updated_at', 'desc')
  if (view === 'active')
    void query.whereNull('projects.archived_at').whereNull('projects.trashed_at')
  if (view === 'archived')
    void query.whereNotNull('projects.archived_at').whereNull('projects.trashed_at')
  if (view === 'trashed') void query.whereNotNull('projects.trashed_at')
  if (workspaceId !== undefined) void query.where('projects.workspace_id', workspaceId)
  if (search !== undefined && search.trim() !== '') {
    const pattern = `%${search.trim().replace(/[\\%_]/g, (character) => `\\${character}`)}%`
    void query.whereILike('projects.name', pattern)
  }
  const projects = await query
  return projects.map((project) =>
    serializeProject(project, (project.$extras as { member_role: ProjectRole }).member_role),
  )
}

/** Ce qu'il reste à libérer hors de la base après la suppression d'un projet. */
export interface DeletedProject {
  projectId: string
  documentIds: string[]
}

/**
 * Supprime un projet de la base (transaction de l'appelant si fournie). Les connexions temps réel
 * et les objets S3 se libèrent ensuite avec `releaseDeletedProject`, une fois la transaction validée.
 */
export async function deleteProjectRows(
  project: Project,
  trx?: TransactionClientContract,
): Promise<DeletedProject> {
  const documents = await Document.query({ client: trx })
    .where('projectId', project.id)
    .select('id')
  if (trx) project.useTransaction(trx)
  await project.delete()
  return { projectId: project.id, documentIds: documents.map((document) => document.id) }
}

/** Ferme les documents ouverts et efface les objets S3 d'un projet supprimé (au mieux). */
export async function releaseDeletedProject(
  deleted: DeletedProject,
  services: { realtime: RealtimeClient; storage: ObjectStorage },
): Promise<void> {
  await services.realtime.closeDocuments(deleted.documentIds)
  await services.storage.deletePrefix(projectPrefix(deleted.projectId))
}
