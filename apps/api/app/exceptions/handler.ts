import app from '@adonisjs/core/services/app'
import { ExceptionHandler, type HttpContext } from '@adonisjs/core/http'

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined
}

export default class HttpExceptionHandler extends ExceptionHandler {
  /** Détails des erreurs (pile d'appels) seulement en développement. */
  protected override debug = !app.inProduction

  override async handle(error: unknown, ctx: HttpContext) {
    // Shield redirige par défaut (formulaires HTML) ; une API répond 403 en JSON.
    if (codeOf(error) === 'E_BAD_CSRF_TOKEN') {
      ctx.response
        .status(403)
        .send({ code: 'E_BAD_CSRF_TOKEN', message: 'Invalid or missing CSRF token' })
      return
    }
    await super.handle(error, ctx)
  }

  override async report(error: unknown, ctx: HttpContext) {
    await super.report(error, ctx)
  }
}
