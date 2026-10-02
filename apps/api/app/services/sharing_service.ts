import { randomUUID } from 'node:crypto'
import {
  type AssignableRole,
  canManageMembers,
  type CollaboratorUsage,
  higherRole,
  INVITATION_MAX_SENDS,
  INVITATION_RESEND_INTERVAL_SECONDS,
  INVITATION_TTL_DAYS,
  INVITATIONS_PER_HOUR,
  type InvitationPreview,
  type JoinProjectResponse,
  PROJECT_ROLE_RANK,
  type ProjectInvitationEntry,
  type ProjectMemberEntry,
  type ProjectMembersResponse,
  SHARE_LINK_KINDS,
  SHARE_LINK_ROLES,
  type ShareLinkKind,
  type ShareLinkPreview,
  type ShareLinkState,
} from '@kaxolax/contracts'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import { appUrl } from '#config/app'
import {
  AlreadyMemberException,
  InvitationEmailMismatchException,
  InvitationExpiredException,
  InvitationNotFoundException,
  MemberNotFoundException,
  OwnerCannotLeaveException,
  OwnerRoleLockedException,
  ShareLinkNotFoundException,
  TooManyInvitationsException,
} from '#exceptions/sharing'
import { PlanLimitException } from '#exceptions/plan_limit'
import Project from '#models/project'
import ProjectInvitation from '#models/project_invitation'
import ProjectMember, { type ProjectRole } from '#models/project_member'
import ShareLink from '#models/share_link'
import User from '#models/user'
import { isoString } from '#services/dates'
import { projectCollaboratorCount } from '#services/plan_enforcement'
import { collaboratorLimit } from '#services/plans'
import { recordSharingEvent } from '#services/sharing_audit'
import {
  isUuid,
  ProjectForbiddenException,
  projectFor,
  ProjectNotFoundException,
} from '#services/project_access'
import { InvalidNewOwnerException, transferOwnership } from '#services/project_ownership'
import {
  hashToken,
  isTokenShaped,
  newInvitationToken,
  shareLinkToken,
} from '#services/sharing_tokens'

/**
 * Partage d'un projet : membres, invitations par email, liens de partage, transfert de propriété.
 * Les droits viennent de la matrice des permissions (`@kaxolax/contracts`, via `projectFor`). Les
 * fonctions qui changent le rôle d'un membre déjà présent renvoient les comptes à signaler au
 * service temps réel ; l'appelant le fait une fois la transaction validée.
 */

// --- Sérialisation --------------------------------------------------------------------------

interface MemberRow {
  user_id: string
  role: ProjectRole
  created_at: Date
  email: string
  full_name: string | null
  avatar_url: string | null
}

/** `showEmail` : l'email d'un membre n'est montré qu'au propriétaire et au membre lui-même. */
function serializeMember(row: MemberRow, showEmail: boolean): ProjectMemberEntry {
  return {
    user: {
      id: row.user_id,
      email: showEmail ? row.email : null,
      fullName: row.full_name,
      avatarUrl: row.avatar_url,
    },
    role: row.role,
    joinedAt: isoString(DateTime.fromJSDate(row.created_at)),
  }
}

function membersQuery(projectId: string, client?: TransactionClientContract) {
  return (client ?? db)
    .from('project_members as m')
    .join('users as u', 'u.id', 'm.user_id')
    .where('m.project_id', projectId)
    .select('m.user_id', 'm.role', 'm.created_at', 'u.email', 'u.full_name', 'u.avatar_url')
}

/**
 * Membres : propriétaire d'abord, puis par rôle décroissant, puis par date d'arrivée. Les emails ne
 * vont qu'à qui gère les membres (et chacun voit le sien) : un lien de partage public ne doit pas
 * permettre de collecter les adresses des collaborateurs.
 */
async function listMembers(
  projectId: string,
  viewer: { userId: string; manager: boolean },
  client?: TransactionClientContract,
): Promise<ProjectMemberEntry[]> {
  const rows = (await membersQuery(projectId, client).orderBy('m.created_at')) as MemberRow[]
  return rows
    .toSorted((a, b) => PROJECT_ROLE_RANK[b.role] - PROJECT_ROLE_RANK[a.role])
    .map((row) => serializeMember(row, viewer.manager || row.user_id === viewer.userId))
}

async function memberEntry(
  projectId: string,
  userId: string,
  client?: TransactionClientContract,
): Promise<ProjectMemberEntry> {
  const row = (await membersQuery(projectId, client).where('m.user_id', userId).first()) as
    MemberRow | undefined
  if (!row) throw new MemberNotFoundException()
  return serializeMember(row, true)
}

function serializeInvitation(invitation: ProjectInvitation): ProjectInvitationEntry {
  const extras = invitation.$extras as { inviter_full_name: string | null }
  return {
    id: invitation.id,
    email: invitation.email,
    role: invitation.role,
    invitedBy: { id: invitation.invitedBy, fullName: extras.inviter_full_name },
    createdAt: isoString(invitation.createdAt),
    lastSentAt: isoString(invitation.lastSentAt),
    expiresAt: isoString(invitation.expiresAt),
    expired: invitation.expiresAt <= DateTime.utc(),
  }
}

function invitationsQuery(projectId: string, client?: TransactionClientContract) {
  return ProjectInvitation.query({ client })
    .join('users as inviters', 'inviters.id', 'project_invitations.invited_by')
    .where('project_invitations.project_id', projectId)
    .whereNull('project_invitations.accepted_at')
    .whereNull('project_invitations.cancelled_at')
    .select('project_invitations.*', 'inviters.full_name as inviter_full_name')
}

async function listInvitations(
  projectId: string,
  client?: TransactionClientContract,
): Promise<ProjectInvitationEntry[]> {
  const invitations = await invitationsQuery(projectId, client)
    .orderBy('project_invitations.created_at', 'desc')
    .orderBy('project_invitations.id')
  return invitations.map(serializeInvitation)
}

async function invitationEntry(
  invitationId: string,
  projectId: string,
  client?: TransactionClientContract,
): Promise<ProjectInvitationEntry> {
  const invitation = await invitationsQuery(projectId, client)
    .where('project_invitations.id', invitationId)
    .firstOrFail()
  return serializeInvitation(invitation)
}

// --- Limite de collaborateurs ---------------------------------------------------------------

/**
 * Collaborateurs d'un projet (`projectCollaboratorCount`) et limite du plan de son propriétaire.
 * `excludeInvitationId` : invitation qui va être acceptée ou renvoyée, comptée à part.
 * `requester` : compte qui agit ; s'il est le propriétaire, la limite vient des claims de son
 * jeton, sinon du dernier plan enregistré pour lui (relevé de ses claims ou miroir des webhooks,
 * le plus récent), comme à l'invitation.
 */
async function collaboratorUsage(
  project: Project,
  client: TransactionClientContract | undefined,
  excludeInvitationId?: string,
  requester?: User,
): Promise<CollaboratorUsage> {
  const used = await projectCollaboratorCount(project.id, client, excludeInvitationId)
  const { plan, max } = await collaboratorLimit(project.ownerId, client, requester)
  return { plan, max, used }
}

/**
 * Refuse (403 `E_PLAN_LIMIT`) d'ajouter un collaborateur au-delà de la limite du plan du
 * propriétaire. Le projet doit être verrouillé (`FOR UPDATE`) : deux ajouts simultanés ne
 * dépassent pas la limite.
 */
async function assertCollaboratorSlot(
  project: Project,
  trx: TransactionClientContract,
  excludeInvitationId?: string,
  requester?: User,
): Promise<void> {
  const usage = await collaboratorUsage(project, trx, excludeInvitationId, requester)
  if (usage.max !== null && usage.used + 1 > usage.max) {
    throw new PlanLimitException({
      name: 'collaborators',
      plan: usage.plan,
      max: usage.max,
      current: usage.used,
    })
  }
}

/**
 * Projet verrouillé pour la durée de la transaction (adhésion par jeton, sans contrôle de rôle).
 * Ordre des verrous, partout : le projet d'abord, puis l'invitation, le lien ou le membre visé ;
 * l'ordre inverse provoquerait des interblocages avec les actions du propriétaire.
 */
async function lockProject(projectId: string, trx: TransactionClientContract): Promise<Project> {
  const project = await Project.query({ client: trx }).where('id', projectId).forUpdate().first()
  if (!project) throw new ProjectNotFoundException()
  return project
}

/**
 * Invitation en attente (ni acceptée ni annulée) de cette personne sur le projet, verrouillée :
 * une seule ligne non acceptée par (projet, email). Le projet doit déjà être verrouillé.
 */
async function pendingInvitationFor(
  project: Project,
  user: User,
  trx: TransactionClientContract,
): Promise<ProjectInvitation | null> {
  return ProjectInvitation.query({ client: trx })
    .where({ projectId: project.id, email: user.email.toLowerCase() })
    .whereNull('acceptedAt')
    .whereNull('cancelledAt')
    .forUpdate()
    .first()
}

/**
 * Fait rejoindre le projet avec un rôle : nouveau membre (dans la limite du plan), ou membre déjà
 * présent qui garde le plus élevé de ses deux rôles. `changed` : rôle d'un membre existant relevé
 * (le service temps réel doit l'appliquer).
 *
 * `invitationId` : invitation acceptée par l'appelant (exclue du décompte, il la marque lui-même).
 * Sans elle (lien de partage), l'invitation en attente de la même personne est réglée ici, dans la
 * même transaction : sa place réservée n'est pas comptée deux fois ; valide, elle est acceptée et
 * son rôle compte (le plus élevé des deux) ; expirée, elle est annulée.
 */
async function joinWithRole(
  project: Project,
  user: User,
  role: AssignableRole,
  trx: TransactionClientContract,
  invitationId?: string,
): Promise<JoinProjectResponse & { changed: boolean }> {
  // Ordre des verrous : projet (déjà pris), invitation, puis membre.
  const invitation =
    invitationId === undefined ? await pendingInvitationFor(project, user, trx) : null
  const invitationValid = invitation !== null && invitation.expiresAt > DateTime.utc()
  const granted = invitation && invitationValid ? higherRole(role, invitation.role) : role
  const result = await joinOrRaise(project, user, granted, trx, invitationId ?? invitation?.id)
  if (invitation) {
    if (invitationValid) invitation.acceptedAt = DateTime.utc()
    else invitation.cancelledAt = DateTime.utc()
    await invitation.useTransaction(trx).save()
    await recordSharingEvent(
      {
        projectId: project.id,
        actorId: user.id,
        action: invitationValid ? 'invitation.accepted' : 'invitation.cancelled',
        targetUserId: user.id,
        metadata: { invitationId: invitation.id, role: result.role, via: 'share_link' },
      },
      trx,
    )
  }
  return result
}

/** Nouveau membre (dans la limite du plan) ou rôle d'un membre existant relevé si plus élevé. */
async function joinOrRaise(
  project: Project,
  user: User,
  role: AssignableRole,
  trx: TransactionClientContract,
  excludeInvitationId: string | undefined,
): Promise<JoinProjectResponse & { changed: boolean }> {
  const existing = await ProjectMember.query({ client: trx })
    .where({ projectId: project.id, userId: user.id })
    .forUpdate()
    .first()
  if (existing) {
    const best = higherRole(existing.role, role)
    if (best === existing.role) {
      return { projectId: project.id, role: existing.role, joined: false, changed: false }
    }
    existing.role = best
    await existing.useTransaction(trx).save()
    return { projectId: project.id, role: best, joined: true, changed: true }
  }
  await assertCollaboratorSlot(project, trx, excludeInvitationId, user)
  await ProjectMember.create({ projectId: project.id, userId: user.id, role }, { client: trx })
  return { projectId: project.id, role, joined: true, changed: false }
}

// --- Membres --------------------------------------------------------------------------------

/**
 * Membres du projet (tout membre). Le propriétaire reçoit aussi les invitations en attente et
 * l'usage de sa limite de collaborateurs.
 */
export async function projectMembers(
  user: User,
  projectId: string,
): Promise<ProjectMembersResponse> {
  const { project, role } = await projectFor(user, projectId, 'read')
  const manager = canManageMembers(role)
  return {
    members: await listMembers(project.id, { userId: user.id, manager }),
    invitations: manager ? await listInvitations(project.id) : [],
    collaborators: manager ? await collaboratorUsage(project, undefined, undefined, user) : null,
  }
}

/** Change le rôle d'un membre (propriétaire) ; le rôle owner ne change que par un transfert. */
export async function changeMemberRole(
  owner: User,
  projectId: string,
  memberId: string,
  role: AssignableRole,
): Promise<{ member: ProjectMemberEntry; changed: boolean }> {
  return db.transaction(async (trx) => {
    const { project } = await projectFor(owner, projectId, 'manageMembers', { trx, lock: true })
    const member = isUuid(memberId)
      ? await ProjectMember.query({ client: trx })
          .where({ projectId: project.id, userId: memberId })
          .forUpdate()
          .first()
      : null
    if (!member) throw new MemberNotFoundException()
    if (member.role === 'owner') throw new OwnerRoleLockedException()
    const previous = member.role
    const changed = previous !== role
    if (changed) {
      member.role = role
      await member.useTransaction(trx).save()
      await recordSharingEvent(
        {
          projectId: project.id,
          actorId: owner.id,
          action: 'member.role_changed',
          targetUserId: member.userId,
          metadata: { from: previous, to: role },
        },
        trx,
      )
    }
    return { member: await memberEntry(project.id, member.userId, trx), changed }
  })
}

/**
 * Retire un membre : le propriétaire retire n'importe quel autre membre ; un membre peut se
 * retirer lui-même (sauf le propriétaire, qui transfère d'abord la propriété).
 */
export async function removeMember(user: User, projectId: string, memberId: string): Promise<void> {
  await db.transaction(async (trx) => {
    const { project, role } = await projectFor(user, projectId, 'read', { trx, lock: true })
    if (memberId === user.id) {
      if (role === 'owner') throw new OwnerCannotLeaveException()
      await ProjectMember.query({ client: trx })
        .where({ projectId: project.id, userId: user.id })
        .delete()
      await recordSharingEvent(
        {
          projectId: project.id,
          actorId: user.id,
          action: 'member.left',
          targetUserId: user.id,
          metadata: { role },
        },
        trx,
      )
      return
    }
    if (!canManageMembers(role)) throw new ProjectForbiddenException()
    const member = isUuid(memberId)
      ? await ProjectMember.query({ client: trx })
          .where({ projectId: project.id, userId: memberId })
          .first()
      : null
    if (!member) throw new MemberNotFoundException()
    if (member.role === 'owner') throw new OwnerRoleLockedException()
    await member.useTransaction(trx).delete()
    await recordSharingEvent(
      {
        projectId: project.id,
        actorId: user.id,
        action: 'member.removed',
        targetUserId: member.userId,
        metadata: { role: member.role },
      },
      trx,
    )
  })
}

/**
 * Transfert de propriété par le propriétaire, vers un membre existant (même logique que l'admin :
 * l'ancien propriétaire devient éditeur, le projet rejoint le workspace du nouveau).
 */
export async function transferProjectOwnership(
  owner: User,
  projectId: string,
  newOwnerId: string,
): Promise<{ fromUserId: string; toUserId: string }> {
  return db.transaction(async (trx) => {
    const { project } = await projectFor(owner, projectId, 'transferOwnership', { trx, lock: true })
    const membership = isUuid(newOwnerId)
      ? await ProjectMember.query({ client: trx })
          .where({ projectId: project.id, userId: newOwnerId })
          .first()
      : null
    const newOwner = membership
      ? await User.query({ client: trx }).where('id', newOwnerId).first()
      : null
    if (!newOwner) throw new InvalidNewOwnerException()
    const transfer = await transferOwnership(project, newOwner, trx, owner)
    await recordSharingEvent(
      {
        projectId: project.id,
        actorId: owner.id,
        action: 'ownership.transferred',
        targetUserId: transfer.toUserId,
        metadata: { fromUserId: transfer.fromUserId },
      },
      trx,
    )
    return { fromUserId: transfer.fromUserId, toUserId: transfer.toUserId }
  })
}

// --- Invitations ----------------------------------------------------------------------------

/** Email invité masqué : première lettre et domaine (`a***@exemple.fr`). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@')
  if (at <= 0) return '***'
  return `${email.slice(0, 1)}***${email.slice(at)}`
}

/** État d'une invitation avant un envoi, pour l'annuler si l'email ne part pas. */
type InvitationSnapshot = Pick<
  ProjectInvitation,
  'tokenHash' | 'role' | 'invitedBy' | 'expiresAt' | 'lastSentAt' | 'sendCount' | 'cancelledAt'
>

function snapshot(invitation: ProjectInvitation): InvitationSnapshot {
  return {
    tokenHash: invitation.tokenHash,
    role: invitation.role,
    invitedBy: invitation.invitedBy,
    expiresAt: invitation.expiresAt,
    lastSentAt: invitation.lastSentAt,
    sendCount: invitation.sendCount,
    cancelledAt: invitation.cancelledAt,
  }
}

/** Invitation prête à partir par email (jeton en clair, jamais stocké). */
export interface InvitationToSend {
  invitation: ProjectInvitationEntry
  created: boolean
  mail: {
    to: string
    projectName: string
    inviterName: string | null
    role: AssignableRole
    url: string
  }
  /** De quoi annuler l'envoi s'il échoue (`revertInvitationSend`). */
  revert: {
    actorId: string
    projectId: string
    invitationId: string
    tokenHash: string
    /** Null : invitation créée par cet envoi. */
    previous: InvitationSnapshot | null
  }
}

function invitationUrl(token: string): string {
  return `${appUrl.replace(/\/$/, '')}/invitations/${token}`
}

/**
 * Délai restant avant qu'une invitation puisse être renvoyée (429 sinon). S'applique aussi à une
 * invitation annulée qu'on réactive : annuler ne remet pas les compteurs à zéro.
 */
function assertCanResend(invitation: ProjectInvitation): void {
  if (invitation.sendCount >= INVITATION_MAX_SENDS) throw new TooManyInvitationsException(null)
  const next = invitation.lastSentAt.plus({ seconds: INVITATION_RESEND_INTERVAL_SECONDS })
  const wait = Math.ceil(next.diff(DateTime.utc(), 'seconds').seconds)
  if (wait > 0) throw new TooManyInvitationsException(wait)
}

/**
 * Limite `INVITATIONS_PER_HOUR` créations par heure et par compte, tous projets confondus. Les
 * invitations annulées comptent (elles sont gardées) ; un verrou consultatif propre au compte
 * sérialise ses invitations simultanées sur plusieurs projets. Le projet est verrouillé avant :
 * même ordre de verrous partout.
 */
async function assertHourlyInvitationLimit(
  owner: User,
  trx: TransactionClientContract,
): Promise<void> {
  await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `project_invitations:${owner.id}`,
  ])
  const since = DateTime.utc().minus({ hours: 1 })
  const recent = await ProjectInvitation.query({ client: trx })
    .where('invitedBy', owner.id)
    .where('createdAt', '>', since.toJSDate())
    .orderBy('createdAt', 'asc')
  const oldest = recent[0]
  if (recent.length >= INVITATIONS_PER_HOUR && oldest) {
    const wait = oldest.createdAt.plus({ hours: 1 }).diff(DateTime.utc(), 'seconds').seconds
    throw new TooManyInvitationsException(Math.max(1, Math.ceil(wait)))
  }
}

/** Nouveau jeton et nouvelle échéance : le lien de l'email précédent cesse de fonctionner. */
function renew(invitation: ProjectInvitation): string {
  const token = newInvitationToken()
  const now = DateTime.utc()
  invitation.merge({
    tokenHash: hashToken(token),
    expiresAt: now.plus({ days: INVITATION_TTL_DAYS }),
    lastSentAt: now,
  })
  return token
}

async function invitationToSend(
  owner: User,
  project: Project,
  invitation: ProjectInvitation,
  token: string,
  previous: InvitationSnapshot | null,
  trx: TransactionClientContract,
): Promise<InvitationToSend> {
  // Nouvelle pour le propriétaire : créée par cet envoi (pas d'état antérieur) ou réactivée.
  const created = previous?.cancelledAt !== null
  await recordSharingEvent(
    {
      projectId: project.id,
      actorId: owner.id,
      action: created ? 'invitation.created' : 'invitation.resent',
      metadata: { invitationId: invitation.id, role: invitation.role },
    },
    trx,
  )
  return {
    invitation: await invitationEntry(invitation.id, project.id, trx),
    created,
    mail: {
      to: invitation.email,
      projectName: project.name,
      inviterName: owner.fullName,
      role: invitation.role,
      url: invitationUrl(token),
    },
    revert: {
      actorId: owner.id,
      projectId: project.id,
      invitationId: invitation.id,
      tokenHash: invitation.tokenHash,
      previous,
    },
  }
}

/**
 * Invite une personne par email (propriétaire). Une invitation en attente (ou annulée) pour le
 * même email est mise à jour (rôle), réactivée et renvoyée, avec la même limitation de fréquence
 * qu'une relance. Limites : collaborateurs du plan du propriétaire, `INVITATIONS_PER_HOUR`
 * créations par heure et par compte.
 */
export async function inviteByEmail(
  owner: User,
  projectId: string,
  input: { email: string; role: AssignableRole },
): Promise<InvitationToSend> {
  const email = input.email.trim().toLowerCase()
  return db.transaction(async (trx) => {
    const { project } = await projectFor(owner, projectId, 'manageMembers', { trx, lock: true })

    const member = (await trx
      .from('project_members as m')
      .join('users as u', 'u.id', 'm.user_id')
      .where('m.project_id', project.id)
      .where('u.email', email)
      .select('m.user_id')
      .first()) as { user_id: string } | null
    if (member) throw new AlreadyMemberException()

    // Annulées comprises : une seule ligne non acceptée par (projet, email).
    const existing = await ProjectInvitation.query({ client: trx })
      .where({ projectId: project.id, email })
      .whereNull('acceptedAt')
      .forUpdate()
      .first()
    if (existing) {
      assertCanResend(existing)
      await assertCollaboratorSlot(project, trx, existing.id, owner)
      const previous = snapshot(existing)
      const token = renew(existing)
      existing.merge({
        role: input.role,
        invitedBy: owner.id,
        sendCount: existing.sendCount + 1,
        cancelledAt: null,
      })
      await existing.useTransaction(trx).save()
      return invitationToSend(owner, project, existing, token, previous, trx)
    }

    await assertHourlyInvitationLimit(owner, trx)
    await assertCollaboratorSlot(project, trx, undefined, owner)
    const invitation = new ProjectInvitation()
    const token = renew(invitation)
    invitation.merge({
      projectId: project.id,
      email,
      role: input.role,
      invitedBy: owner.id,
      acceptedAt: null,
      cancelledAt: null,
      sendCount: 1,
    })
    await invitation.useTransaction(trx).save()
    return invitationToSend(owner, project, invitation, token, null, trx)
  })
}

/**
 * L'email d'une invitation n'est pas parti : l'invitation reprend son état d'avant l'envoi (lien
 * précédent de nouveau valide, envoi non compté dans les limites) ; une invitation créée par cet
 * envoi est supprimée, puisqu'aucun email n'a pu la porter. Sans effet si elle a changé depuis.
 */
export async function revertInvitationSend(sent: InvitationToSend): Promise<void> {
  const { actorId, projectId, invitationId, tokenHash, previous } = sent.revert
  await db.transaction(async (trx) => {
    const project = await Project.query({ client: trx }).where('id', projectId).forUpdate().first()
    if (!project) return
    const invitation = await ProjectInvitation.query({ client: trx })
      .where({ id: invitationId, projectId })
      .whereNull('acceptedAt')
      .forUpdate()
      .first()
    if (invitation?.tokenHash !== tokenHash) return
    if (previous) {
      invitation.merge(previous)
      await invitation.useTransaction(trx).save()
    } else {
      await invitation.useTransaction(trx).delete()
    }
    await recordSharingEvent(
      {
        projectId,
        actorId,
        action: 'invitation.send_failed',
        metadata: { invitationId, reverted: previous ? 'restored' : 'deleted' },
      },
      trx,
    )
  })
}

/** Invitation en attente (ni acceptée ni annulée) du projet, verrouillée. */
async function pendingInvitation(
  projectId: string,
  invitationId: string,
  trx: TransactionClientContract,
): Promise<ProjectInvitation> {
  const invitation = isUuid(invitationId)
    ? await ProjectInvitation.query({ client: trx })
        .where({ id: invitationId, projectId })
        .whereNull('acceptedAt')
        .whereNull('cancelledAt')
        .forUpdate()
        .first()
    : null
  if (!invitation) throw new InvitationNotFoundException()
  return invitation
}

/** Invitations en attente (propriétaire). */
export async function projectInvitations(
  owner: User,
  projectId: string,
): Promise<ProjectInvitationEntry[]> {
  const { project } = await projectFor(owner, projectId, 'manageMembers')
  return listInvitations(project.id)
}

/**
 * Renvoie l'email d'une invitation en attente (propriétaire) : nouveau jeton, nouvelle échéance de
 * `INVITATION_TTL_DAYS` jours. Au plus un envoi par `INVITATION_RESEND_INTERVAL_SECONDS` et
 * `INVITATION_MAX_SENDS` envois en tout. Une invitation expirée reprend une place dans la limite.
 */
export async function resendInvitation(
  owner: User,
  projectId: string,
  invitationId: string,
): Promise<InvitationToSend> {
  return db.transaction(async (trx) => {
    const { project } = await projectFor(owner, projectId, 'manageMembers', { trx, lock: true })
    const invitation = await pendingInvitation(project.id, invitationId, trx)
    assertCanResend(invitation)
    if (invitation.expiresAt <= DateTime.utc()) {
      await assertCollaboratorSlot(project, trx, invitation.id, owner)
    }
    const previous = snapshot(invitation)
    const token = renew(invitation)
    invitation.sendCount += 1
    await invitation.useTransaction(trx).save()
    return invitationToSend(owner, project, invitation, token, previous, trx)
  })
}

/**
 * Annule une invitation en attente (propriétaire) : son lien cesse de fonctionner et sa place se
 * libère. La ligne est gardée, avec ses compteurs d'envoi : inviter de nouveau la même adresse la
 * réactive sans remettre les limites à zéro.
 */
export async function cancelInvitation(
  owner: User,
  projectId: string,
  invitationId: string,
): Promise<void> {
  await db.transaction(async (trx) => {
    const { project } = await projectFor(owner, projectId, 'manageMembers', { trx, lock: true })
    const invitation = await pendingInvitation(project.id, invitationId, trx)
    invitation.cancelledAt = DateTime.utc()
    await invitation.useTransaction(trx).save()
    await recordSharingEvent(
      {
        projectId: project.id,
        actorId: owner.id,
        action: 'invitation.cancelled',
        metadata: { invitationId: invitation.id },
      },
      trx,
    )
  })
}

/**
 * Invitation d'un jeton, en attente ou déjà acceptée (jamais annulée ni remplacée par une
 * relance), sans verrou. 404 sinon.
 */
async function invitationByToken(
  token: string,
  client?: TransactionClientContract,
): Promise<ProjectInvitation> {
  const invitation = isTokenShaped(token)
    ? await ProjectInvitation.query({ client })
        .where('tokenHash', hashToken(token))
        .whereNull('cancelledAt')
        .first()
    : null
  if (!invitation) throw new InvitationNotFoundException()
  return invitation
}

/**
 * Aperçu public d'une invitation : nom du projet, nom de l'invitant, rôle, et si elle a déjà été
 * acceptée (la page appelle alors l'acceptation, idempotente, pour connaître le projet). Rien
 * d'autre.
 */
export async function invitationPreview(token: string): Promise<InvitationPreview> {
  const invitation = await invitationByToken(token)
  const accepted = invitation.acceptedAt !== null
  if (!accepted && invitation.expiresAt <= DateTime.utc()) throw new InvitationExpiredException()
  const project = await Project.find(invitation.projectId)
  const inviter = await User.find(invitation.invitedBy)
  if (!project) throw new InvitationNotFoundException()
  return {
    projectName: project.name,
    inviterName: inviter?.deletedAt ? null : (inviter?.fullName ?? null),
    role: invitation.role,
    expiresAt: isoString(invitation.expiresAt),
    accepted,
  }
}

/**
 * Acceptation par le compte connecté, dont l'email (vérifié par Clerk : le miroir n'en garde pas
 * d'autre) doit être celui de l'invitation. Idempotente : une invitation déjà acceptée (à la main
 * ou automatiquement à l'inscription) renvoie le projet et le rôle actuel, `joined: false`, au
 * compte invité tant qu'il est membre ; 404 pour tout autre compte.
 */
export async function acceptInvitation(
  user: User,
  token: string,
): Promise<JoinProjectResponse & { changed: boolean }> {
  return db.transaction(async (trx) => {
    // Lecture sans verrou pour connaître le projet, verrouillé d'abord ; puis relecture verrouillée.
    const found = await invitationByToken(token, trx)
    const project = await lockProject(found.projectId, trx)
    const invitation = await ProjectInvitation.query({ client: trx })
      .where({ id: found.id, tokenHash: found.tokenHash })
      .whereNull('cancelledAt')
      .forUpdate()
      .first()
    if (!invitation) throw new InvitationNotFoundException()
    const sameEmail = invitation.email === user.email.toLowerCase()

    if (invitation.acceptedAt) {
      const member = sameEmail
        ? await ProjectMember.query({ client: trx })
            .where({ projectId: project.id, userId: user.id })
            .first()
        : null
      if (!member) throw new InvitationNotFoundException()
      return { projectId: project.id, role: member.role, joined: false, changed: false }
    }
    if (!sameEmail) throw new InvitationEmailMismatchException(maskEmail(invitation.email))
    if (invitation.expiresAt <= DateTime.utc()) throw new InvitationExpiredException()

    const result = await joinWithRole(project, user, invitation.role, trx, invitation.id)
    invitation.acceptedAt = DateTime.utc()
    await invitation.useTransaction(trx).save()
    await recordSharingEvent(
      {
        projectId: project.id,
        actorId: user.id,
        action: 'invitation.accepted',
        targetUserId: user.id,
        metadata: { invitationId: invitation.id, role: result.role, joined: result.joined },
      },
      trx,
    )
    return result
  })
}

/** Projet rejoint à l'inscription, avec le rôle obtenu. */
export interface JoinedProject {
  projectId: string
  role: ProjectRole
}

/**
 * Inscription d'un compte (création du miroir Clerk, email vérifié) : ses invitations en attente,
 * non expirées, sont acceptées. Chacune l'est dans un point de sauvegarde : un échec (limite du
 * plan atteinte, interblocage, délai de verrou) laisse l'invitation en attente sans faire échouer
 * la création du compte. Renvoie les projets rejoints, avec le rôle obtenu (l'appelant les annonce
 * une fois la transaction validée).
 */
export async function acceptPendingInvitationsFor(
  user: User,
  trx: TransactionClientContract,
): Promise<JoinedProject[]> {
  const email = user.email.toLowerCase()
  const candidates = await ProjectInvitation.query({ client: trx })
    .where('email', email)
    .whereNull('acceptedAt')
    .whereNull('cancelledAt')
    .where('expiresAt', '>', DateTime.utc().toJSDate())
    .orderBy('createdAt')
  const joined: JoinedProject[] = []
  for (const candidate of candidates) {
    try {
      const accepted = await trx.transaction(async (savepoint): Promise<JoinedProject | null> => {
        // Projet d'abord, puis l'invitation relue et revérifiée.
        const project = await Project.query({ client: savepoint })
          .where('id', candidate.projectId)
          .forUpdate()
          .first()
        if (!project) return null
        const invitation = await ProjectInvitation.query({ client: savepoint })
          .where({ id: candidate.id, email })
          .whereNull('acceptedAt')
          .whereNull('cancelledAt')
          .where('expiresAt', '>', DateTime.utc().toJSDate())
          .forUpdate()
          .first()
        if (!invitation) return null
        const result = await joinWithRole(project, user, invitation.role, savepoint, invitation.id)
        invitation.acceptedAt = DateTime.utc()
        await invitation.useTransaction(savepoint).save()
        await recordSharingEvent(
          {
            projectId: project.id,
            actorId: user.id,
            action: 'invitation.auto_accepted',
            targetUserId: user.id,
            metadata: { invitationId: invitation.id, role: result.role },
          },
          savepoint,
        )
        return result.joined ? { projectId: project.id, role: result.role } : null
      })
      if (accepted) joined.push(accepted)
    } catch (error) {
      const context = { userId: user.id, projectId: candidate.projectId }
      if (error instanceof PlanLimitException) {
        logger.info(context, 'pending invitation kept: collaborator limit reached')
      } else {
        logger.warn({ ...context, err: error }, 'pending invitation kept: acceptance failed')
      }
    }
  }
  return joined
}

// --- Liens de partage -----------------------------------------------------------------------

function shareLinkUrl(link: ShareLink): string {
  return `${appUrl.replace(/\/$/, '')}/share/${shareLinkToken(link.id)}`
}

function serializeShareLink(kind: ShareLinkKind, link: ShareLink | undefined): ShareLinkState {
  return {
    kind,
    role: SHARE_LINK_ROLES[kind],
    enabled: link?.enabled ?? false,
    url: link ? shareLinkUrl(link) : null,
    createdAt: link ? isoString(link.createdAt) : null,
  }
}

/** Les deux liens du projet (propriétaire), `view` d'abord ; un lien jamais activé est vide. */
export async function shareLinks(owner: User, projectId: string): Promise<ShareLinkState[]> {
  const { project } = await projectFor(owner, projectId, 'manageShareLinks')
  const links = await ShareLink.query().where('projectId', project.id)
  return SHARE_LINK_KINDS.map((kind) =>
    serializeShareLink(
      kind,
      links.find((link) => link.kind === kind),
    ),
  )
}

/** Nouveau lien (nouvel identifiant aléatoire, donc nouveau jeton), activé. */
async function createShareLink(
  projectId: string,
  kind: ShareLinkKind,
  trx: TransactionClientContract,
): Promise<ShareLink> {
  const link = new ShareLink()
  link.merge({ projectId, kind, enabled: true })
  link.id = randomUUID()
  link.tokenHash = hashToken(shareLinkToken(link.id))
  await link.useTransaction(trx).save()
  return link
}

/** Active ou désactive un lien (propriétaire). Réactiver redonne le même lien. */
export async function setShareLinkEnabled(
  owner: User,
  projectId: string,
  kind: ShareLinkKind,
  enabled: boolean,
): Promise<ShareLinkState> {
  return db.transaction(async (trx) => {
    const { project } = await projectFor(owner, projectId, 'manageShareLinks', { trx, lock: true })
    const link = await ShareLink.query({ client: trx })
      .where({ projectId: project.id, kind })
      .forUpdate()
      .first()
    const record = () =>
      recordSharingEvent(
        {
          projectId: project.id,
          actorId: owner.id,
          action: enabled ? 'share_link.enabled' : 'share_link.disabled',
          metadata: { kind, role: SHARE_LINK_ROLES[kind] },
        },
        trx,
      )
    if (!link) {
      if (!enabled) return serializeShareLink(kind, undefined)
      const created = await createShareLink(project.id, kind, trx)
      await record()
      return serializeShareLink(kind, created)
    }
    if (link.enabled !== enabled) {
      link.enabled = enabled
      await link.useTransaction(trx).save()
      await record()
    }
    return serializeShareLink(kind, link)
  })
}

/** Régénère un lien (propriétaire) : l'ancien cesse aussitôt de fonctionner ; le nouveau est activé. */
export async function regenerateShareLink(
  owner: User,
  projectId: string,
  kind: ShareLinkKind,
): Promise<ShareLinkState> {
  return db.transaction(async (trx) => {
    const { project } = await projectFor(owner, projectId, 'manageShareLinks', { trx, lock: true })
    await ShareLink.query({ client: trx }).where({ projectId: project.id, kind }).delete()
    const link = await createShareLink(project.id, kind, trx)
    await recordSharingEvent(
      {
        projectId: project.id,
        actorId: owner.id,
        action: 'share_link.regenerated',
        metadata: { kind, role: SHARE_LINK_ROLES[kind] },
      },
      trx,
    )
    return serializeShareLink(kind, link)
  })
}

/** Lien actif d'un jeton, sans verrou. 404 sinon. */
async function shareLinkByToken(
  token: string,
  client?: TransactionClientContract,
): Promise<ShareLink> {
  const link = isTokenShaped(token)
    ? await ShareLink.query({ client })
        .where({ tokenHash: hashToken(token), enabled: true })
        .first()
    : null
  if (!link) throw new ShareLinkNotFoundException()
  return link
}

/** Aperçu public d'un lien actif : nom du projet et rôle donné. */
export async function shareLinkPreview(token: string): Promise<ShareLinkPreview> {
  const link = await shareLinkByToken(token)
  const project = await Project.find(link.projectId)
  if (!project) throw new ShareLinkNotFoundException()
  return { projectName: project.name, role: SHARE_LINK_ROLES[link.kind] }
}

/**
 * Rejoint un projet par un lien actif, avec le rôle du lien (un membre garde le plus élevé de ses
 * deux rôles), dans la limite de collaborateurs du plan du propriétaire.
 */
export async function joinWithShareLink(
  user: User,
  token: string,
): Promise<JoinProjectResponse & { changed: boolean }> {
  return db.transaction(async (trx) => {
    // Lecture sans verrou pour connaître le projet, verrouillé d'abord ; puis relecture verrouillée
    // (le lien a pu être désactivé ou régénéré entre-temps).
    const found = await shareLinkByToken(token, trx)
    const project = await lockProject(found.projectId, trx)
    const link = await ShareLink.query({ client: trx })
      .where({ id: found.id, tokenHash: found.tokenHash, enabled: true })
      .forUpdate()
      .first()
    if (!link) throw new ShareLinkNotFoundException()
    const role = SHARE_LINK_ROLES[link.kind]
    const result = await joinWithRole(project, user, role, trx)
    if (result.joined) {
      await recordSharingEvent(
        {
          projectId: project.id,
          actorId: user.id,
          action: 'share_link.joined',
          targetUserId: user.id,
          metadata: { kind: link.kind, role: result.role, roleRaised: result.changed },
        },
        trx,
      )
    }
    return result
  })
}
