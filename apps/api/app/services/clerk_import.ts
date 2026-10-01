import { createClerkClient } from '@clerk/backend'
import User from '#models/user'

/** Compte Clerk, tel que l'import en a besoin. */
export interface ClerkAccount {
  id: string
}

/** Format de digest scrypt accepté par Clerk et testé par la sonde (`--probe-hash`). */
export type PasswordFormat = 'werkzeug-hex' | 'werkzeug-base64'
export const PASSWORD_FORMATS: PasswordFormat[] = ['werkzeug-hex', 'werkzeug-base64']

export interface NewClerkAccount {
  externalId: string
  email: string
  firstName?: string
  lastName?: string
  /** Digest à reprendre ; sans lui, le compte est créé sans mot de passe (réinitialisation). */
  passwordDigest?: string
}

/** Opérations de l'API Backend de Clerk utilisées par l'import ; remplacées par un faux en test. */
export interface ClerkAdminApi {
  findUser(query: { externalId: string } | { email: string }): Promise<ClerkAccount | null>
  createUser(account: NewClerkAccount): Promise<ClerkAccount>
  verifyPassword(userId: string, password: string): Promise<boolean>
  deleteUser(userId: string): Promise<void>
}

export function clerkAdminApi(secretKey: string): ClerkAdminApi {
  const clerk = createClerkClient({ secretKey })
  return {
    async findUser(query) {
      const { data } = await clerk.users.getUserList(
        'externalId' in query
          ? { externalId: [query.externalId], limit: 1 }
          : { emailAddress: [query.email], limit: 1 },
      )
      const user = data[0]
      return user ? { id: user.id } : null
    },
    async createUser(account) {
      const user = await clerk.users.createUser({
        externalId: account.externalId,
        emailAddress: [account.email],
        firstName: account.firstName,
        lastName: account.lastName,
        ...(account.passwordDigest
          ? { passwordDigest: account.passwordDigest, passwordHasher: 'scrypt_werkzeug' }
          : { skipPasswordRequirement: true }),
        skipLegalChecks: true,
      })
      return { id: user.id }
    },
    async verifyPassword(userId, password) {
      try {
        await clerk.users.verifyPassword({ userId, password })
        return true
      } catch {
        return false
      }
    },
    async deleteUser(userId) {
      await clerk.users.deleteUser(userId)
    },
  }
}

/**
 * Convertit un hash scrypt d'AdonisJS (PHC : `$scrypt$n=…,r=…,p=…$sel$hash`, base64) au format
 * Werkzeug que Clerk importe (`scrypt:n:r:p$sel$hash`). Null si le hash n'est pas de ce type.
 * Werkzeug utilise le sel comme texte : la sonde dit si Clerk retrouve le même résultat.
 */
export function werkzeugDigest(phc: string, format: PasswordFormat): string | null {
  const match = /^\$scrypt\$n=(\d+),r=(\d+),p=(\d+)\$([^$]+)\$([^$]+)$/.exec(phc)
  if (!match) return null
  const [, n, r, p, salt, hash] = match as unknown as [
    string,
    string,
    string,
    string,
    string,
    string,
  ]
  const encoded = format === 'werkzeug-hex' ? Buffer.from(hash, 'base64').toString('hex') : hash
  return `scrypt:${n}:${r}:${p}$${salt}$${encoded}`
}

/** Prénom et nom Clerk à partir du nom complet de l'étape 1. */
export function splitName(fullName: string | null): { firstName?: string; lastName?: string } {
  const parts = (fullName ?? '').trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return {}
  const [firstName, ...rest] = parts as [string, ...string[]]
  return rest.length === 0 ? { firstName } : { firstName, lastName: rest.join(' ') }
}

export interface ImportReport {
  created: string[]
  linked: string[]
  failed: { email: string; error: string }[]
}

/**
 * Importe dans Clerk chaque compte vérifié de l'étape 1 qui n'y est pas encore relié, puis renseigne
 * `clerk_user_id`. Idempotent : un compte déjà présent dans Clerk (même `external_id` ou même email)
 * est seulement relié ; un compte déjà relié n'est plus traité.
 */
export async function importUsers(
  api: ClerkAdminApi,
  options: { dryRun?: boolean; passwordFormat?: PasswordFormat; pauseMs?: number } = {},
): Promise<ImportReport> {
  const report: ImportReport = { created: [], linked: [], failed: [] }
  const users = await User.query()
    .whereNull('clerkUserId')
    .whereNull('deletedAt')
    .whereNotNull('emailVerifiedAt')
    .orderBy('createdAt')

  for (const user of users) {
    try {
      const existing =
        (await api.findUser({ externalId: user.id })) ?? (await api.findUser({ email: user.email }))
      if (options.dryRun) {
        ;(existing ? report.linked : report.created).push(user.email)
        continue
      }
      const digest =
        options.passwordFormat && user.passwordHash
          ? werkzeugDigest(user.passwordHash, options.passwordFormat)
          : null
      const account =
        existing ??
        (await api.createUser({
          externalId: user.id,
          email: user.email,
          ...splitName(user.fullName),
          ...(digest ? { passwordDigest: digest } : {}),
        }))
      // Hors du modèle : le mixin de l'étape 1 ne doit pas toucher au mot de passe.
      await User.query().where('id', user.id).update({ clerk_user_id: account.id })
      ;(existing ? report.linked : report.created).push(user.email)
    } catch (error) {
      report.failed.push({
        email: user.email,
        error: error instanceof Error ? error.message : String(error),
      })
    }
    if (options.pauseMs) await new Promise((resolve) => setTimeout(resolve, options.pauseMs))
  }
  return report
}

/**
 * Sonde : un compte témoin dont le mot de passe est haché par AdonisJS est importé dans Clerk sous
 * chaque format, puis Clerk vérifie le mot de passe. Renvoie le format qui marche, ou null.
 */
export async function probePasswordFormat(
  api: ClerkAdminApi,
  hashPassword: (password: string) => Promise<string>,
  pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms)),
): Promise<PasswordFormat | null> {
  const password = `Probe-${crypto.randomUUID()}`
  const phc = await hashPassword(password)
  for (const format of PASSWORD_FORMATS) {
    const digest = werkzeugDigest(phc, format)
    if (!digest) return null
    const probeId = crypto.randomUUID()
    let account: ClerkAccount | null = null
    try {
      account = await api.createUser({
        externalId: `kaxolax-probe-${probeId}`,
        email: `kaxolax-probe-${probeId}@example.com`,
        passwordDigest: digest,
      })
      if (await api.verifyPassword(account.id, password)) return format
    } catch {
      // Digest refusé par Clerk : format suivant.
    } finally {
      if (account) await api.deleteUser(account.id)
      await pause(200)
    }
  }
  return null
}
