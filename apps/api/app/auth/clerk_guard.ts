import { verifyToken } from '@clerk/backend'
import { symbols } from '@adonisjs/auth'
import type { AuthClientResponse, GuardContract } from '@adonisjs/auth/types'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import User from '#models/user'
import { profileFromClaims, upsertClerkUser } from '#services/clerk_users'

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
      user = await upsertClerkUser(profile)
    }
    if (user.deletedAt) return this.unauthorized('deleted user')

    this.user = user
    this.isAuthenticated = true
    return user
  }

  async check(): Promise<boolean> {
    try {
      await this.authenticate()
      return true
    } catch (error) {
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
