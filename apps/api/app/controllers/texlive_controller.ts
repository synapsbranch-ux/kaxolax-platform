import { createHash } from 'node:crypto'
import { packageSuggestionsQuerySchema, texlivePackagesQuerySchema } from '@kaxolax/contracts'
import type { HttpContext } from '@adonisjs/core/http'
import texliveConfig from '#config/texlive'
import { texliveIndex } from '#services/texlive_index'
import { validateWithZod } from '#validators/zod'

/**
 * Index des packages TeX Live (gestionnaire de packages, erreur « File `xyz.sty' not found ») :
 * données publiques, mais servies aux seuls utilisateurs connectés. Chaque réponse porte un ETag
 * dérivé de celui de l'index et de l'URL : une requête `If-None-Match` reçoit 304 sans corps.
 */
export default class TexliveController {
  /** Pose ETag et Cache-Control ; vrai si le client a déjà cette version (304 envoyé). */
  private async notModified({ request, response }: HttpContext): Promise<boolean> {
    const key = `${await texliveIndex.etag()}\n${request.url(true)}`
    const etag = `W/"${createHash('sha256').update(key).digest('base64url').slice(0, 32)}"`
    response.header('etag', etag)
    response.header(
      'cache-control',
      `private, max-age=${String(texliveConfig.clientMaxAgeSeconds)}`,
    )
    if (!response.fresh()) return false
    response.status(304).send(null)
    return true
  }

  /** `GET /texlive/packages?q=&category=&topic=&page=&perPage=` */
  async index(ctx: HttpContext) {
    const query = validateWithZod(texlivePackagesQuerySchema, ctx.request.qs())
    if (await this.notModified(ctx)) return
    return texliveIndex.search(query)
  }

  /** `GET /texlive/packages/:name` : nom TeX Live (`graphics`) ou de fichier `.sty` (`graphicx`). */
  async show(ctx: HttpContext) {
    const detail = await texliveIndex.show(String(ctx.params.name))
    if (await this.notModified(ctx)) return
    return detail
  }

  /** `GET /texlive/suggestions?name=amsmth.sty` : noms proches d'un package introuvable. */
  async suggestions(ctx: HttpContext) {
    const { name } = validateWithZod(packageSuggestionsQuerySchema, ctx.request.qs())
    if (await this.notModified(ctx)) return
    return texliveIndex.suggest(name)
  }
}
