import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'

/** L'API ne répond qu'en JSON, y compris pour les erreurs. */
export default class ForceJsonResponseMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    ctx.request.request.headers.accept = 'application/json'
    await next()
  }
}
