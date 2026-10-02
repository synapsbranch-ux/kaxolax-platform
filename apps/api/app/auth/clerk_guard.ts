import { verifyToken } from '@clerk/backend'
import { symbols } from '@adonisjs/auth'
import type { AuthClientResponse, GuardContract } from '@adonisjs/auth/types'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import type { DateTime } from 'luxon'
import User from '#models/user'
import { profileFromClaims, upsertClerkUser } from '#services/clerk_users'
import { announceAutoJoins } from '#services/project_events'
import RealtimeClient from '#services/realtime_client'

export interface ClerkGuardOptions {
  /** Clé publique PEM de l'instance Clerk : vérification sans appel réseau. */
  jwtKey: string | undefined
  /** Valeurs acceptées pour le claim `azp` (origine de l'application). */
  authorizedParties: string[]
}

/** Requête non authentifiée (401), même code que l'erreur d'@adonisjs/auth. */
export class UnauthorizedException extends Exception {
  static override status = 401
  static override code = 'E_UNAUTHORIZED_ACCESS'
  static override message = 'Unauthorized access'
}

/** Compte banni (401) : le jeton est valide mais n'ouvre plus rien. */
export class AccountBannedException extends UnauthorizedException {
  static override code = 'E_ACCOUNT_BANNED'
  static override message = 'This account is banned'
}

/** Claims vérifiés du jeton de session Clerk, exposés à la requête (`getClaimsOrFail()`). */
export interface ClerkSessionClaims {
  /** Compte Clerk (`sub`). */
  readonly userId: string
  /** Session Clerk (`sid`), null si absente. */
  readonly sessionId: string | null
  /** `publicMetadata.role` (claim personnalisé `metadata`), null s'il est absent. */
  readonly role: string | null
  /**
   * Claim `fva` : minutes depuis la vérification du premier et du second facteur (-1 : jamais
   * vérifié pendant la session) ; null si le claim est absent ou mal formé.
   */
  readonly factorVerificationAge: readonly [number, number] | null
  /** Tous les claims vérifiés, tels quels. */
  readonly raw: Readonly<Record<string, unknown>>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

/**
 * Vrai si un jeton (claim `iat`, en secondes) a été émis à partir de `cutoff`. Le claim est
 * arrondi à la seconde inférieure : un jeton émis dans la seconde de la coupure est refusé, et le
 * suivant accepté.
 */
export function issuedAtOrAfter(iat: unknown, cutoff: DateTime): boolean {
  return typeof iat === 'number' && iat * 1000 >= cutoff.toMillis()
}

/** Lit les claims utiles d'un jeton déjà vérifié (signature, dates, `azp`). */
export function sessionClaimsFrom(
  userId: string,
  claims: Record<string, unknown>,
): ClerkSessionClaims {
  const { sid, metadata, fva } = claims
  const role = isRecord(metadata) && typeof metadata.role === 'string' ? metadata.role : null
  const ages: unknown[] = Array.isArray(fva) ? fva : []
  const [first, second] = ages
  return {
    userId,
    sessionId: typeof sid === 'string' ? sid : null,
    role,
    factorVerificationAge:
      ages.length === 2 && isInteger(first) && isInteger(second) ? [first, second] : null,
    raw: claims,
  }
}

/** Jeton de session de test pour un utilisateur ; fourni seulement par bin/test.ts. */
export type ClerkTestTokenFactory = (user: User) => Promise<string>

/**
 * Authentifie une requête par le jeton de session Clerk (`Authorization: Bearer`). Le jeton est
 * vérifié localement (signature, expiration, `azp`) puis relié au miroir local `users`. Kaxolax ne
 * stocke ni mot de passe ni jeton d'authentification.
 */
export class ClerkGuard implements GuardContract<User> {
  static testTokenFactory: ClerkTestTokenFactory | undefined;

  declare [symbols.GUARD_KNOWN_EVENTS]: never

  readonly driverName = 'clerk' as const
  user?: User
  /** Claims du jeton qui a authentifié la requête. */
  claims?: ClerkSessionClaims
  isAuthenticated = false
  authenticationAttempted = false

  constructor(
    private readonly ctx: HttpContext,
    private readonly options: ClerkGuardOptions,
  ) {}

  private unauthorized(reason: string): never {
    logger.debug({ reason }, 'clerk authentication refused')
    throw new UnauthorizedException()
  }

  getUserOrFail(): User {
    if (!this.user) return this.unauthorized('not authenticated')
    return this.user
  }

  /** Claims vérifiés du jeton (rôle, âge des facteurs…), après `authenticate()`. */
  getClaimsOrFail(): ClerkSessionClaims {
    if (!this.claims) return this.unauthorized('not authenticated')
    return this.claims
  }

  async authenticate(): Promise<User> {
    if (this.authenticationAttempted) return this.getUserOrFail()
    this.authenticationAttempted = true

    const header = this.ctx.request.header('authorization') ?? ''
    const match = /^Bearer\s+(\S+)$/i.exec(header)
    if (!match?.[1]) return this.unauthorized('missing bearer token')
    if (!this.options.jwtKey) return this.unauthorized('CLERK_JWT_KEY is not configured')

    // Renvoie les claims, ou lève une erreur (signature, expiration, nbf, azp…).
    let claims: Record<string, unknown>
    try {
      claims = await verifyToken(match[1], {
        jwtKey: this.options.jwtKey,
        authorizedParties: this.options.authorizedParties,
      })
    } catch (error) {
      return this.unauthorized(error instanceof Error ? error.message : 'invalid token')
    }
    // Session en attente d'une étape (MFA à configurer, etc.) : pas encore authentifiée.
    if (claims.sts !== undefined && claims.sts !== 'active') {
      return this.unauthorized('session pending')
    }
    if (typeof claims.sub !== 'string' || claims.sub === '') return this.unauthorized('no subject')

    let user = await User.findBy('clerkUserId', claims.sub)
    if (!user) {
      // Jeton reçu avant le webhook user.created : création à la volée, email vérifié exigé.
      const profile = profileFromClaims(claims)
      if (!profile) return this.unauthorized('unknown user without verified email claim')
      const upserted = await upsertClerkUser(profile)
      user = upserted.user
      // Transaction validée : les projets rejoints d'office l'annoncent à leurs membres.
      if (upserted.joined.length > 0) {
        const realtime = await app.container.make(RealtimeClient)
        await announceAutoJoins(realtime, user.id, upserted.joined)
      }
    }
    if (user.deletedAt) return this.unauthorized('deleted user')
    // Banni : ses jetons émis avant le bannissement restent valides jusqu'à 60 s chez Clerk.
    if (user.bannedAt) {
      logger.debug({ userId: user.id }, 'clerk authentication refused: banned user')
      throw new AccountBannedException()
    }
    // Sessions révoquées par l'admin : un jeton émis avant (`iat`, en secondes) reste valide
    // jusqu'à 60 s chez Clerk mais n'ouvre plus rien ici.
    if (user.sessionsRevokedAt && !issuedAtOrAfter(claims.iat, user.sessionsRevokedAt)) {
      return this.unauthorized('session revoked')
    }

    this.user = user
    this.claims = sessionClaimsFrom(claims.sub, claims)
    this.isAuthenticated = true
    return user
  }

  /**
   * Vrai si la requête est authentifiée. Un compte banni n'est pas un simple échec : l'erreur
   * remonte (401 `E_ACCOUNT_BANNED`) pour que l'interface puisse l'expliquer.
   */
  async check(): Promise<boolean> {
    try {
      await this.authenticate()
      return true
    } catch (error) {
      if (error instanceof AccountBannedException) throw error
      if (error instanceof UnauthorizedException) return false
      throw error
    }
  }

  async authenticateAsClient(user: User): Promise<AuthClientResponse> {
    if (!ClerkGuard.testTokenFactory) {
      throw new Error('ClerkGuard.testTokenFactory is only available in tests')
    }
    return { headers: { authorization: `Bearer ${await ClerkGuard.testTokenFactory(user)}` } }
  }
}
