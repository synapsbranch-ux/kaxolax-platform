import type { Authenticators } from '@adonisjs/auth/types'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { UnauthorizedException } from '#auth/clerk_guard'
import clerkConfig from '#config/clerk'

/** Guards acceptés selon AUTH_MODE, le temps de la migration de l'étape 1 vers Clerk. */
const GUARDS_BY_MODE: Record<typeof clerkConfig.authMode, (keyof Authenticators)[]> = {
  session: ['web'],
  dual: ['clerk', 'web'],
  clerk: ['clerk'],
}

/** Refuse (401) les requêtes sans jeton Clerk valide (ni session, pendant la migration). */
export default class AuthMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    // Une requête porteuse d'un Bearer est exemptée du CSRF : elle ne doit jamais retomber sur le
    // cookie de session si le jeton est refusé.
    const bearer = /^Bearer\s/i.test(ctx.request.header('authorization') ?? '')
    const guards = GUARDS_BY_MODE[clerkConfig.authMode]
    const allowed = bearer ? guards.filter((guard) => guard === 'clerk') : guards
    if (allowed.length === 0) {
      throw new UnauthorizedException()
    }
    await ctx.auth.authenticateUsing(allowed)
    await next()
  }
}
