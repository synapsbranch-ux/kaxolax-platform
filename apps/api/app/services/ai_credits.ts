import { randomUUID } from 'node:crypto'
import { AI_CREDIT_MICROS, type AiCreditKind, type AiCredits } from '@kaxolax/contracts'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import aiConfig from '#config/ai'
import { PlanLimitException } from '#exceptions/plan_limit'
import type User from '#models/user'
import { isoString } from '#services/dates'
import { type EffectiveLimits, limitsOf } from '#services/entitlements'

/**
 * Crédits IA mensuels (1 crédit = 0,01 $ de coût d'API = 10 000 micro-dollars) et crédits
 * images (à l'unité), par plan (`plan_limits`, feature `ai`).
 *
 * - Imputation : au compte de l'utilisateur qui lance l'action, sur son propre plan (jamais au
 *   propriétaire du projet) : un collaborateur Free sur un projet Pro consomme ses crédits Free.
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
  readonly userId: string
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

/** Ligne d'agrégat du mois, créée au besoin puis verrouillée jusqu'à la fin de la transaction. */
async function lockPeriod(
  trx: TransactionClientContract,
  userId: string,
  period: string,
): Promise<{ ai: number; image: number }> {
  await trx.rawQuery(
    `INSERT INTO ai_credit_periods (id, user_id, period_start) VALUES (?, ?, ?::date)
     ON CONFLICT (user_id, period_start) DO NOTHING`,
    [randomUUID(), userId, period],
  )
  const result = await trx.rawQuery<{ rows: PeriodRow[] }>(
    `SELECT ai_used_micros, image_used FROM ai_credit_periods
      WHERE user_id = ? AND period_start = ?::date FOR UPDATE`,
    [userId, period],
  )
  const row = result.rows[0]
  return { ai: Number(row?.ai_used_micros ?? 0), image: row?.image_used ?? 0 }
}

/**
 * Réserve `amount` (micro-dollars pour `ai`, images pour `image`) sur les crédits du mois de
 * `user`, avant l'appel. Lève `PlanLimitException` (403 `E_PLAN_LIMIT`) au-delà des crédits du
 * plan ; `current` du refus : crédits déjà consommés. Avec `minimum` (≤ `amount`), réserve
 * seulement le solde disponible s'il est inférieur à `amount` mais au moins égal à `minimum` :
 * `amount` de la réservation renvoyée donne le montant effectivement réservé.
 */
export async function reserveCredits(
  user: User,
  kind: AiCreditKind,
  amount: number,
  options: { now?: DateTime; minimum?: number } = {},
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
  const limits = await limitsOf(user, user)
  const credits = kind === 'ai' ? limits.aiCredits : limits.imageCredits
  const allowance = credits * unitsPerCredit(kind)
  return db.transaction(async (trx) => {
    const used = await lockPeriod(trx, user.id, period.key)
    // Ménage des réservations expirées du compte (appels interrompus sans règlement).
    await trx
      .from('ai_credit_reservations')
      .where('user_id', user.id)
      .where('expires_at', '<=', now.toJSDate())
      .delete()
    const reserved = (await trx
      .from('ai_credit_reservations')
      .where({ user_id: user.id, period_start: period.key, kind })
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
    await trx.table('ai_credit_reservations').insert({
      id,
      user_id: user.id,
      period_start: period.key,
      kind,
      amount: reservedAmount,
      expires_at: now.plus({ seconds: aiConfig.reservationTtlSeconds }).toJSDate(),
      created_at: now.toJSDate(),
    })
    return { id, userId: user.id, kind, periodStart: period.key, amount: reservedAmount }
  })
}

/**
 * Règle une réservation avec la consommation réelle (micro-dollars ou images), dans `trx` si
 * fourni (même transaction que la ligne ai_usage). La réservation disparaît ; l'agrégat de son mois
 * est incrémenté atomiquement, même si le coût réel dépasse l'estimation.
 */
export async function settleCredits(
  reservation: CreditReservation,
  actual: number,
  trx?: TransactionClientContract,
): Promise<void> {
  const consumed = Math.max(0, Math.ceil(actual))
  const run = async (client: TransactionClientContract) => {
    // Agrégat d'abord, réservation ensuite : même ordre de verrous que `reserveCredits`.
    await client.rawQuery(
      `INSERT INTO ai_credit_periods (id, user_id, period_start, ai_used_micros, image_used)
       VALUES (?, ?, ?::date, ?, ?)
       ON CONFLICT (user_id, period_start) DO UPDATE
         SET ai_used_micros = ai_credit_periods.ai_used_micros + EXCLUDED.ai_used_micros,
             image_used = ai_credit_periods.image_used + EXCLUDED.image_used,
             updated_at = now()`,
      [
        randomUUID(),
        reservation.userId,
        reservation.periodStart,
        reservation.kind === 'ai' ? consumed : 0,
        reservation.kind === 'image' ? consumed : 0,
      ],
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
 * Crédits du mois de `user` pour `GET /me/plan` (réservations en cours non comptées).
 * `limits` : limites déjà calculées pour ce compte (évite une seconde lecture).
 */
export async function creditsSummary(
  user: User,
  options: { limits?: EffectiveLimits; now?: DateTime } = {},
): Promise<AiCredits> {
  const period = creditPeriod(options.now)
  const limits = options.limits ?? (await limitsOf(user, user))
  const row = (await db
    .from('ai_credit_periods')
    .where({ user_id: user.id, period_start: period.key })
    .select('ai_used_micros', 'image_used')
    .first()) as PeriodRow | null
  return {
    periodStart: isoString(period.start),
    resetsAt: isoString(period.end),
    ai: balance(limits.aiCredits, 'ai', Number(row?.ai_used_micros ?? 0)),
    images: balance(limits.imageCredits, 'image', row?.image_used ?? 0),
  }
}
