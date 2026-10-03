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
 *
 * Workspace d'équipe (Organisation Clerk) : ses projets prennent les droits du plan de
 * l'organisation, quel que soit le propriétaire ou l'auteur de l'action. Plan et features d'après
 * les claims de portée organisation (`o:`) du jeton si l'organisation active de la requête
 * (`o.id`) est celle du workspace, sinon d'après le miroir des abonnements d'organisation, sinon
 * `free`. Un plan `credits_per_seat` multiplie ses crédits par les membres du workspace.
 *
 * Organisation sans plan actif (`isActiveOrganizationPlan` : aucun plan payant connu de
 * plan_limits) : aucune part Free propre, sinon chaque organisation créée gratuitement
 * ajouterait sa réserve de crédits, son stockage et ses membres hors limite de collaborateurs.
 * Sa réserve de crédits est vide (l'IA est imputée à l'auteur, `creditAccountFor`) et aucun
 * projet ne peut y être créé, importé ni déplacé (`assertWorkspaceAcceptsProjects`) ; les projets
 * d'une équipe dont l'abonnement a pris fin gardent les limites de Free.
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
  /** Sièges comptés (membres de l'équipe) ; 1 pour un compte personnel. */
  readonly seats: number
  /** Crédits du plan multipliés par `seats`. */
  readonly perSeat: boolean
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
  /** Crédits multipliés par les sièges de l'équipe (plan d'organisation). */
  creditsPerSeat?: boolean
}

/**
 * Compte dont les limites s'appliquent : un utilisateur (projets personnels, crédits personnels)
 * ou un workspace d'équipe (plan de son organisation, stockage et crédits mutualisés).
 */
export type BillingAccount =
  | { readonly type: 'user'; readonly id: string }
  | { readonly type: 'team'; readonly workspaceId: string; readonly clerkOrganizationId: string }

export function userAccount(id: string): BillingAccount {
  return { type: 'user', id }
}

/** Clé stable d'un compte (verrous consultatifs, journaux). */
export function accountKey(account: BillingAccount): string {
  return account.type === 'user' ? `user:${account.id}` : `team:${account.workspaceId}`
}

/**
 * Compte d'un workspace : l'équipe pour un workspace d'équipe, sinon `personalOwnerId` (le
 * propriétaire du projet ou du workspace personnel).
 */
async function accountOf(
  workspaceId: string,
  personalOwnerId: string | null,
  client?: TransactionClientContract,
): Promise<BillingAccount | null> {
  const row = (await (client ?? db)
    .from('workspaces')
    .where('id', workspaceId)
    .select('type', 'owner_id', 'clerk_organization_id')
    .first()) as { type: string; owner_id: string; clerk_organization_id: string | null } | null
  if (!row) return personalOwnerId === null ? null : userAccount(personalOwnerId)
  if (row.type === 'team' && row.clerk_organization_id !== null) {
    return { type: 'team', workspaceId, clerkOrganizationId: row.clerk_organization_id }
  }
  return userAccount(personalOwnerId ?? row.owner_id)
}

/** Compte dont les limites s'appliquent à un projet (son équipe, sinon son propriétaire). */
export async function accountOfProject(
  project: { ownerId: string; workspaceId: string },
  client?: TransactionClientContract,
): Promise<BillingAccount> {
  return (
    (await accountOf(project.workspaceId, project.ownerId, client)) ?? userAccount(project.ownerId)
  )
}

/**
 * Compte d'un nouveau projet : celui du workspace demandé (une équipe : son organisation), sinon
 * l'utilisateur. L'appartenance au workspace est vérifiée par l'appelant.
 */
export async function accountForNewProject(
  user: { id: string },
  workspaceId: string | undefined,
  client?: TransactionClientContract,
): Promise<BillingAccount> {
  if (workspaceId === undefined) return userAccount(user.id)
  return (await accountOf(workspaceId, null, client)) ?? userAccount(user.id)
}

/** Compte d'un workspace (null s'il n'existe pas). */
export async function accountOfWorkspace(
  workspaceId: string,
  client?: TransactionClientContract,
): Promise<BillingAccount | null> {
  return accountOf(workspaceId, null, client)
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

/**
 * Valeurs de portée organisation d'un claim `pla` ou `fea` : éléments `o:valeur` (ou `ou`/`uo`),
 * comme `splitByScope` de @clerk/shared. Elles décrivent l'organisation active du jeton (`o.id`).
 */
export function organizationScopedValues(claim: unknown): string[] {
  if (typeof claim !== 'string' || claim.trim() === '') return []
  const values: string[] = []
  for (const part of claim.split(',')) {
    const element = part.trim()
    const colon = element.indexOf(':')
    if (colon === -1) continue
    const scope = element.slice(0, colon)
    const value = element.slice(colon + 1)
    if (value !== '' && (scope === 'o' || scope === 'ou' || scope === 'uo')) values.push(value)
  }
  return values
}

/** Organisation active d'un jeton de session v2 (claim `o` : `id`, `rol`, `slg`), ou null. */
export function activeOrganizationOf(
  claims: Readonly<Record<string, unknown>>,
): { id: string; role: string | null; slug: string | null } | null {
  const o = claims.o
  if (typeof o !== 'object' || o === null || !('id' in o) || typeof o.id !== 'string') return null
  const role = 'rol' in o && typeof o.rol === 'string' ? o.rol : null
  const slug = 'slg' in o && typeof o.slg === 'string' ? o.slg : null
  return { id: o.id, role, slug }
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
 * Droits d'une organisation lus dans les claims d'un jeton vérifié, si son organisation active
 * (`o.id`) est `clerkOrganizationId` : `pla` (ex. `o:team`) et `fea` (ex. `o:long_compile`),
 * portée organisation. Null sinon (autre organisation active, aucun plan d'organisation).
 */
export function organizationEntitlementsFromClaims(
  claims: Readonly<Record<string, unknown>>,
  clerkOrganizationId: string,
): Entitlements | null {
  if (activeOrganizationOf(claims)?.id !== clerkOrganizationId) return null
  const [plan] = organizationScopedValues(claims.pla)
  if (plan === undefined) return null
  return {
    plan,
    features: new Set(organizationScopedValues(claims.fea).filter(isPlanFeature)),
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
  credits_per_seat: boolean
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
    creditsPerSeat: row.credits_per_seat,
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
  seats = 1,
): EffectiveLimits {
  const granted = (name: keyof typeof PLAN_LIMIT_FEATURES) =>
    entitlements.features.has(PLAN_LIMIT_FEATURES[name])
  // Plan par siège : crédits du plan multipliés par les sièges (au moins un), avant le plancher
  // de Free si la feature `ai` manque.
  const perSeat = plan.creditsPerSeat === true
  const multiplier = perSeat ? Math.max(1, seats) : 1
  const planAi = plan.aiMonthlyCredits * multiplier
  const planImages = plan.imageMonthlyCredits * multiplier
  return {
    seats: Math.max(1, seats),
    perSeat,
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
    aiCredits: granted('ai_credits') ? planAi : Math.min(planAi, free.aiMonthlyCredits),
    imageCredits: granted('image_credits')
      ? planImages
      : Math.min(planImages, free.imageMonthlyCredits),
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

/**
 * Slug du plan en cours d'une organisation d'après le miroir (mêmes règles que
 * `mirroredPlanSlug`), avec l'élément d'abonnement retenu ; null sans abonnement en cours.
 */
export async function mirroredOrganizationSubscription(
  clerkOrganizationId: string,
  client?: TransactionClientContract,
): Promise<{ planSlug: string; status: string; periodEnd: Date | null } | null> {
  const row = (await (client ?? db)
    .from('subscriptions')
    .select('plan_slug', 'status', 'period_end')
    .where('clerk_organization_id', clerkOrganizationId)
    .where((query) => {
      void query.whereIn('status', [...ACCESS_STATUSES]).orWhere((canceled) => {
        void canceled.where('status', CANCELED_STATUS).where('period_end', '>', db.raw('now()'))
      })
    })
    .orderByRaw('(plan_slug = ?) ASC, updated_at DESC', [FREE_PLAN])
    .first()) as { plan_slug: string; status: string; period_end: Date | null } | null
  return row ? { planSlug: row.plan_slug, status: row.status, periodEnd: row.period_end } : null
}

/** Droits d'après un slug du miroir (features déduites des valeurs chiffrées). */
async function entitlementsOfSlug(slug: string | null): Promise<Entitlements> {
  if (slug === null) return { plan: FREE_PLAN, features: new Set(), source: 'default' }
  const features = featuresFromLimits(await planLimitRow(slug), await planLimitRow(FREE_PLAN))
  return { plan: slug, features, source: 'subscription' }
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

/** Limites effectives d'un compte personnel (voir `entitlementsOf`). */
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
 * Droits d'une organisation : claims de portée organisation de la requête si son organisation
 * active est celle-ci, sinon miroir des abonnements d'organisation, sinon `free`.
 */
export async function organizationEntitlements(
  clerkOrganizationId: string,
  requester?: User | null,
  client?: TransactionClientContract,
): Promise<Entitlements> {
  const claims = requester ? sessionClaims.get(requester) : undefined
  const fromClaims = claims ? organizationEntitlementsFromClaims(claims, clerkOrganizationId) : null
  if (fromClaims) return fromClaims
  const mirrored = await mirroredOrganizationSubscription(clerkOrganizationId, client)
  return entitlementsOfSlug(mirrored?.planSlug ?? null)
}

/**
 * Vrai si les droits d'une organisation viennent d'un plan payant connu de Kaxolax : autre que
 * `free`, avec sa ligne plan_limits (un plan d'organisation par défaut de Clerk, inconnu ici,
 * n'en est pas un).
 */
export async function isActiveOrganizationPlan(entitlements: Entitlements): Promise<boolean> {
  if (entitlements.plan === FREE_PLAN) return false
  return (await planLimitRow(entitlements.plan)).planSlug === entitlements.plan
}

/** Vrai si l'organisation a un plan actif (voir `isActiveOrganizationPlan`). */
export async function hasActiveOrganizationPlan(
  clerkOrganizationId: string,
  requester?: User | null,
  client?: TransactionClientContract,
): Promise<boolean> {
  return isActiveOrganizationPlan(
    await organizationEntitlements(clerkOrganizationId, requester, client),
  )
}

/** Membres d'un workspace d'équipe (sièges). */
export async function workspaceSeats(
  workspaceId: string,
  client?: TransactionClientContract,
): Promise<number> {
  const row = (await (client ?? db)
    .from('workspace_members')
    .where('workspace_id', workspaceId)
    .count('* as total')
    .first()) as { total: string | number } | null
  return Number(row?.total ?? 0)
}

/**
 * Limites effectives d'un compte de facturation : celles du compte personnel, ou celles du plan
 * de l'organisation pour une équipe (crédits multipliés par les sièges si le plan est par siège ;
 * aucun crédit sans plan actif). `requester` : utilisateur de la requête (ses claims servent
 * s'ils concernent ce compte).
 */
export async function limitsOfAccount(
  account: BillingAccount,
  requester?: User | null,
  client?: TransactionClientContract,
): Promise<EffectiveLimits> {
  if (account.type === 'user') return limitsOf({ id: account.id }, requester, client)
  const entitlements = await organizationEntitlements(
    account.clerkOrganizationId,
    requester,
    client,
  )
  const limits = effectiveLimits(
    entitlements,
    await planLimitRow(entitlements.plan),
    await planLimitRow(FREE_PLAN),
    await workspaceSeats(account.workspaceId, client),
  )
  // Sans plan actif, pas de réserve mutualisée : pas de part Free par organisation créée.
  if (await isActiveOrganizationPlan(entitlements)) return limits
  return { ...limits, aiCredits: 0, imageCredits: 0 }
}

/**
 * Durée de conservation de l'historique d'un compte (tâche 8 : purge des versions de ses
 * projets ; une équipe : plan de l'organisation), en jours ; null : historique complet. Les
 * versions avec label ne sont jamais purgées.
 */
export async function historyRetention(
  account: BillingAccount,
  requester?: User | null,
): Promise<{ plan: string; days: number | null }> {
  const limits = await limitsOfAccount(account, requester)
  return { plan: limits.entitlements.plan, days: limits.historyRetentionDays }
}
