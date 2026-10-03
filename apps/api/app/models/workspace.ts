import { type WorkspaceType } from '@kaxolax/contracts'
import { beforeCreate, column } from '@adonisjs/lucid/orm'
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

  /** IA autorisée pour les projets du workspace (réglage du propriétaire). */
  @column()
  declare aiEnabled: boolean

  /** Organisation Clerk d'un workspace d'équipe (`org_…`, tâche 10) ; null pour un personnel. */
  @column()
  declare clerkOrganizationId: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  /** Valeur par défaut de la colonne, connue de l'instance dès sa création (pas de relecture). */
  @beforeCreate()
  static enableAiByDefault(model: Workspace) {
    if (model.$attributes.aiEnabled === undefined) model.aiEnabled = true
  }
}
