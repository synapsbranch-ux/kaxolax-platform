import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Emails Billing à envoyer (bienvenue Pro, paiement en retard), inscrits dans la transaction du
 * webhook qui applique la transition : un échec d'envoi ou un arrêt du processus ne les perd pas.
 * Tant qu'un email de l'événement reste non envoyé (`sent_at` NULL), le webhook répond 503 et
 * Clerk le relivre ; la relivraison, écartée par clerk_webhook_events, ne fait que renvoyer les
 * emails en attente. Nouvelle table : aucune donnée existante ne change.
 */
export default class extends BaseSchema {
  protected tableName = 'billing_mails'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary()
      table
        .string('event_id', 255)
        .notNullable()
        .references('id')
        .inTable('clerk_webhook_events')
        .onDelete('CASCADE')
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      // proWelcome | paymentPastDue
      table.string('kind', 32).notNullable()
      table.string('plan_name', 255).notNullable()
      table.integer('attempts').notNullable().defaultTo(0)
      table.text('last_error').nullable()
      table.timestamp('sent_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['event_id'])
    })
    // Emails en attente (reprise, suivi) : index partiel, petit par construction.
    this.schema.raw(
      'CREATE INDEX billing_mails_pending_index ON billing_mails (created_at) WHERE sent_at IS NULL',
    )
  }

  override async down() {
    this.schema.dropTable(this.tableName)
  }
}
