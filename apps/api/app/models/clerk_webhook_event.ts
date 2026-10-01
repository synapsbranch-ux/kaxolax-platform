import { BaseModel, column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'

/** Webhook Clerk déjà traité, identifié par son en-tête `svix-id`. */
export default class ClerkWebhookEvent extends BaseModel {
  static override table = 'clerk_webhook_events'

  @column({ isPrimary: true })
  declare id: string

  @column()
  declare type: string

  @column.dateTime()
  declare processedAt: DateTime
}
