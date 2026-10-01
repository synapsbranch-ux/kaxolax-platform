import { type WorkspaceType } from '@kaxolax/contracts'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/** Espace qui regroupe des projets ; un workspace personnel par utilisateur. */
export default class Workspace extends UuidModel {
  @column()
  declare name: string

  @column()
  declare type: WorkspaceType

  @column()
  declare ownerId: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
