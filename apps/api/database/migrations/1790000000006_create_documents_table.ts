import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'documents'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.uuid('folder_id').nullable().references('id').inTable('folders').onDelete('CASCADE')
      table.string('name', 255).notNullable()
      // État Yjs complet du document (un seul Y.Text nommé « content »).
      table.binary('yjs_state').nullable()
      table.string('content_sha256', 64).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['project_id'])
    })
    this.schema.raw(
      `CREATE UNIQUE INDEX documents_name_unique ON documents (project_id, COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), name)`,
    )
    this.schema.alterTable('projects', (table) => {
      table.foreign('main_document_id').references('id').inTable('documents').onDelete('SET NULL')
    })
  }

  override async down() {
    this.schema.alterTable('projects', (table) => {
      table.dropForeign(['main_document_id'])
    })
    this.schema.dropTable(this.tableName)
  }
}
