import type { SuggestionKind, SuggestionOrigin, SuggestionStatus } from '@kaxolax/contracts'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/**
 * Suggestion de modification (tâche 2) ancrée dans un document par des positions relatives Yjs,
 * au format des ancres des commentaires. Le texte ne change qu'à l'acceptation.
 */
export default class Suggestion extends UuidModel {
  @column()
  declare projectId: string

  @column()
  declare documentId: string

  /** Membre qui a suggéré, ou qui a sollicité l'IA. */
  @column()
  declare authorId: string

  @column()
  declare origin: SuggestionOrigin

  @column()
  declare kind: SuggestionKind

  /** Positions relatives Yjs encodées (bytea), converties en base64 pour le client. */
  @column({ serializeAs: null })
  declare anchor: Buffer

  @column()
  declare originalText: string

  @column()
  declare proposedText: string

  @column()
  declare status: SuggestionStatus

  @column()
  declare decidedBy: string | null

  @column.dateTime()
  declare decidedAt: DateTime | null

  @column()
  declare aiMessageId: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
