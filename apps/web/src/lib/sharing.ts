import {
  type AssignableRole,
  canLeave,
  canManageMembers,
  canManageShareLinks,
  canTransferOwnership,
  type CollaboratorUsage,
  INVITATION_RESEND_INTERVAL_SECONDS,
  invitationEmailMismatchErrorSchema,
  type ProjectInvitationEntry,
  type ProjectMemberEntry,
  type ProjectRole,
  SHARING_ERRORS,
  type ShareLinkKind,
  tooManyInvitationsErrorSchema,
} from '@kaxolax/contracts'
import { ApiError, errorMessage } from './api'

/**
 * Logique de la modale de partage et des pages d'invitation, sans React : libellés, actions
 * permises selon le rôle (matrice de `@kaxolax/contracts`), messages d'erreur de l'API.
 */

export const ROLE_LABELS: Record<ProjectRole, string> = {
  owner: 'Propriétaire',
  editor: 'Éditeur',
  reviewer: 'Relecteur',
  viewer: 'Lecteur',
}

export const ROLE_DESCRIPTIONS: Record<ProjectRole, string> = {
  owner: 'gère tout',
  editor: 'édite, compile et décide des suggestions',
  reviewer: 'commente et suggère des modifications',
  viewer: 'lit et compile',
}

export const SHARE_LINK_LABELS: Record<ShareLinkKind, { title: string; description: string }> = {
  view: {
    title: 'Lien en lecture seule',
    description: 'Toute personne connectée qui a le lien rejoint le projet comme lecteur.',
  },
  edit: {
    title: "Lien d'édition",
    description: 'Toute personne connectée qui a le lien rejoint le projet comme éditeur.',
  },
}

/** Vue de la modale : complète pour qui gère les membres, limitée (liste, quitter) sinon. */
export type ShareDialogView = 'manage' | 'limited'

export function shareDialogView(role: ProjectRole): ShareDialogView {
  return canManageMembers(role) ? 'manage' : 'limited'
}

/** Actions proposées sur une ligne de la liste des membres. */
export interface MemberActions {
  changeRole: boolean
  remove: boolean
  transfer: boolean
  /** Sa propre ligne : quitter le projet. */
  leave: boolean
}

export function memberActions(
  viewerRole: ProjectRole,
  viewerId: string,
  member: ProjectMemberEntry,
): MemberActions {
  const self = member.user.id === viewerId
  const target = member.role !== 'owner' && !self
  return {
    changeRole: target && canManageMembers(viewerRole),
    remove: target && canManageMembers(viewerRole),
    transfer: target && canTransferOwnership(viewerRole),
    leave: self && canLeave(viewerRole),
  }
}

export function canManageLinks(role: ProjectRole): boolean {
  return canManageShareLinks(role)
}

/** Nom affiché d'un membre (nom, sinon email, sinon « Collaborateur »). */
export function memberName(member: ProjectMemberEntry): string {
  const fullName = member.user.fullName?.trim() ?? ''
  if (fullName !== '') return fullName
  return member.user.email ?? 'Collaborateur'
}

/** Vrai si la limite du plan bloque une nouvelle invitation (null : usage inconnu). */
export function isAtCollaboratorLimit(usage: CollaboratorUsage | null): boolean {
  return usage !== null && usage.max !== null && usage.used >= usage.max
}

/** « 2 sur 3 collaborateurs (plan free) », ou « illimités ». */
export function collaboratorUsageText(usage: CollaboratorUsage): string {
  const plural = (count: number) => (count > 1 ? 'collaborateurs' : 'collaborateur')
  if (usage.max === null)
    return `${String(usage.used)} ${plural(usage.used)} (plan ${usage.plan}, illimités)`
  return `${String(usage.used)} sur ${String(usage.max)} ${plural(usage.max)} (plan ${usage.plan})`
}

/** Secondes avant qu'une relance soit permise (0 : tout de suite). */
export function resendCooldownSeconds(invitation: ProjectInvitationEntry, now: number): number {
  const elapsed = (now - Date.parse(invitation.lastSentAt)) / 1000
  return Math.max(0, Math.ceil(INVITATION_RESEND_INTERVAL_SECONDS - elapsed))
}

/** Date courte en français (échéance d'une invitation). */
export function formatDate(iso: string): string {
  return new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'long' }).format(new Date(iso))
}

/** Limite atteinte (403 `E_PLAN_LIMIT`) : plan et maximum, à afficher avec le lien des tarifs. */
export function planLimitOf(error: unknown): { plan: string; max: number } | null {
  // Corps validé par `planLimitErrorSchema` (`@kaxolax/contracts`, billing.ts) : `ApiError.planLimit`.
  const limit = error instanceof ApiError ? error.planLimit : null
  return limit ? { plan: limit.limit.plan, max: limit.limit.max } : null
}

/** Message d'une limite de plan atteinte. */
export function planLimitText(limit: { plan: string; max: number }): string {
  const people = limit.max > 1 ? 'collaborateurs' : 'collaborateur'
  return `Le plan ${limit.plan} du propriétaire permet ${String(limit.max)} ${people} par projet (invitations en attente comprises).`
}

/** Message en français d'une erreur des routes du partage. */
export function sharingErrorMessage(error: unknown): string {
  if (!(error instanceof ApiError)) return errorMessage(error)
  switch (error.code) {
    case SHARING_ERRORS.planLimit: {
      const limit = planLimitOf(error)
      return limit
        ? `Limite de collaborateurs atteinte. ${planLimitText(limit)}`
        : 'Limite de collaborateurs atteinte.'
    }
    case SHARING_ERRORS.alreadyMember:
      return 'Cette personne est déjà membre du projet.'
    case SHARING_ERRORS.invitationNotFound:
      return "Cette invitation n'existe plus : elle a été annulée, remplacée par une relance ou déjà utilisée."
    case SHARING_ERRORS.invitationExpired:
      return 'Cette invitation a expiré. Demandez au propriétaire du projet de la relancer.'
    case SHARING_ERRORS.invitationEmailFailed:
      return "L'email n'a pas pu être envoyé. Rien n'a changé : réessayez dans quelques minutes."
    case SHARING_ERRORS.invitationEmailMismatch: {
      const parsed = invitationEmailMismatchErrorSchema.safeParse(error.body)
      return parsed.success
        ? `Cette invitation a été envoyée à ${parsed.data.invitedEmailHint}. Connectez-vous avec ce compte pour l'accepter.`
        : 'Cette invitation a été envoyée à une autre adresse email que celle de votre compte.'
    }
    case SHARING_ERRORS.tooManyInvitations: {
      const parsed = tooManyInvitationsErrorSchema.safeParse(error.body)
      const wait = parsed.success ? parsed.data.retryAfterSeconds : null
      return wait === null
        ? "Trop d'envois pour cette invitation."
        : `Trop d'envois : réessayez dans ${String(wait)} s.`
    }
    case SHARING_ERRORS.shareLinkNotFound:
      return "Ce lien de partage n'est plus valide : il a été désactivé ou régénéré."
    case SHARING_ERRORS.memberNotFound:
      return "Cette personne n'est plus membre du projet."
    case SHARING_ERRORS.ownerRoleLocked:
      return 'Le rôle du propriétaire ne change que par un transfert de propriété.'
    case SHARING_ERRORS.ownerCannotLeave:
      return 'Le propriétaire ne peut pas quitter son projet : transférez d’abord la propriété.'
    case SHARING_ERRORS.invalidNewOwner:
      return 'Ce membre ne peut pas devenir propriétaire (compte suspendu ou supprimé).'
    case SHARING_ERRORS.alreadyOwner:
      return 'Cette personne est déjà propriétaire du projet.'
    case SHARING_ERRORS.forbidden:
      return 'Votre rôle ne permet pas cette action.'
    default:
      return error.status === 404 ? 'Introuvable.' : error.message
  }
}

/** Rôles proposés à l'invitation et au changement de rôle, du plus élevé au plus faible. */
export const ROLE_OPTIONS: readonly AssignableRole[] = ['editor', 'reviewer', 'viewer']

/**
 * Confirmation en attente dans la modale de partage (une seule à la fois) : régénérer un lien,
 * transférer la propriété, retirer un membre, quitter le projet.
 */
export type PendingConfirmation =
  | { kind: 'regenerate'; link: ShareLinkKind }
  | { kind: 'transfer'; userId: string; name: string }
  | { kind: 'remove'; userId: string; name: string }
  | { kind: 'leave' }

/** Titre, texte et bouton de chaque confirmation. */
export function confirmationText(pending: PendingConfirmation): {
  title: string
  description: string
  confirmLabel: string
} {
  switch (pending.kind) {
    case 'regenerate':
      return {
        title: `Régénérer le ${SHARE_LINK_LABELS[pending.link].title.toLowerCase()} ?`,
        description:
          "L'ancien lien cessera aussitôt de fonctionner. Les personnes qui ont déjà rejoint le projet restent membres.",
        confirmLabel: 'Régénérer',
      }
    case 'transfer':
      return {
        title: `Transférer la propriété à ${pending.name} ?`,
        description: `${pending.name} deviendra propriétaire et gérera le partage ; vous resterez membre comme éditeur. Le projet rejoindra son workspace personnel.`,
        confirmLabel: 'Transférer',
      }
    case 'remove':
      return {
        title: `Retirer ${pending.name} du projet ?`,
        description: `${pending.name} perdra aussitôt l'accès au projet et sera déconnecté des documents ouverts.`,
        confirmLabel: 'Retirer',
      }
    case 'leave':
      return {
        title: 'Quitter le projet ?',
        description:
          "Vous perdrez l'accès au projet. Pour y revenir, il faudra une nouvelle invitation ou un lien de partage.",
        confirmLabel: 'Quitter',
      }
  }
}

/** Adresse de connexion (ou d'inscription) qui revient à la page courante ensuite. */
export function authUrl(kind: 'sign-in' | 'sign-up', returnTo: string): string {
  return `/${kind}?${new URLSearchParams({ redirect_url: returnTo }).toString()}`
}
