import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

export default class ChatMessage extends UuidModel {
  @column()
  declare projectId: string

  @column()
  declare authorId: string

  @column()
  declare body: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
