import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Conversations avec l'assistant IA : privées à leur auteur, dans un projet. Les messages gardent
 * le contenu tel que l'API le renvoie (tableau JSON de blocs : texte, `thinking` signés,
 * `tool_use`, `tool_result`, `fallback`…), à renvoyer à l'identique au tour suivant. Données
 * personnelles de l'auteur : supprimées avec le projet (CASCADE) ou à la suppression de son compte
 * (`deleteClerkUser` : la ligne `users` est anonymisée, jamais supprimée). Nouvelles tables.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('ai_conversations', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('title', 200).nullable()
      table.timestamp('archived_at', { useTz: true }).nullable()
      table.timestamp('last_message_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })
    // Pagination par curseur (dernier message, id) des conversations d'un membre dans un projet.
    this.schema.raw(
      `CREATE INDEX ai_conversations_page_index
         ON ai_conversations (project_id, user_id, last_message_at DESC, id DESC)`,
    )

    this.schema.createTable('ai_messages', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('conversation_id')
        .notNullable()
        .references('id')
        .inTable('ai_conversations')
        .onDelete('CASCADE')
      table.enum('role', ['user', 'assistant']).notNullable()
      table.jsonb('content').notNullable()
      // Modèle qui a répondu (`message.model`, repli serveur compris) ; null pour l'utilisateur.
      table.string('model', 64).nullable()
      table
        .enum('status', ['streaming', 'complete', 'refused', 'truncated', 'failed'])
        .notNullable()
        .defaultTo('complete')
      table.string('stop_reason', 32).nullable()
      // `usage` de la réponse de l'API, tel quel (tokens, cache, itérations du repli).
      table.jsonb('usage').nullable()
      table.string('error_code', 64).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.check(`jsonb_typeof(content) = 'array'`, [], 'ai_messages_content_array')
      // Pagination des messages d'une conversation (date, id).
      table.index(['conversation_id', 'created_at', 'id'])
    })
  }

  override async down() {
    this.schema.dropTable('ai_messages')
    this.schema.dropTable('ai_conversations')
  }
}
