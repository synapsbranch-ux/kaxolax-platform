import { Exception } from '@adonisjs/core/exceptions'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import User from '#models/user'
import WorkspaceMember from '#models/workspace_member'
import { type DeletedProject, deleteProjectRows } from '#services/project_service'
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

/**
 * Crée ou met à jour le miroir local d'un compte Clerk, avec son workspace personnel (webhook
 * user.created ou création à la volée par le guard). Un compte supprimé n'est jamais recréé ni
 * modifié (événement rejoué ou en retard).
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
    await user.save()
    // Idempotent : rattrape aussi un compte resté sans workspace.
    await ensurePersonalWorkspace(user, trx)
    return user
  }
  return client ? run(client) : db.transaction(run)
}

/**
 * Compte supprimé dans Clerk : la ligne est gardée et anonymisée (elle reste l'auteur des
 * compilations et des futurs messages), le compte quitte les projets et workspaces des autres et
 * ses propres projets sont supprimés. Renvoie les projets dont il faut ensuite libérer les
 * ressources.
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
  // Il quitte aussi les workspaces des autres ; son workspace personnel reste, vide.
  await WorkspaceMember.query({ client: trx })
    .where('userId', user.id)
    .whereNot('role', 'owner')
    .delete()

  user.useTransaction(trx)
  user.merge({
    email: `deleted+${user.id}@users.invalid`,
    fullName: null,
    avatarUrl: null,
    deletedAt: DateTime.utc(),
  })
  await user.save()
  return deleted
}
