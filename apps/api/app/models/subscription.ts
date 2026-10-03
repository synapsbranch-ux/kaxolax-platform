import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/**
 * Miroir d'un élément d'abonnement Clerk Billing, alimenté par les webhooks subscription.* et
 * subscriptionItem.*. Payeur : un compte (`userId`) ou une organisation (`clerkOrganizationId`).
 */
export default class Subscription extends UuidModel {
  @column()
  declare userId: string | null

  /** Organisation Clerk payeuse (plan d'équipe) ; null pour un abonnement personnel. */
  @column()
  declare clerkOrganizationId: string | null

  @column()
  declare clerkSubscriptionItemId: string

  @column()
  declare planSlug: string

  /** Statut Clerk tel quel (active, past_due, canceled, ended…). */
  @column()
  declare status: string

  @column.dateTime()
  declare periodEnd: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  /**
   * Date Clerk de l'état reflété (horodatage du webhook appliqué) : un événement plus ancien ne
   * l'écrase pas (#services/billing_webhooks).
   */
  @column.dateTime({ autoCreate: true })
  declare updatedAt: DateTime
}
