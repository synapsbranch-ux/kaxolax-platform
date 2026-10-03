import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Suivi des modifications (tâche 2) : limite de débit des modifications et retraits de
 * suggestions (`PATCH`, `DELETE`) d'un membre dans un projet, par fenêtre fixe (une ligne par
 * membre et projet, mise à jour en une requête). Suggestions en attente (ouvertes ou obsolètes)
 * d'un auteur : index partiel pour le plafond vérifié à chaque création. Nouvelle table et index :
 * aucune donnée existante ne change.
 */
export default class extends BaseSchema {
  protected tableName = 'suggestion_edit_rates'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.timestamp('window_started_at', { useTz: true }).notNullable()
      table.integer('edits').notNullable()
      table.primary(['project_id', 'user_id'])
      // Côté référençant de `user_id` (CASCADE) : la suppression d'un compte ne parcourt pas tout.
      table.index(['user_id'])
    })
    this.schema.raw(
      `CREATE INDEX suggestions_pending_author_index ON suggestions (project_id, author_id)
         WHERE status IN ('open', 'stale')`,
    )
  }

  override async down() {
    this.schema.raw('DROP INDEX IF EXISTS suggestions_pending_author_index')
    this.schema.dropTable(this.tableName)
  }
}
