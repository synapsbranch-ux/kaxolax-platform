import type { MePlanResponse } from '@kaxolax/contracts'
import type { HttpContext } from '@adonisjs/core/http'
import { pricingUrl } from '#exceptions/plan_limit'
import Subscription from '#models/subscription'
import { isoString } from '#services/dates'
import { limitsOf } from '#services/entitlements'
import { maxCollaboratorsInOwnedProjects, storageUsage } from '#services/plan_enforcement'

export default class PlanController {
  /**
   * Plan du compte connecté pour l'interface : plan et features (claims du jeton, sinon miroir des
   * webhooks), limites effectives, usage, et abonnement payant du miroir. Affichage seulement :
   * chaque limite est appliquée par la route concernée.
   */
  async show({ auth }: HttpContext): Promise<MePlanResponse> {
    const user = auth.getUserOrFail()
    const limits = await limitsOf(user, user)
    const subscription = await Subscription.query()
      .where('userId', user.id)
      .where('planSlug', limits.entitlements.plan)
      .orderBy('updatedAt', 'desc')
      .first()
    return {
      plan: limits.entitlements.plan,
      source: limits.entitlements.source,
      features: [...limits.entitlements.features].sort(),
      limits: {
        maxCompileSeconds: limits.maxCompileSeconds,
        maxCollaborators: limits.maxCollaborators,
        historyRetentionDays: limits.historyRetentionDays,
        storageBytes: limits.storageBytes,
      },
      usage: {
        storageBytes: await storageUsage(user.id),
        maxCollaboratorsInProject: await maxCollaboratorsInOwnedProjects(user.id),
      },
      subscription: subscription
        ? {
            status: subscription.status,
            periodEnd: subscription.periodEnd ? isoString(subscription.periodEnd) : null,
          }
        : null,
      upgradeUrl: pricingUrl(),
    }
  }
}
