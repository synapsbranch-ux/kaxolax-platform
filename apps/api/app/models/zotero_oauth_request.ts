import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'
import { encryptedColumn } from '#services/encrypted_column'

/**
 * Demande OAuth 1.0a en cours (tâche 9) : jeton de requête de Zotero et son secret (chiffré),
 * liés au compte et à la session Clerk qui l'ont lancée, et hachage du `state` de l'URL de rappel.
 */
export default class ZoteroOAuthRequest extends UuidModel {
  static override table = 'zotero_oauth_requests'

  @column()
  declare userId: string

  @column()
  declare sessionId: string

  @column()
  declare requestToken: string

  @column({
    ...encryptedColumn('zotero_oauth_requests.request_token_secret'),
    columnName: 'request_token_secret_encrypted',
  })
  declare requestTokenSecret: string | null

  @column({ serializeAs: null })
  declare stateHash: string

  @column.dateTime()
  declare expiresAt: DateTime

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
