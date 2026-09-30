import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'files'

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
      // Contenu dans S3 (bucket project-files).
      table.string('s3_key', 1024).notNullable()
      table.string('sha256', 64).notNullable()
      table.bigInteger('size_bytes').notNullable()
      table.string('mime_type', 255).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['project_id'])
    })
    this.schema.raw(
      `CREATE UNIQUE INDEX files_name_unique ON files (project_id, COALESCE(folder_id, '00000000-0000-0000-0000-000000000000'::uuid), name)`,
    )
  }

  override async down() {
    this.schema.dropTable(this.tableName)
  }
}
