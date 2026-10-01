import { BaseSchema } from '@adonisjs/lucid/schema'

/** Événements Clerk déjà traités (identifiant `svix-id`) : un webhook rejoué n'a aucun effet. */
export default class extends BaseSchema {
  protected tableName = 'clerk_webhook_events'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.string('id', 255).primary()
      table.string('type', 100).notNullable()
      table.timestamp('processed_at', { useTz: true }).notNullable().defaultTo(this.now())
    })
  }

  override async down() {
    this.schema.dropTable(this.tableName)
  }
}
