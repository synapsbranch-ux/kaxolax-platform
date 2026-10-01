import { ADMIN_DEFAULT_PAGE_SIZE } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import {
  createBanner,
  deleteBanner,
  endBanner,
  listBanners,
  updateBanner,
} from '#services/banner_service'
import RealtimeClient from '#services/realtime_client'
import {
  adminPageQueryValidator,
  createBannerValidator,
  updateBannerValidator,
} from '#validators/admin'

/** Admin : bannières système (création, modification, suppression). */
@inject()
export default class AdminBannersController {
  constructor(private readonly realtime: RealtimeClient) {}

  async index({ request }: HttpContext) {
    const { page, perPage } = await request.validateUsing(adminPageQueryValidator, {
      data: request.qs(),
    })
    return listBanners(page ?? 1, perPage ?? ADMIN_DEFAULT_PAGE_SIZE)
  }

  async store({ request, response, auth }: HttpContext) {
    const input = await request.validateUsing(createBannerValidator)
    const banner = await createBanner(auth.getUserOrFail(), input, this.realtime)
    response.created({ banner })
  }

  async update({ params, request, auth }: HttpContext) {
    const changes = await request.validateUsing(updateBannerValidator)
    return {
      banner: await updateBanner(auth.getUserOrFail(), String(params.id), changes, this.realtime),
    }
  }

  /** Termine la bannière à l'heure du serveur. */
  async end({ params, auth }: HttpContext) {
    return { banner: await endBanner(auth.getUserOrFail(), String(params.id), this.realtime) }
  }

  async destroy({ params, auth, response }: HttpContext) {
    await deleteBanner(auth.getUserOrFail(), String(params.id), this.realtime)
    response.noContent()
  }
}
