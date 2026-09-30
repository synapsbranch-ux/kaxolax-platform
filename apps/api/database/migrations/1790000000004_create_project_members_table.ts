import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'project_members'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      // Seul « owner » est utilisé à l'étape 1 ; le partage arrive à l'étape 2.
      table.enum('role', ['owner', 'editor', 'reviewer', 'viewer']).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.primary(['project_id', 'user_id'])
      table.index(['user_id'])
    })
  }

  override async down() {
    this.schema.dropTable(this.tableName)
  }
}
