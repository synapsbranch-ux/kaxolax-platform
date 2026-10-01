import { BaseModel, column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'

/** Préférences de l'éditeur d'un utilisateur, appliquées sur tous ses appareils. */
export default class UserPreference extends BaseModel {
  static override table = 'user_preferences'
  static override selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare userId: string

  /** Objet jsonb, validé par l'API. Sérialisé explicitement : pg convertirait un tableau. */
  @column({ prepare: (value: Record<string, unknown>) => JSON.stringify(value) })
  declare prefs: Record<string, unknown>

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
