import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/** Fil de commentaires ancré dans un document par des positions relatives Yjs. */
export default class CommentThread extends UuidModel {
  @column()
  declare projectId: string

  @column()
  declare documentId: string

  /** Positions relatives Yjs encodées (bytea), converties pour le client par le service. */
  @column({ serializeAs: null })
  declare anchor: Buffer

  /** Citation d'origine, affichée si le texte ancré a disparu. */
  @column()
  declare quotedText: string

  @column.dateTime()
  declare resolvedAt: DateTime | null

  @column()
  declare resolvedBy: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
