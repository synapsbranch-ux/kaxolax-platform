import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

export type VersionKind = 'auto' | 'compile' | 'restore'

/** Version du projet : métadonnées en base, texte compressé dans S3 sous `s3Prefix`. */
export default class ProjectVersion extends UuidModel {
  @column()
  declare projectId: string

  @column()
  declare kind: VersionKind

  /** Utilisateurs dont des mises à jour Yjs entrent dans cette version (uuid[]). */
  @column()
  declare authorIds: string[]

  @column()
  declare changedDocumentIds: string[]

  @column({ serializeAs: null, columnName: 's3_prefix' })
  declare s3Prefix: string

  /** Une version avec label n'est jamais purgée. */
  @column()
  declare label: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
