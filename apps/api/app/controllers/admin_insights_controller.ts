import { ADMIN_DEFAULT_PAGE_SIZE } from '@kaxolax/contracts'
import type { HttpContext } from '@adonisjs/core/http'
import { listAuditLog } from '#services/admin_audit'
import { adminStats, statsPeriod } from '#services/admin_stats'
import { adminStatsQueryValidator, auditLogQueryValidator } from '#validators/admin'

/** Admin : statistiques et journal des actions (lecture seule). */
export default class AdminInsightsController {
  async stats({ request }: HttpContext) {
    const { from, to } = await request.validateUsing(adminStatsQueryValidator, {
      data: request.qs(),
    })
    return adminStats(statsPeriod({ from, to }))
  }

  async auditLog({ request }: HttpContext) {
    const { page, perPage, ...filters } = await request.validateUsing(auditLogQueryValidator, {
      data: request.qs(),
    })
    return listAuditLog({
      ...filters,
      page: page ?? 1,
      perPage: perPage ?? ADMIN_DEFAULT_PAGE_SIZE,
    })
  }
}
