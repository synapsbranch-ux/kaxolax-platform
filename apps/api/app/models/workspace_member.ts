import { type WorkspaceRole } from '@kaxolax/contracts'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/**
 * Appartenance à un workspace (seul le propriétaire à l'étape 2). Clé de substitution `id`, comme
 * ProjectMember ; le couple (workspaceId, userId) est unique.
 */
export default class WorkspaceMember extends UuidModel {
  static override table = 'workspace_members'

  @column()
  declare workspaceId: string

  @column()
  declare userId: string

  @column()
  declare role: WorkspaceRole

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
