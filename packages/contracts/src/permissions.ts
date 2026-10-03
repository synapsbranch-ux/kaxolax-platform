import { type ProjectRole, projectRoleSchema } from './realtime.js'

/**
 * Matrice des permissions d'un projet, seule source de vérité partagée par l'API, le service
 * temps réel et l'interface. Fonctions pures, sans état.
 *
 * - owner : tout, y compris membres, liens de partage, transfert, renommage, archivage, suppression,
 *   activation de l'IA ;
 * - editor : lit, édite, compile, commente ;
 * - reviewer : lit, compile, commente ;
 * - viewer : lit et compile.
 */

export const PROJECT_PERMISSIONS = [
  /** Ouvrir le projet, lire l'arborescence et les fichiers, télécharger les sources. */
  'read',
  /** Lancer, arrêter une compilation, vider le cache, SyncTeX. */
  'compile',
  /** Commenter (fils de discussion du panneau Review). */
  'comment',
  /** Modifier le texte, l'arborescence, les fichiers et les réglages d'édition du projet. */
  'edit',
  /** Inviter, changer un rôle, retirer un membre, relancer ou annuler une invitation. */
  'manageMembers',
  /** Activer, désactiver, régénérer les liens de partage. */
  'manageShareLinks',
  /** Transférer la propriété à un membre existant. */
  'transferOwnership',
  /** Renommer, archiver, mettre à la corbeille, restaurer, supprimer le projet. */
  'manageProject',
  /** Activer ou désactiver l'IA pour le projet. */
  'manageAi',
  /** Quitter le projet de soi-même (le propriétaire doit d'abord transférer la propriété). */
  'leave',
] as const
export type ProjectPermission = (typeof PROJECT_PERMISSIONS)[number]

const MATRIX: Record<ProjectRole, ReadonlySet<ProjectPermission>> = {
  owner: new Set<ProjectPermission>([
    'read',
    'compile',
    'comment',
    'edit',
    'manageMembers',
    'manageShareLinks',
    'transferOwnership',
    'manageProject',
    'manageAi',
  ]),
  editor: new Set<ProjectPermission>(['read', 'compile', 'comment', 'edit', 'leave']),
  reviewer: new Set<ProjectPermission>(['read', 'compile', 'comment', 'leave']),
  viewer: new Set<ProjectPermission>(['read', 'compile', 'leave']),
}

/** Rang de chaque rôle, du plus faible au plus élevé. */
export const PROJECT_ROLE_RANK: Readonly<Record<ProjectRole, number>> = {
  viewer: 0,
  reviewer: 1,
  editor: 2,
  owner: 3,
}

/** Rôles qu'une invitation, un lien de partage ou un changement de rôle peut donner. */
export const ASSIGNABLE_ROLES = ['editor', 'reviewer', 'viewer'] as const
export const assignableRoleSchema = projectRoleSchema.extract(ASSIGNABLE_ROLES)
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number]

/** Vrai si le rôle accorde la permission. */
export function hasPermission(role: ProjectRole, permission: ProjectPermission): boolean {
  return MATRIX[role].has(permission)
}

/** Permissions d'un rôle, dans l'ordre de `PROJECT_PERMISSIONS` (affichage, sérialisation). */
export function permissionsOf(role: ProjectRole): ProjectPermission[] {
  return PROJECT_PERMISSIONS.filter((permission) => MATRIX[role].has(permission))
}

export const canRead = (role: ProjectRole): boolean => hasPermission(role, 'read')
export const canCompile = (role: ProjectRole): boolean => hasPermission(role, 'compile')
export const canComment = (role: ProjectRole): boolean => hasPermission(role, 'comment')
/** Vrai si le rôle modifie le texte : sinon, connexion temps réel en lecture seule. */
export const canEdit = (role: ProjectRole): boolean => hasPermission(role, 'edit')
export const canManageMembers = (role: ProjectRole): boolean => hasPermission(role, 'manageMembers')
export const canManageShareLinks = (role: ProjectRole): boolean =>
  hasPermission(role, 'manageShareLinks')
export const canTransferOwnership = (role: ProjectRole): boolean =>
  hasPermission(role, 'transferOwnership')
export const canManageProject = (role: ProjectRole): boolean => hasPermission(role, 'manageProject')
export const canManageAi = (role: ProjectRole): boolean => hasPermission(role, 'manageAi')
export const canLeave = (role: ProjectRole): boolean => hasPermission(role, 'leave')

/** Vrai si `role` vaut au moins `minimum` (owner > editor > reviewer > viewer). */
export function isRoleAtLeast(role: ProjectRole, minimum: ProjectRole): boolean {
  return PROJECT_ROLE_RANK[role] >= PROJECT_ROLE_RANK[minimum]
}

/** Le plus élevé des deux rôles (un membre qui rejoint par un lien garde le plus élevé). */
export function higherRole<A extends ProjectRole, B extends ProjectRole>(a: A, b: B): A | B {
  return PROJECT_ROLE_RANK[b] > PROJECT_ROLE_RANK[a] ? b : a
}
