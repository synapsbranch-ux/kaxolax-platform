import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import type { ProjectRole } from '#models/project_member'
import UuidModel from '#models/uuid_model'

/** Rôles proposés à l'invitation (la propriété passe par un transfert). */
export type InvitationRole = Exclude<ProjectRole, 'owner'>

export default class ProjectInvitation extends UuidModel {
  @column()
  declare projectId: string

  /** Toujours en minuscules. */
  @column()
  declare email: string

  @column()
  declare role: InvitationRole

  /** sha256 du jeton envoyé par email ; le jeton lui-même n'est jamais stocké. */
  @column({ serializeAs: null })
  declare tokenHash: string

  @column()
  declare invitedBy: string

  @column.dateTime()
  declare expiresAt: DateTime

  @column.dateTime()
  declare acceptedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
