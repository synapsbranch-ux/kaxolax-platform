import { BaseModel, column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'

export type ProjectRole = 'owner' | 'editor' | 'reviewer' | 'viewer'

/** Toutes les permissions passent par cette table (seul « owner » existe à l'étape 1). */
export default class ProjectMember extends BaseModel {
  static override table = 'project_members'

  @column({ isPrimary: true })
  declare projectId: string

  @column({ isPrimary: true })
  declare userId: string

  @column()
  declare role: ProjectRole

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
