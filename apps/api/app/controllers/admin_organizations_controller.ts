import { ADMIN_DEFAULT_PAGE_SIZE } from '@kaxolax/contracts'
import type { HttpContext } from '@adonisjs/core/http'
import { organizationDetail, searchOrganizations } from '#services/admin_organizations'
import { adminUsersQueryValidator } from '#validators/admin'

/** Admin : organisations Clerk (workspaces d'équipe) et leur plan, en lecture seule. */
export default class AdminOrganizationsController {
  async index({ request }: HttpContext) {
    // Mêmes paramètres que la liste des comptes : `q`, `page`, `perPage`.
    const { q, page, perPage } = await request.validateUsing(adminUsersQueryValidator, {
      data: request.qs(),
    })
    return searchOrganizations({ q, page: page ?? 1, perPage: perPage ?? ADMIN_DEFAULT_PAGE_SIZE })
  }

  /** Fiche d'une organisation (identifiant Clerk `org_…`) : membres et projets. */
  async show({ params }: HttpContext) {
    return organizationDetail(String(params.id))
  }
}
