import {
  hasPermission,
  hasWorkspacePermission,
  type ProjectAiSettings,
  type WorkspaceAiSettings,
} from '@kaxolax/contracts'
import db from '@adonisjs/lucid/services/db'
import type User from '#models/user'
import { AiDisabledException } from '#services/claude/errors'
import { projectFor } from '#services/project_access'
import { WorkspaceForbiddenException, workspaceFor } from '#services/workspace_service'

/**
 * Activation de l'IA : réglage du projet (`projects.ai_enabled`, permission `manageAi` :
 * propriétaire, effectif compris) et de son workspace (`workspaces.ai_enabled`, permission de
 * workspace `manageAi` : propriétaire, administrateur d'équipe). L'IA ne sert un projet que si les
 * deux sont vrais.
 */

interface AiFlags {
  projectEnabled: boolean
  workspaceEnabled: boolean
  workspaceId: string
  workspaceType: string
  clerkOrganizationId: string | null
}

/** Workspace d'un projet servi par l'IA : comptage (ai_usage) et réserve de crédits débitée. */
export interface AiWorkspace {
  id: string
  type: string
  clerkOrganizationId: string | null
}

/** Réglages du projet et de son workspace, relus en base (null : projet inconnu). */
async function aiFlags(projectId: string): Promise<AiFlags | null> {
  const row = (await db
    .from('projects as p')
    .join('workspaces as w', 'w.id', 'p.workspace_id')
    .where('p.id', projectId)
    .select(
      'p.ai_enabled as project_enabled',
      'w.ai_enabled as workspace_enabled',
      'w.id as workspace_id',
      'w.type as workspace_type',
      'w.clerk_organization_id',
    )
    .first()) as {
    project_enabled: boolean
    workspace_enabled: boolean
    workspace_id: string
    workspace_type: string
    clerk_organization_id: string | null
  } | null
  if (!row) return null
  return {
    projectEnabled: row.project_enabled,
    workspaceEnabled: row.workspace_enabled,
    workspaceId: row.workspace_id,
    workspaceType: row.workspace_type,
    clerkOrganizationId: row.clerk_organization_id,
  }
}

/**
 * Refuse (403 `E_AI_DISABLED`, `scope` workspace d'abord) un appel à l'IA pour un projet dont
 * l'IA est désactivée, ou pour son workspace. Renvoie le workspace du projet (comptage, réserve
 * de crédits d'une équipe).
 */
export async function assertAiEnabled(project: { id: string }): Promise<AiWorkspace> {
  const flags = await aiFlags(project.id)
  if (flags?.workspaceEnabled !== true) throw new AiDisabledException('workspace')
  if (!flags.projectEnabled) throw new AiDisabledException('project')
  return {
    id: flags.workspaceId,
    type: flags.workspaceType,
    clerkOrganizationId: flags.clerkOrganizationId,
  }
}

/** Réglages vus par un membre du projet (`configured` : clé de l'API présente). */
export async function projectAiSettings(
  user: User,
  projectId: string,
  configured: boolean,
): Promise<ProjectAiSettings> {
  const { project, role } = await projectFor(user, projectId, 'read')
  const flags = await aiFlags(project.id)
  const projectEnabled = flags?.projectEnabled ?? false
  const workspaceEnabled = flags?.workspaceEnabled ?? false
  return {
    projectId: project.id,
    projectEnabled,
    workspaceEnabled,
    configured,
    enabled: configured && projectEnabled && workspaceEnabled,
    canManage: hasPermission(role, 'manageAi'),
  }
}

/** Active ou désactive l'IA du projet (propriétaire). */
export async function setProjectAi(
  user: User,
  projectId: string,
  enabled: boolean,
  configured: boolean,
): Promise<ProjectAiSettings> {
  const { project } = await projectFor(user, projectId, 'manageAi')
  if (project.aiEnabled !== enabled) {
    project.aiEnabled = enabled
    await project.save()
  }
  return projectAiSettings(user, project.id, configured)
}

/** Réglage du workspace vu par un de ses membres. */
export async function workspaceAiSettings(
  user: User,
  workspaceId: string,
  configured: boolean,
): Promise<WorkspaceAiSettings> {
  const { workspace, role } = await workspaceFor(user, workspaceId)
  return {
    workspaceId: workspace.id,
    enabled: workspace.aiEnabled,
    configured,
    canManage: hasWorkspacePermission(role, 'manageAi'),
  }
}

/** Active ou désactive l'IA pour tous les projets du workspace (propriétaire, admin d'équipe). */
export async function setWorkspaceAi(
  user: User,
  workspaceId: string,
  enabled: boolean,
  configured: boolean,
): Promise<WorkspaceAiSettings> {
  const { workspace, role } = await workspaceFor(user, workspaceId)
  if (!hasWorkspacePermission(role, 'manageAi')) throw new WorkspaceForbiddenException()
  if (workspace.aiEnabled !== enabled) {
    workspace.aiEnabled = enabled
    await workspace.save()
  }
  return { workspaceId: workspace.id, enabled: workspace.aiEnabled, configured, canManage: true }
}
