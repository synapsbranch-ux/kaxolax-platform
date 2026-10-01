import app from '@adonisjs/core/services/app'
import { ExceptionHandler, type HttpContext } from '@adonisjs/core/http'

export default class HttpExceptionHandler extends ExceptionHandler {
  /** Détails des erreurs (pile d'appels) seulement en développement. */
  protected override debug = !app.inProduction

  override async handle(error: unknown, ctx: HttpContext) {
    await super.handle(error, ctx)
  }

  override async report(error: unknown, ctx: HttpContext) {
    await super.report(error, ctx)
  }
}
