import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import User from '#models/user'
import { isUuid } from '#services/project_access'
import { type DeletedProject, deleteProjectRows } from '#services/project_service'

/** Ce que Kaxolax garde d'un compte Clerk (miroir local, jamais de mot de passe ni de jeton). */
export interface ClerkProfile {
  clerkUserId: string
  /** Email principal, vérifié par Clerk. */
  email: string
  fullName: string | null
  avatarUrl: string | null
  /** `external_id` du compte Clerk : l'id local d'un compte de l'étape 1 importé. */
  externalId?: string | null
}

export class ClerkEmailConflictException extends Exception {
  static override status = 409
  static override code = 'E_CLERK_EMAIL_CONFLICT'
  static override message = 'Another account already uses this email address'
}

/** Sous-ensemble de l'objet `user` des webhooks Clerk utilisé ici. */
export interface ClerkUserJson {
  id: string
  external_id?: string | null
  first_name?: string | null
  last_name?: string | null
  image_url?: string | null
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
    externalId: user.external_id ?? null,
  }
}

/**
 * Profil tiré des claims du jeton de session (claims personnalisés du Dashboard Clerk : email,
 * email_verified, name, picture). Null si l'email manque ou n'est pas vérifié.
 */
export function profileFromClaims(claims: Record<string, unknown>): ClerkProfile | null {
  const { sub, email, email_verified: verified, name, picture } = claims
  if (typeof sub !== 'string' || typeof email !== 'string' || verified !== true) return null
  return {
    clerkUserId: sub,
    email,
    fullName: typeof name === 'string' ? nameOf(name) : null,
    avatarUrl: typeof picture === 'string' && picture !== '' ? picture : null,
  }
}

/** Compte local actif (non supprimé) qui n'est encore relié à aucun compte Clerk. */
function unlinked(trx: TransactionClientContract) {
  return User.query({ client: trx }).whereNull('clerkUserId').whereNull('deletedAt')
}

/**
 * Crée ou met à jour le miroir local d'un compte Clerk. Ordre de rattachement : compte déjà relié,
 * puis `external_id` (compte importé), puis email vérifié d'un compte de l'étape 1. Un compte
 * supprimé n'est jamais recréé ni modifié (événement rejoué ou en retard).
 */
export async function upsertClerkUser(
  profile: ClerkProfile,
  client?: TransactionClientContract,
): Promise<User> {
  const run = async (trx: TransactionClientContract) => {
    const email = profile.email.trim().toLowerCase()
    let user = await User.query({ client: trx })
      .where('clerkUserId', profile.clerkUserId)
      .forUpdate()
      .first()
    if (user?.deletedAt) return user
    if (!user && profile.externalId && isUuid(profile.externalId)) {
      user = await unlinked(trx).where('id', profile.externalId).forUpdate().first()
    }
    user ??= await unlinked(trx).where('email', email).forUpdate().first()

    const taken = await User.query({ client: trx })
      .where('email', email)
      .if(user !== null, (query) => query.whereNot('id', user?.id ?? ''))
      .first()
    if (taken) throw new ClerkEmailConflictException()

    user ??= new User()
    user.useTransaction(trx)
    user.merge({
      clerkUserId: profile.clerkUserId,
      email,
      fullName: profile.fullName,
      avatarUrl: profile.avatarUrl,
    })
    // Pas de mot de passe : la colonne reste nulle (le mixin de l'étape 1 hacherait toute valeur).
    await user.save()
    return user
  }
  return client ? run(client) : db.transaction(run)
}

/**
 * Compte supprimé dans Clerk : la ligne est gardée et anonymisée (elle reste l'auteur des
 * compilations et des futurs messages), le compte quitte les projets des autres et ses propres
 * projets sont supprimés. Renvoie les projets dont il faut ensuite libérer les ressources.
 */
export async function deleteClerkUser(
  clerkUserId: string,
  trx: TransactionClientContract,
): Promise<DeletedProject[]> {
  const user = await User.query({ client: trx })
    .where('clerkUserId', clerkUserId)
    .forUpdate()
    .first()
  if (!user || user.deletedAt) return []

  const owned = await Project.query({ client: trx }).where('ownerId', user.id).forUpdate()
  const deleted: DeletedProject[] = []
  for (const project of owned) deleted.push(await deleteProjectRows(project, trx))
  await ProjectMember.query({ client: trx }).where('userId', user.id).delete()

  user.useTransaction(trx)
  user.merge({
    email: `deleted+${user.id}@users.invalid`,
    fullName: null,
    avatarUrl: null,
    emailVerifiedAt: null,
    deletedAt: DateTime.utc(),
  })
  await user.save()
  // Hors du modèle : le mixin de l'étape 1 hacherait la valeur nulle.
  await trx.from('users').where('id', user.id).update({ password_hash: null })
  return deleted
}
