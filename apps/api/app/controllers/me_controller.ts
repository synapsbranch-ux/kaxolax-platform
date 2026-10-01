import type { HttpContext } from '@adonisjs/core/http'
import type User from '#models/user'

export function serializeUser(user: User) {
  return {
    id: user.id,
    email: user.email,
    fullName: user.fullName,
    avatarUrl: user.avatarUrl,
    emailVerifiedAt: user.emailVerifiedAt?.toUTC().toISO() ?? null,
    createdAt: user.createdAt.toUTC().toISO(),
  }
}

export default class MeController {
  /** L'utilisateur local relié au jeton (id interne, utilisé par l'interface). */
  show({ auth }: HttpContext) {
    return { user: serializeUser(auth.getUserOrFail()) }
  }
}
