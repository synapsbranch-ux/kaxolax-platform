import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/**
 * Miroir d'une adhésion à une Organisation Clerk (webhooks `organizationMembership.*`), gardé même
 * si le compte ou l'organisation n'est pas encore connu localement. `deletedAt` : adhésion
 * retirée (elle peut renaître par un événement plus récent).
 */
export default class ClerkOrganizationMembership extends UuidModel {
  static override table = 'clerk_organization_memberships'

  @column()
  declare clerkOrganizationId: string

  @column()
  declare clerkUserId: string

  /** Rôle Clerk tel quel (`org:admin`, `org:member`, rôle personnalisé). */
  @column()
  declare role: string

  @column.dateTime()
  declare deletedAt: DateTime | null

  /** Date Clerk du dernier état appliqué. */
  @column.dateTime()
  declare eventAt: DateTime

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
