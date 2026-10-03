import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/** Conversation avec l'assistant IA, privée à son auteur, dans un projet. */
export default class AiConversation extends UuidModel {
  static override table = 'ai_conversations'

  @column()
  declare projectId: string

  @column()
  declare userId: string

  @column()
  declare title: string | null

  @column.dateTime()
  declare archivedAt: DateTime | null

  /** Date du dernier message : ordre et curseur de la liste. */
  @column.dateTime()
  declare lastMessageAt: DateTime

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
