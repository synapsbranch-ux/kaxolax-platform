import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import AiConversation from '#models/ai_conversation'
import GitLink from '#models/git_link'
import PersonalAccessToken from '#models/personal_access_token'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import User from '#models/user'
import WorkspaceMember from '#models/workspace_member'
import ZoteroLink from '#models/zotero_link'
import { type DeletedProject, deleteProjectRows } from '#services/project_service'
import { acceptPendingInvitationsFor, type JoinedProject } from '#services/sharing_service'
import { ensurePersonalWorkspace } from '#services/workspace_service'

/** Ce que Kaxolax garde d'un compte Clerk (miroir local, jamais de mot de passe ni de jeton). */
export interface ClerkProfile {
  clerkUserId: string
  /** Email principal, vérifié par Clerk. */
  email: string
  fullName: string | null
  avatarUrl: string | null
}

export class ClerkEmailConflictException extends Exception {
  static override status = 409
  static override code = 'E_CLERK_EMAIL_CONFLICT'
  static override message = 'Another account already uses this email address'
}

/** Sous-ensemble de l'objet `user` des webhooks Clerk utilisé ici. */
export interface ClerkUserJson {
  id: string
  first_name?: string | null
  last_name?: string | null
  image_url?: string | null
  /** Compte banni dans Clerk (Dashboard ou API Backend). */
  banned?: boolean | null
  /** Dernière modification du compte chez Clerk, en millisecondes. */
  updated_at?: number | null
  primary_email_address_id?: string | null
  email_addresses?: {
    id: string
    email_address: string
    verification?: { status?: string | null } | null
  }[]
}

function nameOf(...parts: (string | null | undefined)[]): string | null {
  const name = parts
    .map((part) => part?.trim() ?? '')
    .filter((part) => part !== '')
    .join(' ')
  return name === '' ? null : name.slice(0, 255)
}

/** Profil d'un webhook, ou null si le compte n'a pas d'email principal vérifié. */
export function profileFromWebhook(user: ClerkUserJson): ClerkProfile | null {
  const primary = user.email_addresses?.find(
    (address) => address.id === user.primary_email_address_id,
  )
  if (primary?.verification?.status !== 'verified') return null
  return {
    clerkUserId: user.id,
    email: primary.email_address,
    fullName: nameOf(user.first_name, user.last_name),
    avatarUrl: user.image_url ?? null,
  }
}

/**
 * Profil tiré des claims du jeton de session (claims personnalisés du Dashboard Clerk : email,
 * email_verified, name, picture). Null si l'email manque ou n'est pas vérifié.
 */
export function profileFromClaims(claims: Record<string, unknown>): ClerkProfile | null {
  const { sub, email, email_verified: verified, name, picture } = claims
  // Selon le modèle de claims du Dashboard, le booléen peut arriver sous forme de texte.
  const isVerified = verified === true || verified === 'true'
  if (typeof sub !== 'string' || typeof email !== 'string' || !isVerified) return null
  return {
    clerkUserId: sub,
    email,
    fullName: typeof name === 'string' ? nameOf(name) : null,
    avatarUrl: typeof picture === 'string' && picture !== '' ? picture : null,
  }
}

/** Miroir local d'un compte Clerk, et projets rejoints à sa création. */
export interface ClerkUserUpsert {
  user: User
  joined: JoinedProject[]
}

/**
 * Crée ou met à jour le miroir local d'un compte Clerk, avec son workspace personnel (webhook
 * user.created ou création à la volée par le guard). À la création, les invitations en attente
 * pour son email vérifié sont acceptées : les projets rejoints sont renvoyés pour que l'appelant
 * les annonce (`announceAutoJoins`) une fois la transaction validée. Un compte supprimé n'est
 * jamais recréé ni modifié (événement rejoué ou en retard).
 */
export async function upsertClerkUser(
  profile: ClerkProfile,
  client?: TransactionClientContract,
): Promise<ClerkUserUpsert> {
  const run = async (trx: TransactionClientContract) => {
    const email = profile.email.trim().toLowerCase()
    let user = await User.query({ client: trx })
      .where('clerkUserId', profile.clerkUserId)
      .forUpdate()
      .first()
    if (user?.deletedAt) return { user, joined: [] }

    const taken = await User.query({ client: trx })
      .where('email', email)
      .if(user !== null, (query) => query.whereNot('id', user?.id ?? ''))
      .first()
    if (taken) throw new ClerkEmailConflictException()

    const created = user === null
    user ??= new User()
    user.useTransaction(trx)
    user.merge({
      clerkUserId: profile.clerkUserId,
      email,
      fullName: profile.fullName,
      avatarUrl: profile.avatarUrl,
    })
    await user.save()
    // Idempotent : rattrape aussi un compte resté sans workspace.
    await ensurePersonalWorkspace(user, trx)
    // Inscription : les invitations en attente pour cet email (vérifié) sont acceptées.
    const joined = created ? await acceptPendingInvitationsFor(user, trx) : []
    return { user, joined }
  }
  return client ? run(client) : db.transaction(run)
}

/** Effets d'une suppression de compte, à appliquer après la validation de la transaction. */
export interface DeletedClerkUser {
  /** Compte local anonymisé, ou null si rien n'a changé (inconnu, déjà supprimé). */
  userId: string | null
  deleted: DeletedProject[]
  leftProjectIds: string[]
}

/**
 * Compte supprimé dans Clerk : la ligne est gardée et anonymisée (elle reste l'auteur des
 * compilations et des futurs messages), le compte quitte les projets et workspaces des autres et
 * ses propres projets sont supprimés. Ses données personnelles restées dans les projets des autres
 * partent aussi (la ligne n'est jamais supprimée, donc aucun CASCADE ne les atteint) : ses
 * conversations avec l'IA (messages compris), ses liens Git et Zotero (avec leurs jetons chiffrés),
 * et ses jetons d'accès personnels sont révoqués. Renvoie les projets dont il faut ensuite libérer les
 * ressources, et les projets partagés qu'il a quittés (à annoncer, `announceDepartures`).
 */
export async function deleteClerkUser(
  clerkUserId: string,
  trx: TransactionClientContract,
): Promise<DeletedClerkUser> {
  const user = await User.query({ client: trx })
    .where('clerkUserId', clerkUserId)
    .forUpdate()
    .first()
  if (!user || user.deletedAt) return { userId: null, deleted: [], leftProjectIds: [] }

  const owned = await Project.query({ client: trx }).where('ownerId', user.id).forUpdate()
  const deleted: DeletedProject[] = []
  for (const project of owned) deleted.push(await deleteProjectRows(project, trx))
  // Restent les projets des autres, dont il est retiré.
  const left = await ProjectMember.query({ client: trx }).where('userId', user.id).forUpdate()
  const leftProjectIds = left.map((member) => member.projectId)
  await ProjectMember.query({ client: trx }).where('userId', user.id).delete()
  // Il quitte aussi les workspaces des autres ; son workspace personnel reste, vide.
  await WorkspaceMember.query({ client: trx })
    .where('userId', user.id)
    .whereNot('role', 'owner')
    .delete()
  // Données personnelles hors de ses projets : conversations IA (messages en CASCADE ; l'usage
  // passé reste compté, `ai_message_id` à NULL), intégrations dont ses jetons OAuth servaient la
  // synchronisation, jetons d'accès révoqués (gardés pour le journal, inutilisables).
  await AiConversation.query({ client: trx }).where('userId', user.id).delete()
  await GitLink.query({ client: trx }).where('ownerId', user.id).delete()
  await ZoteroLink.query({ client: trx }).where('ownerId', user.id).delete()
  await PersonalAccessToken.query({ client: trx })
    .where('userId', user.id)
    .whereNull('revokedAt')
    .update({ revokedAt: DateTime.utc().toSQL() })

  user.useTransaction(trx)
  user.merge({
    email: `deleted+${user.id}@users.invalid`,
    fullName: null,
    avatarUrl: null,
    deletedAt: DateTime.utc(),
  })
  await user.save()
  return { userId: user.id, deleted, leftProjectIds }
}

/** État de bannissement d'un compte, daté par Clerk (`updated_at` du compte) si connu. */
export interface ClerkBanState {
  banned: boolean
  changedAt: DateTime | null
}

/** État de bannissement porté par un webhook `user.*`, ou null s'il n'en porte pas. */
export function banStateFromWebhook(user: ClerkUserJson): ClerkBanState | null {
  if (typeof user.banned !== 'boolean') return null
  return {
    banned: user.banned,
    changedAt:
      typeof user.updated_at === 'number'
        ? DateTime.fromMillis(user.updated_at, { zone: 'utc' })
        : null,
  }
}

/**
 * Reflète le bannissement d'un compte (action de l'admin ou webhook). Un état daté d'avant celui
 * déjà reflété (webhook en retard, ou rejoué après une action de l'admin) est ignoré ; un compte
 * supprimé ne change plus. Renvoie vrai si le compte vient d'être banni : l'appelant ferme alors
 * ses connexions temps réel, une fois la transaction validée.
 */
export async function applyBanState(
  user: User,
  state: ClerkBanState,
  trx: TransactionClientContract,
): Promise<boolean> {
  if (user.deletedAt) return false
  const known = user.banStateUpdatedAt
  if (state.changedAt && known && state.changedAt <= known) return false
  const newlyBanned = state.banned && user.bannedAt === null
  user.useTransaction(trx)
  user.merge({
    bannedAt: state.banned ? (user.bannedAt ?? DateTime.utc()) : null,
    banStateUpdatedAt: state.changedAt ?? known,
  })
  await user.save()
  return newlyBanned
}
