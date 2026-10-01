import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/**
 * Dernière lecture du chat d'un projet par un membre (badge de non-lus). Clé de substitution `id`,
 * comme ProjectMember ; le couple (projectId, userId) est unique.
 */
export default class ChatRead extends UuidModel {
  static override table = 'chat_reads'

  @column()
  declare projectId: string

  @column()
  declare userId: string

  @column.dateTime()
  declare lastReadAt: DateTime
}
