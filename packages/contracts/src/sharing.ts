import { z } from 'zod'
import { assignableRoleSchema } from './permissions.js'
import { projectRoleSchema } from './realtime.js'

/**
 * Partage d'un projet : invitations par email, membres, transfert de propriété et liens de
 * partage. Contrats des routes `/api/v1/projects/:id/{members,invitations,share-links,transfer}`,
 * `/api/v1/invitations/:token` et `/api/v1/share/:token`. Dates ISO 8601 en UTC.
 */

const isoDate = z.iso.datetime()
const count = z.number().int().nonnegative()

/** Durée de validité d'une invitation (renouvelée à chaque relance). */
export const INVITATION_TTL_DAYS = 7
/** Délai minimal entre deux envois d'une même invitation (429 sinon). */
export const INVITATION_RESEND_INTERVAL_SECONDS = 60
/** Nombre maximal d'envois d'une même invitation, création comprise (429 au-delà). */
export const INVITATION_MAX_SENDS = 10
/**
 * Invitations créées au plus par un même compte sur une heure glissante, tous projets confondus,
 * annulées comprises (429 au-delà).
 */
export const INVITATIONS_PER_HOUR = 30

/** Codes d'erreur propres au partage (`code` du corps de la réponse). */
export const SHARING_ERRORS = {
  /** 403 : limite de collaborateurs du plan du propriétaire atteinte (`limit` dans le corps). */
  planLimit: 'E_PLAN_LIMIT',
  /** 409 : la personne invitée est déjà membre. */
  alreadyMember: 'E_ALREADY_MEMBER',
  /**
   * 404 : invitation inconnue, annulée, remplacée par une relance, ou déjà acceptée par un autre
   * compte (pour le compte invité, l'acceptation est idempotente).
   */
  invitationNotFound: 'E_INVITATION_NOT_FOUND',
  /** 410 : invitation expirée ; le propriétaire peut la relancer. */
  invitationExpired: 'E_INVITATION_EXPIRED',
  /**
   * 502 : l'email n'est pas parti ; rien n'a changé (invitation nouvelle non créée, lien précédent
   * toujours valide, envoi non compté) : réessayer plus tard.
   */
  invitationEmailFailed: 'E_INVITATION_EMAIL_FAILED',
  /** 403 : l'email vérifié du compte connecté n'est pas celui de l'invitation. */
  invitationEmailMismatch: 'E_INVITATION_EMAIL_MISMATCH',
  /** 429 : relance trop rapprochée ou trop d'envois (`retryAfterSeconds` si connu). */
  tooManyInvitations: 'E_TOO_MANY_INVITATIONS',
  /** 404 : lien de partage inconnu, désactivé ou régénéré depuis. */
  shareLinkNotFound: 'E_SHARE_LINK_NOT_FOUND',
  /** 404 : membre inconnu dans ce projet. */
  memberNotFound: 'E_MEMBER_NOT_FOUND',
  /** 409 : le rôle du propriétaire ne change que par un transfert de propriété. */
  ownerRoleLocked: 'E_OWNER_ROLE_LOCKED',
  /** 409 : le propriétaire ne quitte pas son projet (transférer d'abord). */
  ownerCannotLeave: 'E_OWNER_CANNOT_LEAVE',
  /** 422 : le nouveau propriétaire doit être un membre actif (ni banni ni supprimé). */
  invalidNewOwner: 'E_INVALID_NEW_OWNER',
  /** 409 : transfert vers le propriétaire actuel. */
  alreadyOwner: 'E_ALREADY_OWNER',
  /** 403 : rôle insuffisant pour l'action (contrôle commun à toutes les routes de projet). */
  forbidden: 'E_PROJECT_FORBIDDEN',
} as const

// --- Limite du plan -------------------------------------------------------------------------

/** Collaborateurs (membres autres que le propriétaire et invitations en attente) et limite. */
export const collaboratorUsageSchema = z.object({
  /** Slug du plan Clerk du propriétaire (`free` sans abonnement). */
  plan: z.string(),
  /** Null : illimité. */
  max: count.nullable(),
  used: count,
})
export type CollaboratorUsage = z.infer<typeof collaboratorUsageSchema>

/** Corps d'un refus 403 `E_PLAN_LIMIT` : l'interface affiche la limite et le lien des tarifs. */
export const planLimitErrorSchema = z.object({
  code: z.literal('E_PLAN_LIMIT'),
  message: z.string(),
  limit: z.object({
    name: z.literal('collaborators'),
    plan: z.string(),
    max: count,
  }),
})
export type PlanLimitError = z.infer<typeof planLimitErrorSchema>

/** Corps d'un refus 429 `E_TOO_MANY_INVITATIONS`. */
export const tooManyInvitationsErrorSchema = z.object({
  code: z.literal('E_TOO_MANY_INVITATIONS'),
  message: z.string(),
  /** Attente avant un nouvel essai ; null si la limite est définitive (trop d'envois). */
  retryAfterSeconds: count.nullable(),
})
export type TooManyInvitationsError = z.infer<typeof tooManyInvitationsErrorSchema>

// --- Membres et invitations -----------------------------------------------------------------

/** Compte cité par une ressource du partage (membre, auteur d'une invitation). */
export const sharingUserSchema = z.object({
  id: z.uuid(),
  /**
   * Visible du propriétaire (qui gère les membres) et du membre lui-même ; null pour les autres
   * rôles (un lien de partage public ne donne pas les adresses des collaborateurs).
   */
  email: z.string().nullable(),
  fullName: z.string().nullable(),
  avatarUrl: z.string().nullable(),
})
export type SharingUser = z.infer<typeof sharingUserSchema>

/** Membre d'un projet. */
export const projectMemberSchema = z.object({
  user: sharingUserSchema,
  role: projectRoleSchema,
  joinedAt: isoDate,
})
export type ProjectMemberEntry = z.infer<typeof projectMemberSchema>

/** Invitation en attente (non acceptée ; `expired` si sa date est passée). */
export const projectInvitationSchema = z.object({
  id: z.uuid(),
  email: z.string(),
  role: assignableRoleSchema,
  invitedBy: z.object({ id: z.uuid(), fullName: z.string().nullable() }),
  createdAt: isoDate,
  lastSentAt: isoDate,
  expiresAt: isoDate,
  expired: z.boolean(),
})
export type ProjectInvitationEntry = z.infer<typeof projectInvitationSchema>

/**
 * `GET /projects/:id/members` (tout membre). Le propriétaire reçoit aussi les invitations en
 * attente et l'usage de sa limite ; les autres membres, une liste vide et `collaborators: null`.
 */
export const projectMembersResponseSchema = z.object({
  /** Propriétaire d'abord, puis par rôle, puis par date d'arrivée. */
  members: z.array(projectMemberSchema),
  invitations: z.array(projectInvitationSchema),
  collaborators: collaboratorUsageSchema.nullable(),
})
export type ProjectMembersResponse = z.infer<typeof projectMembersResponseSchema>

/** `GET /projects/:id/invitations` (propriétaire) : invitations en attente, les plus récentes d'abord. */
export const projectInvitationsResponseSchema = z.object({
  invitations: z.array(projectInvitationSchema),
})
export type ProjectInvitationsResponse = z.infer<typeof projectInvitationsResponseSchema>

/** `POST /projects/:id/invitations` (propriétaire). Email ramené en minuscules par l'API. */
export const createInvitationInputSchema = z.object({
  email: z.email().max(254),
  role: assignableRoleSchema,
})
export type CreateInvitationInput = z.infer<typeof createInvitationInputSchema>

/**
 * Réponse de la création (201, ou 200 si une invitation en attente pour cet email a été mise à
 * jour et renvoyée) et de la relance.
 */
export const invitationResponseSchema = z.object({ invitation: projectInvitationSchema })
export type InvitationResponse = z.infer<typeof invitationResponseSchema>

/** `PATCH /projects/:id/members/:userId` (propriétaire). */
export const updateMemberRoleInputSchema = z.object({ role: assignableRoleSchema })
export type UpdateMemberRoleInput = z.infer<typeof updateMemberRoleInputSchema>

export const memberResponseSchema = z.object({ member: projectMemberSchema })
export type MemberResponse = z.infer<typeof memberResponseSchema>

/**
 * `POST /projects/:id/transfer` (propriétaire) : vers un membre existant. Réponse : la liste des
 * membres vue par l'ancien propriétaire, devenu éditeur (`projectMembersResponseSchema`).
 */
export const transferOwnershipInputSchema = z.object({ userId: z.uuid() })
export type TransferOwnershipInput = z.infer<typeof transferOwnershipInputSchema>

// --- Accès par jeton (invitation, lien de partage) ------------------------------------------

/** `GET /invitations/:token` (public) : de quoi afficher la page d'invitation, rien de plus. */
export const invitationPreviewSchema = z.object({
  projectName: z.string(),
  /** Nom de l'invitant, null s'il n'en a pas (jamais son email). */
  inviterName: z.string().nullable(),
  role: assignableRoleSchema,
  expiresAt: isoDate,
  /**
   * Déjà acceptée (par exemple automatiquement à l'inscription) : la page appelle quand même
   * `POST /invitations/:token/accept`, idempotent pour le compte invité, pour connaître le projet.
   */
  accepted: z.boolean(),
})
export type InvitationPreview = z.infer<typeof invitationPreviewSchema>

/**
 * `POST /invitations/:token/accept` et `POST /share/:token/join` : projet rejoint et rôle obtenu.
 * `joined` est faux si le compte était déjà membre avec un rôle au moins aussi élevé, ou si
 * l'invitation était déjà acceptée par ce compte (rôle actuel dans `role`).
 */
export const joinProjectResponseSchema = z.object({
  projectId: z.uuid(),
  role: projectRoleSchema,
  joined: z.boolean(),
})
export type JoinProjectResponse = z.infer<typeof joinProjectResponseSchema>

/** Corps d'un refus 403 `E_INVITATION_EMAIL_MISMATCH` : email invité masqué (`a***@exemple.fr`). */
export const invitationEmailMismatchErrorSchema = z.object({
  code: z.literal('E_INVITATION_EMAIL_MISMATCH'),
  message: z.string(),
  invitedEmailHint: z.string(),
})
export type InvitationEmailMismatchError = z.infer<typeof invitationEmailMismatchErrorSchema>

// --- Liens de partage -----------------------------------------------------------------------

export const SHARE_LINK_KINDS = ['view', 'edit'] as const
export const shareLinkKindSchema = z.enum(SHARE_LINK_KINDS)
export type ShareLinkKind = z.infer<typeof shareLinkKindSchema>

/** Rôle donné par chaque type de lien. */
export const SHARE_LINK_ROLES = { view: 'viewer', edit: 'editor' } as const satisfies Record<
  ShareLinkKind,
  z.infer<typeof assignableRoleSchema>
>

/** État d'un lien de partage, tel que le voit le propriétaire. */
export const shareLinkSchema = z.object({
  kind: shareLinkKindSchema,
  role: assignableRoleSchema,
  enabled: z.boolean(),
  /** `${APP_URL}/share/<jeton>` ; null si le lien n'a jamais été activé. */
  url: z.string().nullable(),
  /** Date de la dernière (ré)génération du jeton ; null si jamais activé. */
  createdAt: isoDate.nullable(),
})
export type ShareLinkState = z.infer<typeof shareLinkSchema>

/** `GET /projects/:id/share-links` (propriétaire) : toujours les deux types, `view` d'abord. */
export const shareLinksResponseSchema = z.object({ links: z.array(shareLinkSchema) })
export type ShareLinksResponse = z.infer<typeof shareLinksResponseSchema>

/** `PUT /projects/:id/share-links/:kind` (propriétaire) : active ou désactive le lien. */
export const updateShareLinkInputSchema = z.object({ enabled: z.boolean() })
export type UpdateShareLinkInput = z.infer<typeof updateShareLinkInputSchema>

/** Réponse de `PUT …/share-links/:kind` et `POST …/share-links/:kind/regenerate`. */
export const shareLinkResponseSchema = z.object({ link: shareLinkSchema })
export type ShareLinkResponse = z.infer<typeof shareLinkResponseSchema>

/** `GET /share/:token` (public) : nom du projet et rôle donné, pour la page « Rejoindre ». */
export const shareLinkPreviewSchema = z.object({
  projectName: z.string(),
  role: assignableRoleSchema,
})
export type ShareLinkPreview = z.infer<typeof shareLinkPreviewSchema>
