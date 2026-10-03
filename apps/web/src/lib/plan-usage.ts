import { FREE_PLAN, type MePlanResponse, type PlanFeature, PRO_PLAN } from '@kaxolax/contracts'
import { formatBytes, formatSeconds, planLabel } from './plan-limits'

/**
 * Plan et usage du compte pour l'affichage (`GET /me/plan`, menu du compte, /account/plan et
 * paramètres). Rien n'est appliqué ici : chaque limite est appliquée par l'API.
 */

/** Page de l'onglet Billing de <UserProfile /> (abonnement, factures, moyens de paiement). */
export const BILLING_URL = '/account/billing'
/** Page « Plan et usage » ajoutée à <UserProfile />. */
export const PLAN_USAGE_URL = '/account/plan'

export interface PlanUsageRow {
  label: string
  value: string
  /** Part utilisée, entre 0 et 1, pour une jauge (stockage) ; absente sinon. */
  ratio?: number
}

export interface PlanUsageView {
  plan: string
  rows: PlanUsageRow[]
  /** État de l'abonnement payant, ou null (plan gratuit, aucun abonnement connu). */
  subscription: string | null
  /** Stockage plein : plus aucun ajout possible dans ses projets. */
  storageFull: boolean
}

const dateFormat = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeZone: 'UTC' })

/** État d'un abonnement (personnel ou d'équipe) pour l'affichage, null sans abonnement. */
export function subscriptionLabel(subscription: MePlanResponse['subscription']): string | null {
  if (subscription === null) return null
  const end =
    subscription.periodEnd === null ? null : dateFormat.format(new Date(subscription.periodEnd))
  switch (subscription.status) {
    case 'active':
      return end === null ? 'Abonnement actif' : `Abonnement actif, renouvelé le ${end}`
    case 'past_due':
      return 'Paiement en retard : mettez à jour votre moyen de paiement'
    case 'canceled':
      return end === null ? 'Abonnement annulé' : `Abonnement annulé, actif jusqu’au ${end}`
    default:
      return `Abonnement : ${subscription.status}`
  }
}

const creditFormat = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 })

/** Crédits du mois : consommés sur le total et date de remise à zéro, avec une jauge. */
export function creditRow(
  label: string,
  balance: MePlanResponse['credits']['ai'],
  resetsAt: string,
): PlanUsageRow {
  const reset = dateFormat.format(new Date(resetsAt))
  return {
    label,
    value: `${creditFormat.format(balance.used)} sur ${creditFormat.format(balance.monthly)}, remis à zéro le ${reset}`,
    ratio: balance.monthly === 0 ? 1 : Math.min(1, balance.used / balance.monthly),
  }
}

/**
 * Lignes affichées : stockage (jauge), durée de compilation, collaborateurs, historique, crédits
 * IA et images du mois (jauges, remis à zéro le 1er).
 */
export function planUsageView(plan: MePlanResponse): PlanUsageView {
  const { limits, usage } = plan
  const ratio =
    limits.storageBytes === 0 ? 1 : Math.min(1, usage.storageBytes / limits.storageBytes)
  const collaborators =
    limits.maxCollaborators === null ? 'Illimités' : `${String(limits.maxCollaborators)} par projet`
  return {
    plan: planLabel(plan.plan),
    rows: [
      {
        label: 'Stockage',
        value: `${formatBytes(usage.storageBytes)} sur ${formatBytes(limits.storageBytes)}`,
        ratio,
      },
      {
        label: 'Durée de compilation',
        value: `${formatSeconds(limits.maxCompileSeconds)} au plus par compilation`,
      },
      {
        label: 'Collaborateurs',
        value: `${collaborators} (le plus grand de vos projets : ${String(usage.maxCollaboratorsInProject)})`,
      },
      {
        label: 'Historique',
        value:
          limits.historyRetentionDays === null
            ? 'Complet'
            : `${String(limits.historyRetentionDays)} jour${limits.historyRetentionDays > 1 ? 's' : ''}`,
      },
      creditRow('Crédits IA', plan.credits.ai, plan.credits.resetsAt),
      creditRow('Images', plan.credits.images, plan.credits.resetsAt),
    ],
    subscription: subscriptionLabel(plan.subscription),
    storageFull: usage.storageBytes >= limits.storageBytes,
  }
}

/** Libellés des features des plans (slugs du Dashboard Clerk). */
export const PLAN_FEATURE_LABELS: Record<PlanFeature, string> = {
  ai: 'Crédits IA et images étendus',
  long_compile: 'Compilations longues',
  unlimited_collaborators: 'Collaborateurs illimités',
  full_history: 'Historique complet',
  extra_storage: 'Stockage étendu',
}

/**
 * Plan de la session d'après Clerk (`has({ plan: USER_PRO_PLAN })`, claims du jeton) : badge et
 * menu du compte, avant même la réponse de l'API. Affichage seulement.
 */
export function sessionPlan(isPro: boolean): string {
  return isPro ? PRO_PLAN : FREE_PLAN
}

/**
 * Plan Pro de portée utilisateur pour `has()` de Clerk : sans préfixe, `has` accepte aussi les
 * plans de l'organisation active (`o:`), qui ne sont pas ceux du compte.
 */
export const USER_PRO_PLAN = `u:${PRO_PLAN}`

/** Feature de portée utilisateur pour `has()` de Clerk (voir `USER_PRO_PLAN`). */
export function userFeature(feature: PlanFeature): `u:${PlanFeature}` {
  return `u:${feature}`
}
