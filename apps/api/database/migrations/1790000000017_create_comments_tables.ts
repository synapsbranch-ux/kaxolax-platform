import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Commentaires ancrés dans le texte : un fil par passage commenté, ses messages ensuite. Les
 * auteurs sont en RESTRICT (comptes anonymisés, jamais supprimés).
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('comment_threads', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table
        .uuid('document_id')
        .notNullable()
        .references('id')
        .inTable('documents')
        .onDelete('CASCADE')
      // Positions relatives Yjs (début et fin) encodées : l'ancre suit le texte édité.
      table.binary('anchor').notNullable()
      // Citation d'origine, affichée si le texte ancré disparaît.
      table.text('quoted_text').notNullable()
      table.timestamp('resolved_at', { useTz: true }).nullable()
      table.uuid('resolved_by').nullable().references('id').inTable('users').onDelete('RESTRICT')
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.check('(resolved_at IS NULL) = (resolved_by IS NULL)', [], 'comment_threads_resolution')
      table.index(['project_id', 'created_at'])
      table.index(['document_id'])
    })

    this.schema.createTable('comments', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('thread_id')
        .notNullable()
        .references('id')
        .inTable('comment_threads')
        .onDelete('CASCADE')
      table.uuid('author_id').notNullable().references('id').inTable('users').onDelete('RESTRICT')
      table.text('body').notNullable()
      table.timestamp('edited_at', { useTz: true }).nullable()
      // Suppression douce : le fil garde sa structure.
      table.timestamp('deleted_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['thread_id', 'created_at'])
    })
  }

  override async down() {
    this.schema.dropTable('comments')
    this.schema.dropTable('comment_threads')
  }
}
