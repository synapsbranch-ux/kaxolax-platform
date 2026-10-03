import { z } from 'zod'
import { type AssignableRole, assignableRoleSchema } from './permissions.js'
import { type ProjectRole } from './realtime.js'

/** Workspace personnel (un par utilisateur) ou d'équipe (une Organisation Clerk). */
export const workspaceTypeSchema = z.enum(['personal', 'team'])
export type WorkspaceType = z.infer<typeof workspaceTypeSchema>

/**
 * Rôle d'un membre de workspace : `owner` pour le workspace personnel ; `admin` et `member` pour
 * un workspace d'équipe (rôles Clerk `org:admin` et `org:member`).
 */
export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member'])
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>

/**
 * Matrice des permissions d'un workspace (comme celle des projets, permissions.ts) :
 * - owner (personnel) et admin (équipe) : tout ;
 * - member (équipe) : voir le workspace et y créer ou déplacer ses projets.
 * Les membres d'une équipe se gèrent dans Clerk (`<OrganizationProfile />`), jamais ici.
 */
export const WORKSPACE_PERMISSIONS = [
  /** Voir le workspace, ses membres et ses réglages. */
  'read',
  /** Créer un projet dans le workspace, ou y déplacer un de ses projets personnels. */
  'createProject',
  /** Activer ou désactiver l'IA pour tous les projets du workspace. */
  'manageAi',
  /**
   * Gérer tous les projets du workspace comme leur propriétaire (rôle de projet dérivé `owner`,
   * voir `teamProjectRole`).
   */
  'manageProjects',
] as const
export type WorkspacePermission = (typeof WORKSPACE_PERMISSIONS)[number]

const WORKSPACE_MATRIX: Record<WorkspaceRole, ReadonlySet<WorkspacePermission>> = {
  owner: new Set<WorkspacePermission>(['read', 'createProject', 'manageAi', 'manageProjects']),
  admin: new Set<WorkspacePermission>(['read', 'createProject', 'manageAi', 'manageProjects']),
  member: new Set<WorkspacePermission>(['read', 'createProject']),
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

// --- Équipes (Organisations Clerk) -----------------------------------------------------------

/** Rôle Clerk d'administrateur d'une organisation (les autres rôles donnent `member`). */
export const CLERK_ORG_ADMIN_ROLE = 'org:admin'

/**
 * Rôle de workspace d'un membre d'organisation : `org:admin` (ou `admin`, forme courte du claim
 * `o.rol` du jeton v2) donne `admin` ; tout autre rôle, personnalisé compris, `member`.
 */
export function workspaceRoleFromClerk(clerkRole: string): 'admin' | 'member' {
  return clerkRole === CLERK_ORG_ADMIN_ROLE || clerkRole === 'admin' ? 'admin' : 'member'
}

/**
 * Rôle accordé aux membres `member` d'une équipe sur un projet du workspace, réglable par projet
 * (`projects.team_role`) ; `editor` par défaut. Les invitations individuelles restent possibles
 * et le membre garde le plus élevé des deux rôles.
 */
export const teamMemberRoleSchema = assignableRoleSchema
export type TeamMemberRole = AssignableRole
export const DEFAULT_TEAM_MEMBER_ROLE: TeamMemberRole = 'editor'

/**
 * Rôle de projet dérivé de l'appartenance à l'équipe : un administrateur (ou propriétaire) du
 * workspace est propriétaire effectif de tous ses projets ; un membre reçoit le rôle d'équipe du
 * projet. Même règle que la vue SQL `project_access_roles` (API et service temps réel).
 */
export function teamProjectRole(
  workspaceRole: WorkspaceRole,
  projectTeamRole: TeamMemberRole,
): ProjectRole {
  return hasWorkspacePermission(workspaceRole, 'manageProjects') ? 'owner' : projectTeamRole
}

/** Workspace renvoyé par l'API (`GET /workspaces`), avec le rôle de l'utilisateur courant. */
export const workspaceSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  type: workspaceTypeSchema,
  ownerId: z.uuid(),
  role: workspaceRoleSchema,
  /** IA activée pour les projets du workspace (réglage du propriétaire). */
  aiEnabled: z.boolean(),
  /** Organisation Clerk (`org_…`) d'un workspace d'équipe ; null pour le personnel. */
  clerkOrganizationId: z.string().nullable(),
  /** Slug de l'organisation Clerk ; null pour le personnel. */
  slug: z.string().nullable(),
  /** Membres du workspace (sièges d'une équipe ; 1 pour le personnel). */
  memberCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
})
export type Workspace = z.infer<typeof workspaceSchema>

/** `GET /workspaces` : le personnel d'abord, puis les équipes par nom. */
export const workspacesResponseSchema = z.object({ workspaces: z.array(workspaceSchema) })
export type WorkspacesResponse = z.infer<typeof workspacesResponseSchema>

/** Membre d'un workspace (`GET /workspaces/:id/members`). */
export const workspaceMemberSchema = z.object({
  user: z.object({
    id: z.uuid(),
    /** Visible des seuls administrateurs (et du membre lui-même) ; null sinon. */
    email: z.string().nullable(),
    fullName: z.string().nullable(),
    avatarUrl: z.string().nullable(),
  }),
  role: workspaceRoleSchema,
  joinedAt: z.iso.datetime(),
})
export type WorkspaceMemberEntry = z.infer<typeof workspaceMemberSchema>

/** `GET /workspaces/:id/members` (tout membre) : administrateurs d'abord, puis par arrivée. */
export const workspaceMembersResponseSchema = z.object({
  members: z.array(workspaceMemberSchema),
})
export type WorkspaceMembersResponse = z.infer<typeof workspaceMembersResponseSchema>

/**
 * `POST /projects/:id/move` : déplace un projet personnel vers un workspace d'équipe dont le
 * propriétaire du projet est membre (limites du plan de l'équipe vérifiées).
 */
export const moveProjectInputSchema = z.object({ workspaceId: z.uuid() })
export type MoveProjectInput = z.infer<typeof moveProjectInputSchema>

/** `PUT /projects/:id/team-access` : rôle des membres de l'équipe sur ce projet. */
export const teamAccessInputSchema = z.object({ role: teamMemberRoleSchema })
export type TeamAccessInput = z.infer<typeof teamAccessInputSchema>

/** Accès d'équipe d'un projet (réponse de `PUT /projects/:id/team-access`). */
export const teamAccessSchema = z.object({
  projectId: z.uuid(),
  workspaceId: z.uuid(),
  role: teamMemberRoleSchema,
})
export type TeamAccess = z.infer<typeof teamAccessSchema>

/**
 * `POST /workspaces/sync` : rattrapage à la demande de l'organisation active de la session (claim
 * `o.id`) depuis l'API Backend de Clerk, quand le webhook tarde ou n'arrive pas (création d'une
 * équipe, invitation acceptée). `workspace` : le workspace d'équipe de l'appelant, null s'il n'en
 * est pas (encore) membre d'après Clerk.
 */
export const workspaceSyncResponseSchema = z.object({ workspace: workspaceSchema.nullable() })
export type WorkspaceSyncResponse = z.infer<typeof workspaceSyncResponseSchema>

/** Codes d'erreur des workspaces d'équipe (`code` du corps de la réponse). */
export const WORKSPACE_ERRORS = {
  /** 404 : workspace inconnu ou dont l'utilisateur n'est pas membre. */
  notFound: 'E_WORKSPACE_NOT_FOUND',
  /** 403 : rôle de workspace insuffisant. */
  forbidden: 'E_WORKSPACE_FORBIDDEN',
  /** 422 : déplacement impossible (cible personnelle, projet déjà d'équipe, même workspace). */
  invalidMove: 'E_INVALID_PROJECT_MOVE',
  /** 422 : le projet n'est pas dans un workspace d'équipe (accès d'équipe). */
  notTeamProject: 'E_NOT_TEAM_PROJECT',
  /** 422 : un projet d'équipe ne peut être transféré qu'à un membre de l'équipe. */
  newOwnerNotInTeam: 'E_NEW_OWNER_NOT_IN_TEAM',
  /** 422 : la session n'a pas d'organisation active (`POST /workspaces/sync`). */
  noActiveOrganization: 'E_NO_ACTIVE_ORGANIZATION',
} as const

// --- Webhooks Organisations de Clerk (sous-ensemble lu par l'API) ----------------------------

/** Organisation (`data` des événements `organization.created` et `organization.updated`). */
export const clerkOrganizationSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(255),
  slug: z.string().max(255).nullish(),
  /** Compte Clerk créateur (absent pour une organisation créée par l'API Backend). */
  created_by: z.string().min(1).max(64).nullish(),
  /** Millisecondes. */
  updated_at: z.number().nullish(),
})
export type ClerkOrganizationData = z.infer<typeof clerkOrganizationSchema>

/** Objet supprimé (`data` de `organization.deleted`). */
export const clerkDeletedObjectSchema = z.object({
  id: z.string().min(1).max(64),
  deleted: z.boolean().nullish(),
})

/** Adhésion (`data` des événements `organizationMembership.*`). */
export const clerkOrganizationMembershipSchema = z.object({
  id: z.string().min(1).max(64),
  /** Rôle Clerk : `org:admin`, `org:member` ou rôle personnalisé. */
  role: z.string().min(1).max(64),
  organization: clerkOrganizationSchema,
  public_user_data: z.object({ user_id: z.string().min(1).max(64) }),
  updated_at: z.number().nullish(),
})
export type ClerkOrganizationMembershipData = z.infer<typeof clerkOrganizationMembershipSchema>
