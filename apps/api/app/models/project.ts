import {
  type Compiler,
  DEFAULT_TEAM_MEMBER_ROLE,
  type SpellcheckLanguage,
  type TeamMemberRole,
} from '@kaxolax/contracts'
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

  /**
   * Rôle des membres `member` de l'équipe sur ce projet, s'il est dans un workspace d'équipe
   * (`editor` par défaut ; les administrateurs sont propriétaires effectifs).
   */
  @column()
  declare teamRole: TeamMemberRole

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
    if (model.$attributes.teamRole === undefined) model.teamRole = DEFAULT_TEAM_MEMBER_ROLE
  }
}
