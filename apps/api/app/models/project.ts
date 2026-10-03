import { type Compiler, type SpellcheckLanguage } from '@kaxolax/contracts'
import { beforeCreate, column } from '@adonisjs/lucid/orm'
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

  /** IA autorisée pour ce projet (réglage du propriétaire ; le workspace peut aussi l'interdire). */
  @column()
  declare aiEnabled: boolean

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

  /** Valeur par défaut de la colonne, connue de l'instance dès sa création (pas de relecture). */
  @beforeCreate()
  static enableAiByDefault(model: Project) {
    if (model.$attributes.aiEnabled === undefined) model.aiEnabled = true
  }
}
