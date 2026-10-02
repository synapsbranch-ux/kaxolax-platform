import { z } from 'zod'

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

/** Features des plans, par slug du Dashboard Clerk (claim `fea` du jeton de session). */
export const PLAN_FEATURES = [
  'long_compile',
  'unlimited_collaborators',
  'full_history',
  'extra_storage',
] as const
export const planFeatureSchema = z.enum(PLAN_FEATURES)
export type PlanFeature = z.infer<typeof planFeatureSchema>

/** Limites appliquées par l'API (chacune levée par une feature). */
export const planLimitNameSchema = z.enum(['compile_time', 'collaborators', 'storage', 'history'])
export type PlanLimitName = z.infer<typeof planLimitNameSchema>

/** Feature qui lève chaque limite (plan_limits garde la valeur chiffrée). */
export const PLAN_LIMIT_FEATURES: Record<PlanLimitName, PlanFeature> = {
  compile_time: 'long_compile',
  collaborators: 'unlimited_collaborators',
  storage: 'extra_storage',
  history: 'full_history',
}

/**
 * Corps d'un refus 403 `E_PLAN_LIMIT`, commun à toutes les limites. `limit.max` : secondes de
 * compilation, collaborateurs (en plus du propriétaire), octets de stockage ou jours d'historique.
 * `current` : usage au moment du refus, si connu. `upgradeUrl` : page de tarifs.
 */
export const planLimitErrorSchema = z.object({
  code: z.literal('E_PLAN_LIMIT'),
  message: z.string(),
  limit: z.object({
    name: planLimitNameSchema,
    /** Slug du plan Clerk dont la limite s'applique (celui du propriétaire du projet). */
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
