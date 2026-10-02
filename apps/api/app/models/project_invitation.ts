import type { AssignableRole } from '@kaxolax/contracts'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/** Rôles proposés à l'invitation (la propriété passe par un transfert). */
export type InvitationRole = AssignableRole

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

  /**
   * Annulation par le propriétaire. La ligne est gardée : inviter à nouveau la même adresse la
   * réactive, avec son nombre d'envois et la date du dernier envoi (limites d'envoi).
   */
  @column.dateTime()
  declare cancelledAt: DateTime | null

  /** Dernier envoi de l'email (création ou relance). */
  @column.dateTime()
  declare lastSentAt: DateTime

  /** Nombre d'envois, création comprise. */
  @column()
  declare sendCount: number

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
