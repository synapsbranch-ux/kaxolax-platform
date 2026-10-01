import { BaseSchema } from '@adonisjs/lucid/schema'

/** Chat du projet : messages (auteur en RESTRICT) et dernière lecture par membre (non-lus). */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('chat_messages', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.uuid('author_id').notNullable().references('id').inTable('users').onDelete('RESTRICT')
      table.text('body').notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      // Historique paginé du plus récent au plus ancien, et compte des non-lus.
      table.index(['project_id', 'created_at'])
    })

    // Clé de substitution : Lucid ne gère qu'une colonne de clé primaire (voir ProjectMember).
    this.schema.createTable('chat_reads', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.timestamp('last_read_at', { useTz: true }).notNullable()
      table.unique(['project_id', 'user_id'])
    })
  }

  override async down() {
    this.schema.dropTable('chat_reads')
    this.schema.dropTable('chat_messages')
  }
}
