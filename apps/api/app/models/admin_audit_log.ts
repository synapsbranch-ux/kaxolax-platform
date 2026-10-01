import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/** Action d'un admin (auteur, action, cible, date), jamais modifiée ni effacée. */
export default class AdminAuditLog extends UuidModel {
  static override table = 'admin_audit_log'

  @column()
  declare adminId: string

  @column()
  declare action: string

  @column()
  declare targetType: string

  /** Uuid local ou identifiant Clerk. */
  @column()
  declare targetId: string | null

  @column({ prepare: (value: Record<string, unknown>) => JSON.stringify(value) })
  declare metadata: Record<string, unknown>

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
