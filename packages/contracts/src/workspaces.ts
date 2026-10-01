import { z } from 'zod'

/** Workspace personnel (un par utilisateur) ou d'équipe (étape 3, Organisations Clerk). */
export const workspaceTypeSchema = z.enum(['personal', 'team'])
export type WorkspaceType = z.infer<typeof workspaceTypeSchema>

/** Rôle d'un membre de workspace (seul « owner » existe à l'étape 2). */
export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member'])
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>

/** Nom donné au workspace créé automatiquement pour chaque utilisateur. */
export const PERSONAL_WORKSPACE_NAME = 'Personal workspace'

/** Workspace renvoyé par l'API (`GET /workspaces`), avec le rôle de l'utilisateur courant. */
export const workspaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: workspaceTypeSchema,
  ownerId: z.uuid(),
  role: workspaceRoleSchema,
  createdAt: z.iso.datetime(),
})
export type Workspace = z.infer<typeof workspaceSchema>
