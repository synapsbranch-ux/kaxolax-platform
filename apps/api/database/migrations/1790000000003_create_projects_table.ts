import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'projects'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('name', 255).notNullable()
      table
        .enum('compiler', ['pdflatex', 'xelatex', 'lualatex'])
        .notNullable()
        .defaultTo('pdflatex')
      // Clé étrangère ajoutée avec la table documents.
      table.uuid('main_document_id').nullable()
      // Corbeille = trashed_at renseigné.
      table.timestamp('archived_at', { useTz: true }).nullable()
      table.timestamp('trashed_at', { useTz: true }).nullable()
      table.timestamp('last_compiled_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['owner_id'])
    })
  }

  override async down() {
    this.schema.dropTable(this.tableName)
  }
}
