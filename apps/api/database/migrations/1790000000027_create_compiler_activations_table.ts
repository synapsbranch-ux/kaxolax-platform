import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Compilateurs (conteneurs Cloudflare) réveillés par chaque utilisateur, projet par projet : sert
 * au plafond par utilisateur de `compiler/warm` et de la compilation asynchrone.
 */
export default class extends BaseSchema {
  protected tableName = 'compiler_activations'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.timestamp('last_activity_at', { useTz: true }).notNullable()
      table.primary(['user_id', 'project_id'])
    })
  }

  override async down() {
    this.schema.dropTable(this.tableName)
  }
}
