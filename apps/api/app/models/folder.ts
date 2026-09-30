import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

export default class Folder extends UuidModel {
  @column()
  declare projectId: string

  /** Nul : dossier à la racine du projet. */
  @column()
  declare parentId: string | null

  @column()
  declare name: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
