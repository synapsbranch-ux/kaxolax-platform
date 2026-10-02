import PlanLimit from '#models/plan_limit'
import { currentPlanSlug, FREE_PLAN_SLUG } from '#services/plans'

/** Conservation si plan_limits n'a de ligne ni pour le plan ni pour `free` : celle de Free. */
const FALLBACK_RETENTION_DAYS = 1

/**
 * Durée de conservation de l'historique d'un projet, en jours (null : historique complet), selon
 * le plan de son propriétaire (`plan_limits.history_retention_days`, plan `free` par défaut).
 * Fonction isolée, à remplacer par `historyRetention(user)` de la tâche 12 (Billing).
 */
export async function historyRetentionDays(ownerId: string): Promise<number | null> {
  const plan = await currentPlanSlug(ownerId)
  const limits = (await PlanLimit.find(plan)) ?? (await PlanLimit.find(FREE_PLAN_SLUG))
  return limits ? limits.historyRetentionDays : FALLBACK_RETENTION_DAYS
}
