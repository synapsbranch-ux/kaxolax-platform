import { z } from 'zod'

/** Workspace personnel (un par utilisateur) ou d'équipe (étape 3, Organisations Clerk). */
export const workspaceTypeSchema = z.enum(['personal', 'team'])
export type WorkspaceType = z.infer<typeof workspaceTypeSchema>

/** Rôle d'un membre de workspace (seul « owner » existe à l'étape 2). */
export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member'])
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>

/**
 * Matrice des permissions d'un workspace (comme celle des projets, permissions.ts) : tout membre
 * le voit ; seul le propriétaire active ou désactive l'IA pour tous ses projets. Les rôles
 * d'équipe (tâche 10) y ajouteront leurs droits.
 */
export const WORKSPACE_PERMISSIONS = [
  /** Voir le workspace et ses réglages. */
  'read',
  /** Activer ou désactiver l'IA pour tous les projets du workspace. */
  'manageAi',
] as const
export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number]

const WORKSPACE_MATRIX: Record<WorkspaceRole, ReadonlySet<WorkspacePermission>> = {
  owner: new Set<WorkspacePermission>(['read', 'manageAi']),
  admin: new Set<WorkspacePermission>(['read']),
  member: new Set<WorkspacePermission>(['read']),
}

/** Vrai si le rôle de workspace accorde la permission. */
export function hasWorkspacePermission(
  role: WorkspaceRole,
  permission: WorkspacePermission,
): boolean {
  return WORKSPACE_MATRIX[role].has(permission)
}

/** Nom donné au workspace créé automatiquement pour chaque utilisateur. */
export const PERSONAL_WORKSPACE_NAME = 'Personal workspace'

/** Workspace renvoyé par l'API (`GET /workspaces`), avec le rôle de l'utilisateur courant. */
export const workspaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: workspaceTypeSchema,
  ownerId: z.uuid(),
  role: workspaceRoleSchema,
  /** IA activée pour les projets du workspace (réglage du propriétaire). */
  aiEnabled: z.boolean(),
  createdAt: z.iso.datetime(),
})
export type Workspace = z.infer<typeof workspaceSchema>
