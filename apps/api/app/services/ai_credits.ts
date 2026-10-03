import { randomUUID } from 'node:crypto'
import { AI_CREDIT_MICROS, type AiCreditKind, type AiCredits } from '@kaxolax/contracts'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import aiConfig from '#config/ai'
import { PlanLimitException } from '#exceptions/plan_limit'
import type User from '#models/user'
import { isoString } from '#services/dates'
import {
  type BillingAccount,
  type EffectiveLimits,
  hasActiveOrganizationPlan,
  limitsOfAccount,
  userAccount,
} from '#services/entitlements'

/**
 * Crédits IA mensuels (1 crédit = 0,01 $ de coût d'API = 10 000 micro-dollars) et crédits
 * images (à l'unité), par plan (`plan_limits`, feature `ai`).
 *
 * - Imputation : au compte de l'utilisateur qui lance l'action, sur son propre plan (jamais au
 *   propriétaire du projet) : un collaborateur Free sur un projet Pro consomme ses crédits Free.
 *   Exception : une action d'un membre de l'équipe dans un projet d'équipe est imputée à la
 *   réserve mutualisée du workspace d'équipe (plan de l'organisation, crédits par siège) si
 *   l'organisation a un plan actif (`creditAccountFor`) ; l'auteur reste enregistré (ai_usage,
 *   réservation). Un invité extérieur (lien de partage, invitation individuelle) consomme ses
 *   crédits personnels : la réserve payée par l'équipe n'est pas à sa portée.
 * - Agrégat d'une équipe : garde son organisation (`clerk_organization_id`) et survit à la
 *   dissolution du workspace (`workspace_id` remis à NULL) : la consommation passée reste. Un
 *   appel en cours pendant la dissolution est réglé sur cette ligne de l'organisation (la
 *   réservation garde l'organisation), jamais perdu.
 * - Période : mois civil UTC ; la remise à zéro est implicite (nouvelle ligne d'agrégat le 1er).
 * - Avant l'appel, le coût maximal est réservé (`reserveCredits`) : refus 403 `E_PLAN_LIMIT`
 *   (`ai_credits` ou `image_credits`, feature `ai`) si consommé + réservé + montant dépasse les
 *   crédits du plan. Avec `minimum`, la réservation est ramenée au solde disponible (l'appelant
 *   réduit alors `max_tokens`) et le refus n'a lieu que sous ce minimum. La somme des réservations
 *   en cours ne dépasse donc jamais le plan, même pour des appels simultanés.
 * - Après l'appel, la réservation est réglée avec le coût réel (`settleCredits` : ne dépasse le
 *   montant réservé que de l'erreur d'estimation de l'entrée) ou libérée (`releaseCredits`).
 *   Pendant l'appel, elle est prolongée (`renewCredits`) ; non réglée (processus arrêté), elle
 *   expire après `reservationTtlSeconds`.
 * - Concurrence : la ligne d'agrégat du mois est verrouillée (FOR UPDATE) pendant la réservation ;
 *   le règlement l'incrémente atomiquement. Ordre des verrous : agrégat, puis réservations.
 */

/** Mois de crédits contenant `now` (UTC). */
export interface CreditPeriod {
  start: DateTime
  end: DateTime
  /** Premier jour du mois, `YYYY-MM-DD` (colonne `period_start`). */
  key: string
}

export function creditPeriod(now: DateTime = DateTime.utc()): CreditPeriod {
  const start = now.toUTC().startOf('month')
  return { start, end: start.plus({ months: 1 }), key: start.toFormat('yyyy-MM-dd') }
}

/** Réservation en cours, à régler ou libérer après l'appel. */
export interface CreditReservation {
  readonly id: string
  /** Auteur de l'appel. */
  readonly userId: string
  /** Réserve d'équipe débitée ; null : réserve personnelle de `userId`. */
  readonly workspaceId: string | null
  /** Organisation de la réserve d'équipe (règlement après une dissolution) ; null sinon. */
  readonly clerkOrganizationId: string | null
  readonly kind: AiCreditKind
  /** Mois de la réservation : le règlement y est imputé, même s'il arrive le mois suivant. */
  readonly periodStart: string
  /** Micro-dollars (`ai`) ou images (`image`). */
  readonly amount: number
}

/** Unité interne d'une réserve : micro-dollars pour `ai`, images pour `image`. */
function unitsPerCredit(kind: AiCreditKind): number {
  return kind === 'ai' ? AI_CREDIT_MICROS : 1
}

/** Crédits entiers (arrondis au supérieur) correspondant à un usage interne. */
function wholeCredits(kind: AiCreditKind, units: number): number {
  return Math.ceil(units / unitsPerCredit(kind))
}

interface PeriodRow {
  ai_used_micros: string | number
  image_used: number
}

/**
 * Réserve débitée : celle d'un compte (`user_id`) ou d'un workspace d'équipe (`workspace_id`,
 * avec son organisation).
 */
type CreditPool =
  | { column: 'user_id'; id: string }
  | { column: 'workspace_id'; id: string; clerkOrganizationId: string }

function poolOf(account: BillingAccount): CreditPool {
  return account.type === 'user'
    ? { column: 'user_id', id: account.id }
    : {
        column: 'workspace_id',
        id: account.workspaceId,
        clerkOrganizationId: account.clerkOrganizationId,
      }
}

/**
 * Colonnes et valeurs d'une nouvelle ligne d'agrégat : une équipe garde aussi son organisation
 * (l'agrégat survit au workspace).
 */
function poolInsert(pool: CreditPool): { columns: string; values: string; bindings: string[] } {
  return pool.column === 'user_id'
    ? { columns: 'user_id', values: '?', bindings: [pool.id] }
    : {
        columns: 'workspace_id, clerk_organization_id',
        values: '?, ?',
        bindings: [pool.id, pool.clerkOrganizationId],
      }
}

/**
 * Identifiant de `workspaceId` s'il existe encore, verrouillé (FOR KEY SHARE) jusqu'à la fin de
 * la transaction : une dissolution simultanée attend la validation. Null si le workspace a été
 * dissous (ou si `workspaceId` est null).
 */
export async function liveWorkspaceId(
  workspaceId: string | null,
  trx: TransactionClientContract,
): Promise<string | null> {
  if (workspaceId === null) return null
  const result = await trx.rawQuery<{ rows: { id: string }[] }>(
    'SELECT id FROM workspaces WHERE id = ? FOR KEY SHARE',
    [workspaceId],
  )
  return result.rows[0]?.id ?? null
}

/** Cible `ON CONFLICT` de l'index unique de la réserve (partiel pour les équipes). */
function conflictTarget(pool: CreditPool): string {
  return pool.column === 'user_id'
    ? '(user_id, period_start)'
    : '(workspace_id, period_start) WHERE workspace_id IS NOT NULL'
}

/**
 * Compte débité par une action de l'IA (`workspace` : workspace du projet, null hors projet) : la
 * réserve du workspace d'équipe si `user` en est membre et que l'organisation a un plan actif ;
 * sinon l'utilisateur qui la lance (invité extérieur, équipe sans abonnement, projet personnel).
 */
export async function creditAccountFor(
  user: User,
  workspace: { id: string; type: string; clerkOrganizationId: string | null } | null,
  client?: TransactionClientContract,
): Promise<BillingAccount> {
  if (workspace?.type !== 'team' || workspace.clerkOrganizationId === null) {
    return userAccount(user.id)
  }
  const member = (await (client ?? db)
    .from('workspace_members')
    .where({ workspace_id: workspace.id, user_id: user.id })
    .select('id')
    .first()) as { id: string } | null
  if (!member) return userAccount(user.id)
  if (!(await hasActiveOrganizationPlan(workspace.clerkOrganizationId, user, client))) {
    return userAccount(user.id)
  }
  return {
    type: 'team',
    workspaceId: workspace.id,
    clerkOrganizationId: workspace.clerkOrganizationId,
  }
}

/** Ligne d'agrégat du mois, créée au besoin puis verrouillée jusqu'à la fin de la transaction. */
async function lockPeriod(
  trx: TransactionClientContract,
  pool: CreditPool,
  period: string,
): Promise<{ ai: number; image: number }> {
  const insert = poolInsert(pool)
  await trx.rawQuery(
    `INSERT INTO ai_credit_periods (id, ${insert.columns}, period_start)
     VALUES (?, ${insert.values}, ?::date)
     ON CONFLICT ${conflictTarget(pool)} DO NOTHING`,
    [randomUUID(), ...insert.bindings, period],
  )
  const result = await trx.rawQuery<{ rows: PeriodRow[] }>(
    `SELECT ai_used_micros, image_used FROM ai_credit_periods
      WHERE ${pool.column} = ? AND period_start = ?::date FOR UPDATE`,
    [pool.id, period],
  )
  const row = result.rows[0]
  return { ai: Number(row?.ai_used_micros ?? 0), image: row?.image_used ?? 0 }
}

/**
 * Réserve `amount` (micro-dollars pour `ai`, images pour `image`) sur les crédits du mois de
 * `user` (ou de `account`, la réserve d'équipe d'un projet d'équipe), avant l'appel. Lève `PlanLimitException` (403 `E_PLAN_LIMIT`) au-delà des crédits du
 * plan ; `current` du refus : crédits déjà consommés. Avec `minimum` (≤ `amount`), réserve
 * seulement le solde disponible s'il est inférieur à `amount` mais au moins égal à `minimum` :
 * `amount` de la réservation renvoyée donne le montant effectivement réservé.
 */
export async function reserveCredits(
  user: User,
  kind: AiCreditKind,
  amount: number,
  options: { now?: DateTime; minimum?: number; account?: BillingAccount } = {},
): Promise<CreditReservation> {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new RangeError('A credit reservation must be a positive integer')
  }
  const minimum = options.minimum ?? amount
  if (!Number.isSafeInteger(minimum) || minimum <= 0 || minimum > amount) {
    throw new RangeError('The minimum of a credit reservation must be in 1..amount')
  }
  const now = options.now ?? DateTime.utc()
  const period = creditPeriod(now)
  const account = options.account ?? userAccount(user.id)
  const pool = poolOf(account)
  const limits = await limitsOfAccount(account, user)
  const credits = kind === 'ai' ? limits.aiCredits : limits.imageCredits
  const allowance = credits * unitsPerCredit(kind)
  // Réservations de la réserve : celles de l'équipe, ou celles du compte hors équipes.
  const ofPool = (query: ReturnType<TransactionClientContract['from']>) =>
    pool.column === 'workspace_id'
      ? query.where('workspace_id', pool.id)
      : query.where('user_id', pool.id).whereNull('workspace_id')
  return db.transaction(async (trx) => {
    const used = await lockPeriod(trx, pool, period.key)
    // Ménage des réservations expirées de la réserve (appels interrompus sans règlement).
    await ofPool(trx.from('ai_credit_reservations'))
      .where('expires_at', '<=', now.toJSDate())
      .delete()
    const reserved = (await ofPool(trx.from('ai_credit_reservations'))
      .where({ period_start: period.key, kind })
      .where('expires_at', '>', now.toJSDate())
      .sum('amount as total')
      .first()) as { total: string | number | null } | null
    const consumed = kind === 'ai' ? used.ai : used.image
    const available = allowance - consumed - Number(reserved?.total ?? 0)
    if (available < minimum) {
      throw new PlanLimitException({
        name: kind === 'ai' ? 'ai_credits' : 'image_credits',
        plan: limits.entitlements.plan,
        max: credits,
        current: wholeCredits(kind, consumed),
      })
    }
    const id = randomUUID()
    const reservedAmount = Math.min(amount, available)
    const workspaceId = pool.column === 'workspace_id' ? pool.id : null
    const clerkOrganizationId = pool.column === 'workspace_id' ? pool.clerkOrganizationId : null
    await trx.table('ai_credit_reservations').insert({
      id,
      user_id: user.id,
      workspace_id: workspaceId,
      period_start: period.key,
      kind,
      amount: reservedAmount,
      expires_at: now.plus({ seconds: aiConfig.reservationTtlSeconds }).toJSDate(),
      created_at: now.toJSDate(),
    })
    return {
      id,
      userId: user.id,
      workspaceId,
      clerkOrganizationId,
      kind,
      periodStart: period.key,
      amount: reservedAmount,
    }
  })
}

/**
 * Workspace d'équipe dissous pendant l'appel : la consommation est ajoutée à la ligne de
 * l'organisation (`workspace_id` NULL, celle que la dissolution a gardée), créée au besoin. Verrou
 * consultatif par organisation : deux règlements simultanés ne créent pas deux lignes.
 */
async function settleOnOrganization(
  client: TransactionClientContract,
  clerkOrganizationId: string,
  periodStart: string,
  ai: number,
  image: number,
): Promise<void> {
  await client.rawQuery('SELECT pg_advisory_xact_lock(hashtext(?))', [
    `ai-credits:${clerkOrganizationId}`,
  ])
  const updated = await client.rawQuery<{ rows: unknown[] }>(
    `UPDATE ai_credit_periods
        SET ai_used_micros = ai_used_micros + ?, image_used = image_used + ?, updated_at = now()
      WHERE clerk_organization_id = ? AND workspace_id IS NULL AND period_start = ?::date
      RETURNING id`,
    [ai, image, clerkOrganizationId, periodStart],
  )
  if (updated.rows.length > 0) return
  await client.table('ai_credit_periods').insert({
    id: randomUUID(),
    clerk_organization_id: clerkOrganizationId,
    period_start: periodStart,
    ai_used_micros: ai,
    image_used: image,
  })
}

/**
 * Règle une réservation avec la consommation réelle (micro-dollars ou images), dans `trx` si
 * fourni (même transaction que la ligne ai_usage). La réservation disparaît ; l'agrégat de son mois
 * est incrémenté atomiquement, même si le coût réel dépasse l'estimation. Réserve d'équipe dont le
 * workspace a été dissous pendant l'appel : réglée sur la ligne de l'organisation.
 */
export async function settleCredits(
  reservation: CreditReservation,
  actual: number,
  trx?: TransactionClientContract,
): Promise<void> {
  const consumed = Math.max(0, Math.ceil(actual))
  const ai = reservation.kind === 'ai' ? consumed : 0
  const image = reservation.kind === 'image' ? consumed : 0
  const run = async (client: TransactionClientContract) => {
    let pool: CreditPool = { column: 'user_id', id: reservation.userId }
    if (reservation.workspaceId !== null && reservation.clerkOrganizationId !== null) {
      // Verrouillé jusqu'à la validation : la dissolution ne peut plus le retirer entre-temps.
      if ((await liveWorkspaceId(reservation.workspaceId, client)) === null) {
        await settleOnOrganization(
          client,
          reservation.clerkOrganizationId,
          reservation.periodStart,
          ai,
          image,
        )
        await client.from('ai_credit_reservations').where('id', reservation.id).delete()
        return
      }
      pool = {
        column: 'workspace_id',
        id: reservation.workspaceId,
        clerkOrganizationId: reservation.clerkOrganizationId,
      }
    }
    // Agrégat d'abord, réservation ensuite : même ordre de verrous que `reserveCredits`.
    const insert = poolInsert(pool)
    await client.rawQuery(
      `INSERT INTO ai_credit_periods
         (id, ${insert.columns}, period_start, ai_used_micros, image_used)
       VALUES (?, ${insert.values}, ?::date, ?, ?)
       ON CONFLICT ${conflictTarget(pool)} DO UPDATE
         SET ai_used_micros = ai_credit_periods.ai_used_micros + EXCLUDED.ai_used_micros,
             image_used = ai_credit_periods.image_used + EXCLUDED.image_used,
             updated_at = now()`,
      [randomUUID(), ...insert.bindings, reservation.periodStart, ai, image],
    )
    await client.from('ai_credit_reservations').where('id', reservation.id).delete()
  }
  await (trx ? run(trx) : db.transaction(run))
}

/**
 * Prolonge une réservation pendant un appel encore en cours (nouvelle échéance : maintenant +
 * `reservationTtlSeconds`). Sans effet si elle n'existe plus (déjà réglée ou expirée).
 */
export async function renewCredits(
  reservation: CreditReservation,
  options: { now?: DateTime } = {},
): Promise<void> {
  const now = options.now ?? DateTime.utc()
  await db
    .from('ai_credit_reservations')
    .where('id', reservation.id)
    .update({ expires_at: now.plus({ seconds: aiConfig.reservationTtlSeconds }).toJSDate() })
}

/** Libère une réservation sans consommation (appel refusé avant la réponse, erreur réseau). */
export async function releaseCredits(reservation: CreditReservation): Promise<void> {
  await db.from('ai_credit_reservations').where('id', reservation.id).delete()
}

/** Solde d'une réserve, en crédits (centièmes pour `ai`). */
function balance(monthly: number, kind: AiCreditKind, usedUnits: number) {
  if (kind === 'image') {
    return { monthly, used: usedUnits, remaining: Math.max(0, monthly - usedUnits) }
  }
  // Centièmes de crédit : 100 micro-dollars.
  const usedHundredths = Math.ceil(usedUnits / 100)
  const leftHundredths = Math.floor((monthly * AI_CREDIT_MICROS - usedUnits) / 100)
  return { monthly, used: usedHundredths / 100, remaining: Math.max(0, leftHundredths) / 100 }
}

/**
 * Crédits du mois de `user` pour `GET /me/plan`, ou de `account` (réserve d'une équipe, `GET
 * /workspaces/:id/plan`) ; réservations en cours non comptées. `limits` : limites déjà calculées
 * pour ce compte (évite une seconde lecture).
 */
export async function creditsSummary(
  user: User,
  options: { limits?: EffectiveLimits; now?: DateTime; account?: BillingAccount } = {},
): Promise<AiCredits> {
  const period = creditPeriod(options.now)
  const account = options.account ?? userAccount(user.id)
  const pool = poolOf(account)
  const limits = options.limits ?? (await limitsOfAccount(account, user))
  const row = (await db
    .from('ai_credit_periods')
    .where({ [pool.column]: pool.id, period_start: period.key })
    .select('ai_used_micros', 'image_used')
    .first()) as PeriodRow | null
  return {
    periodStart: isoString(period.start),
    resetsAt: isoString(period.end),
    ai: balance(limits.aiCredits, 'ai', Number(row?.ai_used_micros ?? 0)),
    images: balance(limits.imageCredits, 'image', row?.image_used ?? 0),
  }
}
