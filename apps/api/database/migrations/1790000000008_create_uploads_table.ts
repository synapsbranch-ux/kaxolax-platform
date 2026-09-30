import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'uploads'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      // Nul pour un import zip : le projet n'existe pas encore.
      table.uuid('project_id').nullable().references('id').inTable('projects').onDelete('CASCADE')
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.enum('purpose', ['file', 'import']).notNullable().defaultTo('file')
      table.string('s3_key', 1024).notNullable()
      table.string('filename', 255).notNullable()
      table.uuid('folder_id').nullable().references('id').inTable('folders').onDelete('SET NULL')
      table.bigInteger('size_bytes').notNullable()
      table.enum('status', ['pending', 'completed', 'failed']).notNullable().defaultTo('pending')
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['user_id', 'status'])
    })
  }

  override async down() {
    this.schema.dropTable(this.tableName)
  }
}
