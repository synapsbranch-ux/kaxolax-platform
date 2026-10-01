import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/** Miroir d'un abonnement Clerk Billing, alimenté par les webhooks subscriptionItem.*. */
export default class Subscription extends UuidModel {
  @column()
  declare userId: string

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

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
