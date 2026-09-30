import { HttpContext } from '@adonisjs/core/http'
import { Logger } from '@adonisjs/core/logger'
import type { NextFn } from '@adonisjs/core/types/http'

export default class ContainerBindingsMiddleware {
  async handle(ctx: HttpContext, next: NextFn) {
    ctx.containerResolver.bindValue(HttpContext, ctx)
    ctx.containerResolver.bindValue(Logger, ctx.logger)
    await next()
  }
}
