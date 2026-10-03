import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/**
 * Agrégat mensuel de la consommation d'un compte (mois civil UTC), écrit par
 * `app/services/ai_credits.ts` ; les réservations en cours sont dans `ai_credit_reservations`.
 */
export default class AiCreditPeriod extends UuidModel {
  static override table = 'ai_credit_periods'

  @column()
  declare userId: string

  /** Premier jour du mois (`YYYY-MM-DD`). */
  @column({ consume: (value: Date | string) => (value instanceof Date ? isoDay(value) : value) })
  declare periodStart: string

  @column({ consume: (value: string | number) => Number(value) })
  declare aiUsedMicros: number

  @column()
  declare imageUsed: number

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}

/** Jour d'une date lue par pg (type `date`, minuit local du processus). */
function isoDay(value: Date): string {
  const month = String(value.getMonth() + 1).padStart(2, '0')
  const day = String(value.getDate()).padStart(2, '0')
  return `${String(value.getFullYear())}-${month}-${day}`
}
