import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

export default class Upload extends UuidModel {
  @column()
  declare projectId: string | null

  @column()
  declare userId: string

  @column()
  declare purpose: 'file' | 'import'

  @column({ serializeAs: null, columnName: 's3_key' })
  declare s3Key: string

  @column()
  declare filename: string

  @column()
  declare folderId: string | null

  @column({ consume: (value: string | number) => Number(value) })
  declare sizeBytes: number

  @column()
  declare status: 'pending' | 'completed' | 'failed'

  @column.dateTime()
  declare expiresAt: DateTime

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
