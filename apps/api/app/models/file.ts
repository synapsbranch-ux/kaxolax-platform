import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

export default class File extends UuidModel {
  @column()
  declare projectId: string

  @column()
  declare folderId: string | null

  @column()
  declare name: string

  @column({ serializeAs: null, columnName: 's3_key' })
  declare s3Key: string

  @column({ columnName: 'sha256' })
  declare sha256: string

  @column({ consume: (value: string | number) => Number(value) })
  declare sizeBytes: number

  @column()
  declare mimeType: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
