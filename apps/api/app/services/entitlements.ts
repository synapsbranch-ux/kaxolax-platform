import {
  FREE_PLAN,
  PLAN_FEATURES,
  PLAN_LIMIT_FEATURES,
  type PlanFeature,
  type PlanLimits,
} from '@kaxolax/contracts'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type User from '#models/user'

/**
 * Droits d'un compte (Clerk Billing). Le plan et les features viennent des claims `pla` et `fea`
 * du jeton de session vérifié de la requête (même lecture que `has()` de Clerk), sinon de la plus
 * récente des deux sources enregistrées (relevé des claims du dernier jeton du compte, miroir
 * `subscriptions` alimenté par les webhooks), sinon du plan par défaut `free`. Les valeurs chiffrées viennent de
 * plan_limits (cache court). Une limite dont la feature manque retombe sur la valeur de Free.
 */

export type EntitlementSource = 'claims' | 'subscription' | 'default'

export interface Entitlements {
  /** Slug du plan Clerk. */
  readonly plan: string
  readonly features: ReadonlySet<PlanFeature>
  readonly source: EntitlementSource
}

/**
 * Limites effectives d'un compte, avec le plan et les droits dont elles viennent. `aiCredits` et
 * `imageCredits` : crédits du mois (1 crédit IA = 0,01 $ de coût d'API ; 1 crédit image = une
 * image), levés au-delà de ceux de Free par la feature `ai`.
 */
export interface EffectiveLimits extends PlanLimits {
  readonly entitlements: Entitlements
  readonly aiCredits: number
  readonly imageCredits: number
}

/** Ligne de plan_limits (null = illimité, historique complet). */
export interface PlanLimitRow {
  planSlug: string
  maxCompileSeconds: number
  maxCollaborators: number | null
  historyRetentionDays: number | null
  storageBytes: number
  aiMonthlyCredits: number
  imageMonthlyCredits: number
}

/** Statuts Clerk d'un élément d'abonnement qui donne accès à son plan. */
export const ACCESS_STATUSES = ['active', 'past_due'] as const
/** Abonnement résilié : son plan reste acquis jusqu'à la fin de la période payée. */
export const CANCELED_STATUS = 'canceled'

/**
 * Valeurs du plan Free si plan_limits n'a pas de ligne `free` (base incomplète) : jamais
 * « illimité » par accident. Mêmes valeurs que les migrations 0020 et 0131.
 */
const FREE_FALLBACK: PlanLimitRow = {
  planSlug: FREE_PLAN,
  maxCompileSeconds: 20,
  maxCollaborators: 1,
  historyRetentionDays: 1,
  storageBytes: 500 * 1024 * 1024,
  aiMonthlyCredits: 100,
  imageMonthlyCredits: 5,
}

// --- Claims du jeton (has() côté serveur) ---------------------------------------------------

/**
 * Valeurs de portée utilisateur d'un claim Clerk `pla` ou `fea` : liste séparée par des virgules
 * d'éléments `portée:valeur`, portée `u` (utilisateur), `o` (organisation) ou `ou`/`uo` (les
 * deux), comme `splitByScope` de @clerk/shared. Un élément mal formé est ignoré.
 */
export function userScopedValues(claim: unknown): string[] {
  if (typeof claim !== 'string' || claim.trim() === '') return []
  const values: string[] = []
  for (const part of claim.split(',')) {
    const element = part.trim()
    const colon = element.indexOf(':')
    if (colon === -1) continue
    const scope = element.slice(0, colon)
    const value = element.slice(colon + 1)
    if (value !== '' && (scope === 'u' || scope === 'ou' || scope === 'uo')) values.push(value)
  }
  return values
}

function isPlanFeature(value: string): value is PlanFeature {
  return (PLAN_FEATURES as readonly string[]).includes(value)
}

/**
 * Droits lus dans les claims d'un jeton de session vérifié : `pla` (ex. `u:pro`) et `fea` (ex.
 * `u:long_compile,u:full_history`). Null si le jeton ne porte pas de plan utilisateur (Billing
 * désactivé, ancien format de jeton) : l'appelant se replie sur le miroir.
 */
export function entitlementsFromClaims(
  claims: Readonly<Record<string, unknown>>,
): Entitlements | null {
  const [plan] = userScopedValues(claims.pla)
  if (plan === undefined) return null
  return {
    plan,
    features: new Set(userScopedValues(claims.fea).filter(isPlanFeature)),
    source: 'claims',
  }
}

/**
 * Équivalent de `has({ plan })` / `has({ feature })` de Clerk : vrai si tout ce qui est demandé est
 * accordé (ET), faux si rien n'est demandé.
 */
export function has(
  entitlements: Entitlements,
  query: { plan?: string; feature?: PlanFeature },
): boolean {
  if (query.plan === undefined && query.feature === undefined) return false
  if (query.plan !== undefined && entitlements.plan !== query.plan) return false
  if (query.feature !== undefined && !entitlements.features.has(query.feature)) return false
  return true
}

/**
 * Claims vérifiés du jeton qui a authentifié chaque requête, rattachés à l'instance `User` de la
 * requête (posés par le guard clerk) : les services reçoivent déjà cet utilisateur.
 */
const sessionClaims = new WeakMap<User, Readonly<Record<string, unknown>>>()

export function rememberSessionClaims(user: User, claims: Readonly<Record<string, unknown>>) {
  sessionClaims.set(user, claims)
}

// --- Valeurs chiffrées (plan_limits) --------------------------------------------------------

interface CachedRow {
  row: PlanLimitRow | null
  expiresAt: number
}

/** Cache court des lignes de plan_limits, par slug (ligne absente comprise). */
export class PlanLimitsCache {
  private readonly rows = new Map<string, CachedRow>()

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  async get(
    slug: string,
    load: (slug: string) => Promise<PlanLimitRow | null>,
  ): Promise<PlanLimitRow | null> {
    const cached = this.rows.get(slug)
    if (cached && cached.expiresAt > this.now()) return cached.row
    const row = await load(slug)
    this.rows.set(slug, { row, expiresAt: this.now() + this.ttlMs })
    return row
  }

  clear(): void {
    this.rows.clear()
  }
}

/** 60 s : une modification de plan_limits s'applique au plus une minute plus tard. */
export const planLimitsCache = new PlanLimitsCache(60_000)

interface PlanLimitDbRow {
  plan_slug: string
  max_compile_seconds: number
  max_collaborators: number | null
  history_retention_days: number | null
  storage_bytes: string | number
  ai_monthly_credits: number
  image_monthly_credits: number
}

async function loadPlanLimits(slug: string): Promise<PlanLimitRow | null> {
  const row = (await db
    .from('plan_limits')
    .where('plan_slug', slug)
    .first()) as PlanLimitDbRow | null
  if (!row) return null
  return {
    planSlug: row.plan_slug,
    maxCompileSeconds: row.max_compile_seconds,
    maxCollaborators: row.max_collaborators,
    historyRetentionDays: row.history_retention_days,
    // bigint : renvoyé en texte par pg.
    storageBytes: Number(row.storage_bytes),
    aiMonthlyCredits: row.ai_monthly_credits,
    imageMonthlyCredits: row.image_monthly_credits,
  }
}

/** Ligne plan_limits du plan ; un plan inconnu de Kaxolax prend les limites de Free. */
export async function planLimitRow(slug: string): Promise<PlanLimitRow> {
  const row = await planLimitsCache.get(slug, loadPlanLimits)
  if (row) return row
  if (slug !== FREE_PLAN) {
    logger.warn({ plan: slug }, 'plan without plan_limits row, free limits applied')
  }
  return (await planLimitsCache.get(FREE_PLAN, loadPlanLimits)) ?? FREE_FALLBACK
}

/** La plus généreuse de deux valeurs (null = illimité). */
function looser(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : Math.max(a, b)
}

/** La plus stricte de deux valeurs (null = illimité). */
function stricter(a: number | null, b: number | null): number | null {
  if (a === null) return b
  if (b === null) return a
  return Math.min(a, b)
}

/**
 * Features qu'accorde un plan d'après ses valeurs chiffrées (repli sans claims) : chaque limite
 * plus généreuse que celle de Free accorde sa feature.
 */
export function featuresFromLimits(plan: PlanLimitRow, free: PlanLimitRow): Set<PlanFeature> {
  const features = new Set<PlanFeature>()
  if (plan.maxCompileSeconds > free.maxCompileSeconds) features.add('long_compile')
  if (looser(plan.maxCollaborators, free.maxCollaborators) !== free.maxCollaborators) {
    features.add('unlimited_collaborators')
  }
  if (looser(plan.historyRetentionDays, free.historyRetentionDays) !== free.historyRetentionDays) {
    features.add('full_history')
  }
  if (plan.storageBytes > free.storageBytes) features.add('extra_storage')
  if (
    plan.aiMonthlyCredits > free.aiMonthlyCredits ||
    plan.imageMonthlyCredits > free.imageMonthlyCredits
  ) {
    features.add('ai')
  }
  return features
}

/**
 * Limites effectives : valeurs du plan, sauf pour une limite dont la feature n'est pas accordée,
 * ramenée à la plus stricte des valeurs du plan et de Free. Une feature ne dépasse jamais les
 * valeurs du plan.
 */
export function effectiveLimits(
  entitlements: Entitlements,
  plan: PlanLimitRow,
  free: PlanLimitRow,
): EffectiveLimits {
  const granted = (name: keyof typeof PLAN_LIMIT_FEATURES) =>
    entitlements.features.has(PLAN_LIMIT_FEATURES[name])
  return {
    entitlements,
    maxCompileSeconds: granted('compile_time')
      ? plan.maxCompileSeconds
      : Math.min(plan.maxCompileSeconds, free.maxCompileSeconds),
    maxCollaborators: granted('collaborators')
      ? plan.maxCollaborators
      : stricter(plan.maxCollaborators, free.maxCollaborators),
    historyRetentionDays: granted('history')
      ? plan.historyRetentionDays
      : stricter(plan.historyRetentionDays, free.historyRetentionDays),
    storageBytes: granted('storage')
      ? plan.storageBytes
      : Math.min(plan.storageBytes, free.storageBytes),
    aiCredits: granted('ai_credits')
      ? plan.aiMonthlyCredits
      : Math.min(plan.aiMonthlyCredits, free.aiMonthlyCredits),
    imageCredits: granted('image_credits')
      ? plan.imageMonthlyCredits
      : Math.min(plan.imageMonthlyCredits, free.imageMonthlyCredits),
  }
}

// --- Miroir des webhooks ----------------------------------------------------------------------

/**
 * Slug du plan en cours d'après le miroir des abonnements : élément actif ou en retard de
 * paiement, ou résilié dont la période payée court encore ; un plan payant passe avant `free`,
 * puis le plus récent. Null sans abonnement en cours.
 */
export async function mirroredPlanSlug(
  userId: string,
  client?: TransactionClientContract,
): Promise<string | null> {
  const row = (await (client ?? db)
    .from('subscriptions')
    .select('plan_slug')
    .where('user_id', userId)
    .where((query) => {
      void query.whereIn('status', [...ACCESS_STATUSES]).orWhere((canceled) => {
        void canceled.where('status', CANCELED_STATUS).where('period_end', '>', db.raw('now()'))
      })
    })
    .orderByRaw('(plan_slug = ?) ASC, updated_at DESC', [FREE_PLAN])
    .first()) as { plan_slug: string } | null
  return row?.plan_slug ?? null
}

async function mirroredEntitlements(
  userId: string,
  client?: TransactionClientContract,
): Promise<Entitlements> {
  const slug = await mirroredPlanSlug(userId, client)
  if (slug === null) return { plan: FREE_PLAN, features: new Set(), source: 'default' }
  const features = featuresFromLimits(await planLimitRow(slug), await planLimitRow(FREE_PLAN))
  return { plan: slug, features, source: 'subscription' }
}

// --- Relevé des claims ------------------------------------------------------------------------

/**
 * Un relevé des claims n'est plus utilisé au-delà de cette durée sans nouveau jeton du compte :
 * un mois payé, plus une marge. Il ne sert seul que si le miroir n'a rien de plus récent.
 */
export const CLAIMED_PLAN_MAX_AGE_DAYS = 35

/** Relevé réécrit au plus toutes les 5 min quand le plan ne change pas (secondes). */
const CLAIMED_PLAN_REFRESH_S = 300

/** Dernier relevé écrit par cette instance, par compte : évite une requête par appel. */
const recordedClaims = new Map<string, { key: string; issuedAt: number }>()
const RECORDED_CLAIMS_MAX = 10_000

/**
 * Enregistre le plan et les features d'un jeton de session vérifié (`users.claimed_plan_*`) pour
 * les vérifications où le compte n'est pas l'auteur de la requête. `iat` du jeton comme date :
 * un jeton plus ancien que le relevé ne l'écrase pas. Réécrit si le plan ou les features changent,
 * sinon au plus toutes les 5 min (la date doit rester plus récente que le miroir).
 */
export async function recordClaimedEntitlements(
  userId: string,
  claims: Readonly<Record<string, unknown>>,
): Promise<void> {
  const entitlements = entitlementsFromClaims(claims)
  const issuedAt = claims.iat
  if (!entitlements || typeof issuedAt !== 'number' || !Number.isFinite(issuedAt)) return
  const features = [...entitlements.features].sort()
  const key = `${entitlements.plan}|${features.join(',')}`
  const last = recordedClaims.get(userId)
  if (last?.key === key && issuedAt - last.issuedAt < CLAIMED_PLAN_REFRESH_S) return
  // Littéral de tableau PostgreSQL : slugs de features connus (ni virgule ni guillemet).
  const featureArray = `{${features.join(',')}}`
  await db.rawQuery(
    `UPDATE users
        SET claimed_plan_slug = ?, claimed_plan_features = ?::text[],
            claimed_plan_at = to_timestamp(?)
      WHERE id = ?
        AND (claimed_plan_at IS NULL
             OR (claimed_plan_at <= to_timestamp(?)
                 AND (claimed_plan_slug IS DISTINCT FROM ?
                      OR claimed_plan_features IS DISTINCT FROM ?::text[]))
             OR claimed_plan_at <= to_timestamp(?) - make_interval(secs => ?))`,
    [
      entitlements.plan,
      featureArray,
      issuedAt,
      userId,
      issuedAt,
      entitlements.plan,
      featureArray,
      issuedAt,
      CLAIMED_PLAN_REFRESH_S,
    ],
  )
  if (recordedClaims.size >= RECORDED_CLAIMS_MAX) recordedClaims.clear()
  recordedClaims.set(userId, { key, issuedAt })
}

/** Oublie les relevés mémorisés par cette instance (tests). */
export function forgetRecordedClaims(): void {
  recordedClaims.clear()
}

/**
 * Droits d'après le relevé des claims, s'il est plus récent que toute mise à jour du miroir pour
 * ce compte et date de moins de `CLAIMED_PLAN_MAX_AGE_DAYS` ; sinon null.
 */
async function claimedEntitlements(
  userId: string,
  client?: TransactionClientContract,
): Promise<Entitlements | null> {
  const result = await (client ?? db).rawQuery<{
    rows: { slug: string; features: string[] | null }[]
  }>(
    `SELECT u.claimed_plan_slug AS slug, u.claimed_plan_features AS features
       FROM users u
      WHERE u.id = ? AND u.claimed_plan_slug IS NOT NULL
        AND u.claimed_plan_at > now() - make_interval(days => ?)
        AND NOT EXISTS (SELECT 1 FROM subscriptions s
                         WHERE s.user_id = u.id AND s.updated_at >= u.claimed_plan_at)`,
    [userId, CLAIMED_PLAN_MAX_AGE_DAYS],
  )
  const row = result.rows[0]
  if (!row) return null
  return {
    plan: row.slug,
    features: new Set((row.features ?? []).filter(isPlanFeature)),
    source: 'claims',
  }
}

// --- Point d'entrée ---------------------------------------------------------------------------

/**
 * Droits d'un compte. `requester` : utilisateur authentifié de la requête ; ses claims ne servent
 * que s'il s'agit du même compte. Pour une action sur un projet, passer le propriétaire : ses
 * limites s'appliquent, même quand un collaborateur agit. Sans les claims de la requête : la plus
 * récente des deux sources, relevé des claims du compte (`recordClaimedEntitlements`) ou miroir
 * des webhooks, pour que les vérifications d'un même projet lisent le même plan.
 */
export async function entitlementsOf(
  account: { id: string },
  requester?: User | null,
  client?: TransactionClientContract,
): Promise<Entitlements> {
  if (requester?.id === account.id) {
    const claims = sessionClaims.get(requester)
    const fromClaims = claims ? entitlementsFromClaims(claims) : null
    if (fromClaims) return fromClaims
  }
  return (
    (await claimedEntitlements(account.id, client)) ??
    (await mirroredEntitlements(account.id, client))
  )
}

/** Limites effectives d'un compte (voir `entitlementsOf`). */
export async function limitsOf(
  account: { id: string },
  requester?: User | null,
  client?: TransactionClientContract,
): Promise<EffectiveLimits> {
  const entitlements = await entitlementsOf(account, requester, client)
  return effectiveLimits(
    entitlements,
    await planLimitRow(entitlements.plan),
    await planLimitRow(FREE_PLAN),
  )
}

/**
 * Durée de conservation de l'historique d'un compte (tâche 8 : purge des versions de ses
 * projets), en jours ; null : historique complet. Les versions avec label ne sont jamais purgées.
 */
export async function historyRetention(
  account: { id: string },
  requester?: User | null,
): Promise<{ plan: string; days: number | null }> {
  const limits = await limitsOf(account, requester)
  return { plan: limits.entitlements.plan, days: limits.historyRetentionDays }
}
