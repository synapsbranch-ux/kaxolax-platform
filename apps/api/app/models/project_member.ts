import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

export type ProjectRole = 'owner' | 'editor' | 'reviewer' | 'viewer'

/**
 * Toutes les permissions passent par cette table. Clé de substitution `id` (Lucid ne gère qu'une
 * colonne de clé primaire) : `save()` et `delete()` sur une instance ne touchent que sa ligne. Le
 * couple (projectId, userId) est unique.
 */
export default class ProjectMember extends UuidModel {
  static override table = 'project_members'

  @column()
  declare projectId: string

  @column()
  declare userId: string

  @column()
  declare role: ProjectRole

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
