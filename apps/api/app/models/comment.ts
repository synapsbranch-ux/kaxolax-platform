import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

export default class Comment extends UuidModel {
  @column()
  declare threadId: string

  @column()
  declare authorId: string

  @column()
  declare body: string

  @column.dateTime()
  declare editedAt: DateTime | null

  /** Suppression douce : le message disparaît, le fil garde sa structure. */
  @column.dateTime()
  declare deletedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
