import { z } from 'zod'
import { aiCreditsSchema } from './ai.js'

/**
 * Abonnements (Clerk Billing) : plans utilisateur définis dans le Dashboard Clerk, features par
 * slug, limites chiffrées gardées par Kaxolax (table plan_limits) et refus 403 `E_PLAN_LIMIT`.
 * Contrats de `GET /api/v1/me/plan` et du corps des refus.
 */

const count = z.number().int().nonnegative()

/** Slug du plan par défaut (Free) dans le Dashboard Clerk. */
export const FREE_PLAN = 'free'
/** Slug du plan payant (Pro) dans le Dashboard Clerk. */
export const PRO_PLAN = 'pro'
/**
 * Slug du plan d'organisation (Team, par siège) dans le Dashboard Clerk. Ses crédits IA et images
 * (`plan_limits.credits_per_seat`) sont multipliés par le nombre de membres de l'équipe.
 */
export const TEAM_PLAN = 'team'

/**
 * Features des plans, par slug du Dashboard Clerk (claim `fea` du jeton de session). `ai` lève
 * les crédits IA et images mensuels au-delà de ceux de Free.
 */
export const PLAN_FEATURES = [
  'long_compile',
  'unlimited_collaborators',
  'full_history',
  'extra_storage',
  'ai',
] as const
export const planFeatureSchema = z.enum(PLAN_FEATURES)
export type PlanFeature = z.infer<typeof planFeatureSchema>

/**
 * Limites appliquées par l'API (chacune levée par une feature). Pour un projet personnel : les
 * crédits (`ai_credits`, `image_credits`) sont ceux du plan de l'utilisateur qui lance l'action,
 * les autres ceux du propriétaire du projet. Pour un projet d'équipe : toutes sont celles du plan
 * de l'organisation (stockage et crédits mutualisés).
 */
export const planLimitNameSchema = z.enum([
  'compile_time',
  'collaborators',
  'storage',
  'history',
  'ai_credits',
  'image_credits',
])
export type PlanLimitName = z.infer<typeof planLimitNameSchema>

/** Feature qui lève chaque limite (plan_limits garde la valeur chiffrée). */
export const PLAN_LIMIT_FEATURES: Record<PlanLimitName, PlanFeature> = {
  compile_time: 'long_compile',
  collaborators: 'unlimited_collaborators',
  storage: 'extra_storage',
  history: 'full_history',
  ai_credits: 'ai',
  image_credits: 'ai',
}

/**
 * Corps d'un refus 403 `E_PLAN_LIMIT`, commun à toutes les limites. `limit.max` : secondes de
 * compilation, collaborateurs (en plus du propriétaire), octets de stockage, jours d'historique,
 * crédits IA ou images du mois. `current` : usage au moment du refus, si connu (crédits arrondis
 * à l'unité supérieure). `upgradeUrl` : page de tarifs.
 */
export const planLimitErrorSchema = z.object({
  code: z.literal('E_PLAN_LIMIT'),
  message: z.string(),
  limit: z.object({
    name: planLimitNameSchema,
    /**
     * Slug du plan Clerk dont la limite s'applique : celui du propriétaire du projet, ou de
     * l'organisation pour un projet d'équipe.
     */
    plan: z.string(),
    max: count,
  }),
  feature: planFeatureSchema,
  current: count.optional(),
  upgradeUrl: z.url(),
})
export type PlanLimitError = z.infer<typeof planLimitErrorSchema>

/** Limites effectives d'un compte ; null : illimité (collaborateurs) ou complet (historique). */
export const planLimitsSchema = z.object({
  maxCompileSeconds: z.number().int().positive(),
  maxCollaborators: count.nullable(),
  historyRetentionDays: z.number().int().positive().nullable(),
  storageBytes: count,
})
export type PlanLimits = z.infer<typeof planLimitsSchema>

/** `GET /api/v1/me/plan` : plan, features, limites et usage du compte connecté. */
export const mePlanResponseSchema = z.object({
  plan: z.string(),
  /** D'où viennent les droits : claims du jeton, miroir des webhooks, ou plan par défaut. */
  source: z.enum(['claims', 'subscription', 'default']),
  features: z.array(planFeatureSchema),
  limits: planLimitsSchema,
  usage: z.object({
    /** Octets des fichiers et documents de ses projets. */
    storageBytes: count,
    /** Plus grand nombre de collaborateurs (membres et invitations) parmi ses projets. */
    maxCollaboratorsInProject: count,
  }),
  /** Crédits IA et images du mois en cours (plan du compte connecté). */
  credits: aiCreditsSchema,
  /** Élément d'abonnement du plan en cours dans le miroir (statut Clerk, fin de période). */
  subscription: z
    .object({
      status: z.string(),
      periodEnd: z.iso.datetime().nullable(),
    })
    .nullable(),
  upgradeUrl: z.url(),
})
export type MePlanResponse = z.infer<typeof mePlanResponseSchema>

/**
 * `GET /api/v1/workspaces/:id/plan` (tout membre d'une équipe) : plan de l'organisation, limites
 * mutualisées, usage du workspace et crédits du mois (multipliés par les sièges pour un plan par
 * siège). `source` comme `mePlanResponseSchema` (claims de l'organisation active, miroir des
 * webhooks d'abonnement d'organisation, ou plan par défaut).
 */
export const workspacePlanResponseSchema = z.object({
  workspaceId: z.uuid(),
  plan: z.string(),
  /**
   * Plan payant actif : sans lui, aucun projet ne peut entrer dans l'équipe (403
   * `E_TEAM_PLAN_REQUIRED`) et la réserve de crédits est vide (l'IA est imputée à l'auteur).
   */
  active: z.boolean(),
  source: z.enum(['claims', 'subscription', 'default']),
  features: z.array(planFeatureSchema),
  limits: planLimitsSchema,
  /** Membres de l'équipe (sièges facturés par Clerk pour un plan par siège). */
  seats: count,
  /** Crédits du plan multipliés par les sièges. */
  perSeat: z.boolean(),
  usage: z.object({ storageBytes: count }),
  credits: aiCreditsSchema,
  subscription: z
    .object({
      status: z.string(),
      periodEnd: z.iso.datetime().nullable(),
    })
    .nullable(),
  upgradeUrl: z.url(),
})
export type WorkspacePlanResponse = z.infer<typeof workspacePlanResponseSchema>

/**
 * Message sans état (stateless Hocuspocus) du service temps réel quand le stockage du propriétaire
 * du projet devient plein (`full`, la connexion passe en lecture seule : les modifications sont
 * refusées) ou de nouveau disponible. `plan`, `max` (octets) et `current` : comme `limit` et
 * `current` d'un refus `E_PLAN_LIMIT` de limite `storage`.
 */
export const storageStateMessageSchema = z.object({
  type: z.literal('plan.storage'),
  full: z.boolean(),
  plan: z.string(),
  max: count,
  /** Usage de tout le compte : envoyé au seul propriétaire du projet. */
  current: count.optional(),
})
export type StorageStateMessage = z.infer<typeof storageStateMessageSchema>

// --- Webhooks Billing de Clerk (sous-ensemble lu par l'API) ---------------------------------

const clerkBillingPayerSchema = z
  .object({
    user_id: z.string().min(1).nullish(),
    organization_id: z.string().min(1).nullish(),
  })
  .nullish()
export type ClerkBillingPayer = z.infer<typeof clerkBillingPayerSchema>

/** Élément d'abonnement (`data` des événements `subscriptionItem.*`, `items[]` de `subscription.*`). */
export const clerkBillingItemSchema = z.object({
  id: z.string().min(1).max(64),
  /** Statut Clerk : active, past_due, canceled, ended, upcoming, incomplete, abandoned… */
  status: z.string().min(1).max(32),
  /** Fin de la période en cours, en millisecondes. */
  period_end: z.number().nullish(),
  plan: z
    .object({
      slug: z.string().min(1).max(64),
      name: z.string().nullish(),
      is_default: z.boolean().nullish(),
    })
    .nullish(),
  payer: clerkBillingPayerSchema,
})
export type ClerkBillingItem = z.infer<typeof clerkBillingItemSchema>

/** Abonnement (`data` des événements `subscription.*`). */
export const clerkBillingSubscriptionSchema = z.object({
  items: z.array(clerkBillingItemSchema),
  payer: clerkBillingPayerSchema,
  updated_at: z.number().nullish(),
})
