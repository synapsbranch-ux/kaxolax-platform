import type { HttpContext } from '@adonisjs/core/http'
import { activeBanners } from '#services/banner_service'

export default class BannersController {
  /** Bannières système affichées maintenant, pour tout utilisateur connecté. */
  async active({ response }: HttpContext) {
    // Relue toutes les 60 s par chaque onglet : jamais mise en cache par un intermédiaire.
    response.header('cache-control', 'no-store')
    return { banners: await activeBanners() }
  }
}
