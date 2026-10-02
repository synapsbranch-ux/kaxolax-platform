import { BaseModel, column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'

/**
 * Mise à jour Yjs journalisée avec son auteur (service temps réel, création d'un document,
 * restauration). Les mises à jour intégrées à une version sont ensuite compactées en une seule
 * ligne par document (base de la version suivante).
 */
export default class DocumentUpdate extends BaseModel {
  static override table = 'document_updates'

  @column({ isPrimary: true, consume: (value: string | number) => Number(value) })
  declare id: number

  @column()
  declare projectId: string

  @column()
  declare documentId: string

  /** Nul : origine inconnue. */
  @column()
  declare userId: string | null

  @column({ serializeAs: null })
  declare yjsUpdate: Buffer

  /** Version qui a intégré la mise à jour ; nul : pas encore versionnée. */
  @column()
  declare versionId: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
