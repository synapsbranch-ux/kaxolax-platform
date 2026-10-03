import type { TokenScope } from '@kaxolax/contracts'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/**
 * Jeton d'accès personnel : préfixe affichable et hachage SHA-256 du secret (le secret n'est
 * jamais stocké). Créé et vérifié par `app/services/personal_access_tokens.ts`.
 */
export default class PersonalAccessToken extends UuidModel {
  static override table = 'personal_access_tokens'

  @column()
  declare userId: string

  @column()
  declare name: string

  /** `kxp_` + identifiant public : affiché, et clé de recherche à la vérification. */
  @column()
  declare tokenPrefix: string

  @column({ serializeAs: null })
  declare tokenHash: string

  @column()
  declare scopes: TokenScope[]

  /** Null : tous les projets dont le compte est membre. */
  @column()
  declare projectIds: string[] | null

  @column.dateTime()
  declare expiresAt: DateTime

  @column.dateTime()
  declare lastUsedAt: DateTime | null

  @column.dateTime()
  declare revokedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
