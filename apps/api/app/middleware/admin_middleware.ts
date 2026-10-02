import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import { assertAdminAccess } from '#services/admin_access'
import ClerkBackend from '#services/clerk_backend'

/**
 * Routes de l'admin : compte authentifié par le guard clerk (middleware `auth` avant celui-ci),
 * rôle admin et MFA (403 `E_ADMIN_REQUIRED` ou `E_ADMIN_MFA_REQUIRED`).
 */
@inject()
export default class AdminMiddleware {
  constructor(private readonly clerk: ClerkBackend) {}

  async handle(ctx: HttpContext, next: NextFn) {
    const guard = ctx.auth.use('clerk')
    await guard.authenticate()
    await assertAdminAccess(this.clerk, guard.getClaimsOrFail())
    await next()
  }
}
