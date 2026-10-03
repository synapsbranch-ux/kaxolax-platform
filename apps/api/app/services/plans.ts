import { FREE_PLAN } from '@kaxolax/contracts'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type User from '#models/user'
import { accountOfProject, limitsOfAccount } from '#services/entitlements'

/** Plan d'un compte sans abonnement en cours (slug du plan par défaut de Clerk Billing). */
export const FREE_PLAN_SLUG = FREE_PLAN

/**
 * Statuts Clerk comptés comme abonnement en cours par l'admin (fiche, statistiques). Les droits
 * (#services/entitlements) gardent en plus un abonnement résilié jusqu'à la fin de sa période.
 */
export const CURRENT_SUBSCRIPTION_STATUSES = ['active', 'past_due']

/**
 * Limite de collaborateurs (en plus du propriétaire) d'un projet : plan de son propriétaire, ou de
 * l'organisation pour un projet d'équipe ; null = illimité. Lue par le service des droits : claims
 * du jeton s'ils concernent ce compte (`requester`), sinon miroir des abonnements.
 */
export async function collaboratorLimit(
  project: { ownerId: string; workspaceId: string },
  client?: TransactionClientContract,
  requester?: User | null,
): Promise<{ plan: string; max: number | null }> {
  const limits = await limitsOfAccount(await accountOfProject(project, client), requester, client)
  return { plan: limits.entitlements.plan, max: limits.maxCollaborators }
}
