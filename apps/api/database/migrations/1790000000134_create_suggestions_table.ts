import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Suivi des modifications (tâche 2) : suggestions ancrées dans un document par deux positions
 * relatives Yjs, au même format que `comment_threads.anchor`. Le texte du document ne change qu'à
 * l'acceptation. Auteurs et décideurs en RESTRICT (comptes anonymisés, jamais supprimés), comme
 * les commentaires. Nouvelle table : aucune donnée existante ne change.
 */
export default class extends BaseSchema {
  protected tableName = 'suggestions'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
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
      // Membre qui a suggéré, ou qui a sollicité l'IA (`origin` = ai).
      table.uuid('author_id').notNullable().references('id').inTable('users').onDelete('RESTRICT')
      table.enum('origin', ['user', 'ai']).notNullable()
      table.enum('kind', ['insert', 'delete', 'replace']).notNullable()
      // Positions relatives Yjs (début et fin) encodées (@kaxolax/collab, anchors).
      table.binary('anchor').notNullable()
      table.text('original_text').notNullable().defaultTo('')
      table.text('proposed_text').notNullable().defaultTo('')
      table
        .enum('status', ['open', 'accepted', 'rejected', 'stale'])
        .notNullable()
        .defaultTo('open')
      table.uuid('decided_by').nullable().references('id').inTable('users').onDelete('RESTRICT')
      table.timestamp('decided_at', { useTz: true }).nullable()
      table
        .uuid('ai_message_id')
        .nullable()
        .references('id')
        .inTable('ai_messages')
        .onDelete('SET NULL')
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      // Même règle que `suggestionTextsMatchKind` (@kaxolax/contracts).
      table.check(
        `(kind = 'insert' AND original_text = '' AND proposed_text <> '')
         OR (kind = 'delete' AND original_text <> '' AND proposed_text = '')
         OR (kind = 'replace' AND original_text <> '' AND proposed_text <> ''
             AND original_text <> proposed_text)`,
        [],
        'suggestions_texts_match_kind',
      )
      // Ouverte : pas de décision ; acceptée ou refusée : par un membre ; obsolète : sans décideur.
      table.check(
        `(status = 'open') = (decided_at IS NULL)
         AND (status IN ('accepted', 'rejected')) = (decided_by IS NOT NULL)`,
        [],
        'suggestions_decision',
      )
      table.check(`origin = 'ai' OR ai_message_id IS NULL`, [], 'suggestions_ai_message')
      // Panneau Review : suggestions d'un projet par statut ; affichage en ligne par document.
      table.index(['project_id', 'status', 'created_at'])
      table.index(['document_id', 'status'])
    })
    // Côté référençant de `ai_message_id` (SET NULL) : la suppression d'une conversation ou d'un
    // projet ne parcourt pas toute la table pour chaque message.
    this.schema.raw(
      `CREATE INDEX suggestions_ai_message_id_index ON suggestions (ai_message_id)
         WHERE ai_message_id IS NOT NULL`,
    )
  }

  override async down() {
    this.schema.dropTable(this.tableName)
  }
}
