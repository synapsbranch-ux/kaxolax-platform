import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

export type AuthTokenType = 'email_verification' | 'password_reset'

export default class AuthToken extends UuidModel {
  @column()
  declare userId: string

  @column()
  declare type: AuthTokenType

  @column({ serializeAs: null })
  declare tokenHash: string

  @column.dateTime()
  declare expiresAt: DateTime

  @column.dateTime()
  declare usedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
