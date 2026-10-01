import { type Compiler, type SpellcheckLanguage } from '@kaxolax/contracts'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

export default class Project extends UuidModel {
  @column()
  declare ownerId: string

  /** Workspace du projet (à la création : le workspace personnel du créateur). */
  @column()
  declare workspaceId: string

  @column()
  declare name: string

  @column()
  declare compiler: Compiler

  @column()
  declare mainDocumentId: string | null

  /** Langue du correcteur orthographique. */
  @column()
  declare spellcheckLanguage: SpellcheckLanguage

  @column.dateTime()
  declare archivedAt: DateTime | null

  @column.dateTime()
  declare trashedAt: DateTime | null

  @column.dateTime()
  declare lastCompiledAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
