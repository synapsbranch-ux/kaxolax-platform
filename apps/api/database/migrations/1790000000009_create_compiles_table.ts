import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'compiles'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
      // L'identifiant est le buildId de la compilation.
      table.uuid('id').primary()
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.enum('compiler', ['pdflatex', 'xelatex', 'lualatex']).notNullable()
      table.enum('status', ['success', 'failure', 'timeout', 'error']).notNullable()
      table.integer('duration_ms').notNullable()
      table.string('agent_id', 255).nullable()
      table.string('output_prefix', 1024).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      // Sert aussi aux quotas de l'étape 2 (compilations par utilisateur et par période).
      table.index(['project_id', 'created_at'])
      table.index(['user_id', 'created_at'])
    })
  }

  override async down() {
    this.schema.dropTable(this.tableName)
  }
}
