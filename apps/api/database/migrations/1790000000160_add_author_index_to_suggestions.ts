import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Suivi des modifications (tâche 2) : suggestions d'un auteur dans un projet (décision « toutes
 * celles d'un auteur », filtre du panneau Review, limite de débit des créations). Index seul :
 * aucune donnée ne change.
 */
export default class extends BaseSchema {
  protected tableName = 'suggestions'

  override async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.index(['project_id', 'author_id', 'created_at'], 'suggestions_project_author_index')
    })
  }

  override async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropIndex(['project_id', 'author_id', 'created_at'], 'suggestions_project_author_index')
    })
  }
}
