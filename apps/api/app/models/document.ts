import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

export default class Document extends UuidModel {
  @column()
  declare projectId: string

  @column()
  declare folderId: string | null

  @column()
  declare name: string

  /** État Yjs complet (bytea). Jamais sérialisé dans les réponses de l'API. */
  @column({ serializeAs: null })
  declare yjsState: Buffer | null

  @column({ columnName: 'content_sha256' })
  declare contentSha256: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
