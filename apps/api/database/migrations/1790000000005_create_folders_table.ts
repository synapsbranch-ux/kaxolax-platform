import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'folders'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      // parent_id nul = racine du projet.
      table.uuid('parent_id').nullable().references('id').inTable('folders').onDelete('CASCADE')
      table.string('name', 255).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['project_id'])
    })
    // Filet de sécurité : l'unicité entre types (dossier, document, fichier) est vérifiée par le
    // service, dans une transaction ; ces index garantissent au moins l'unicité par type.
    this.schema.raw(
      `CREATE UNIQUE INDEX folders_name_unique ON folders (project_id, COALESCE(parent_id, '00000000-0000-0000-0000-000000000000'::uuid), name)`,
    )
  }

  override async down() {
    this.schema.dropTable(this.tableName)
  }
}
