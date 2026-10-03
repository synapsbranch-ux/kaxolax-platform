import { BaseModel, column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'

/**
 * Miroir d'une Organisation Clerk (webhooks `organization.*`, commande de rattrapage). Le
 * workspace d'équipe en est dérivé (#services/team_sync) ; `deletedAt` : organisation supprimée,
 * état définitif.
 */
export default class ClerkOrganization extends BaseModel {
  static override table = 'clerk_organizations'
  static override selfAssignPrimaryKey = true

  @column({ isPrimary: true })
  declare clerkOrganizationId: string

  @column()
  declare name: string

  @column()
  declare slug: string | null

  @column()
  declare createdByClerkUserId: string | null

  @column.dateTime()
  declare deletedAt: DateTime | null

  /** Date Clerk du dernier état appliqué. */
  @column.dateTime()
  declare eventAt: DateTime

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
