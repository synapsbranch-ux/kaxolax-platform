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

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
