import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'
import { encryptedColumn } from '#services/encrypted_column'

/**
 * Compte Zotero connecté par OAuth 1.0a (tâche 9), un par utilisateur. Clé d'API chiffrée au
 * repos (`APP_KEY`), jamais sérialisée.
 */
export default class ZoteroAccount extends UuidModel {
  static override table = 'zotero_accounts'

  @column()
  declare userId: string

  @column()
  declare zoteroUserId: string

  @column()
  declare zoteroUsername: string | null

  /** Null si la clé ne se déchiffre plus (`APP_KEY` changée) : à reconnecter. */
  @column({ ...encryptedColumn('zotero_accounts.api_key'), columnName: 'api_key_encrypted' })
  declare apiKey: string | null

  /** Pause demandée par Zotero (`Backoff`, `Retry-After`) pour cette clé : aucune requête avant. */
  @column.dateTime()
  declare backoffUntil: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
