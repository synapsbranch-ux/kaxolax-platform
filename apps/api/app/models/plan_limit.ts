import { BaseModel, column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'

/** Limites chiffrées d'un plan Clerk (valeurs Kaxolax) ; null = illimité. */
export default class PlanLimit extends BaseModel {
  static override table = 'plan_limits'
  static override selfAssignPrimaryKey = true

  /** Slug du plan dans Clerk Billing. */
  @column({ isPrimary: true })
  declare planSlug: string

  @column()
  declare maxCompileSeconds: number

  /** Collaborateurs en plus du propriétaire. */
  @column()
  declare maxCollaborators: number | null

  /** Null : historique complet. */
  @column()
  declare historyRetentionDays: number | null

  @column({ consume: (value: string | number) => Number(value) })
  declare storageBytes: number

  /** Crédits IA par mois (1 crédit = 0,01 $ de coût de l'API Anthropic). */
  @column()
  declare aiMonthlyCredits: number

  /** Images bitmap par mois. */
  @column()
  declare imageMonthlyCredits: number

  /** Crédits IA et images multipliés par les sièges de l'équipe (plan d'organisation). */
  @column()
  declare creditsPerSeat: boolean

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
