import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import PlanLimit from '#models/plan_limit'
import Subscription from '#models/subscription'

/** Plan d'un compte sans abonnement en cours (slug du plan par défaut de Clerk Billing). */
export const FREE_PLAN_SLUG = 'free'

/** Statuts Clerk d'un abonnement qui donne encore accès à son plan. */
export const CURRENT_SUBSCRIPTION_STATUSES = ['active', 'past_due']

/**
 * Limite de collaborateurs si la table plan_limits n'a pas de ligne pour le plan (ni pour `free`) :
 * la valeur de départ du plan Free, jamais « illimité » par accident.
 */
const FALLBACK_MAX_COLLABORATORS = 1

/**
 * Slug du plan en cours d'un compte, lu dans le miroir des abonnements (webhooks Billing) : un
 * plan payant passe avant `free`, puis le plus récent. Sert aux limites d'un projet, qui sont
 * celles de son propriétaire même quand la requête vient d'un autre compte.
 */
export async function currentPlanSlug(
  userId: string,
  client?: TransactionClientContract,
): Promise<string> {
  const subscription = await Subscription.query({ client })
    .where('user_id', userId)
    .whereIn('status', CURRENT_SUBSCRIPTION_STATUSES)
    .orderByRaw('(plan_slug = ?) ASC, updated_at DESC', [FREE_PLAN_SLUG])
    .first()
  return subscription?.planSlug ?? FREE_PLAN_SLUG
}

/** Limite de collaborateurs (en plus du propriétaire) du plan d'un compte ; null = illimité. */
export async function collaboratorLimit(
  userId: string,
  client?: TransactionClientContract,
): Promise<{ plan: string; max: number | null }> {
  const plan = await currentPlanSlug(userId, client)
  const limits =
    (await PlanLimit.find(plan, { client })) ?? (await PlanLimit.find(FREE_PLAN_SLUG, { client }))
  return { plan, max: limits ? limits.maxCollaborators : FALLBACK_MAX_COLLABORATORS }
}
