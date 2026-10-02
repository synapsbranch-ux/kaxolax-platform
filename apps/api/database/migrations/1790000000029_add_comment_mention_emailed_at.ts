import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Commentaires (tâche 7) : date du dernier email de mention envoyé à chaque membre, pour limiter
 * ces emails à un par intervalle (la mention suivante après l'intervalle en redonne un).
 */
export default class extends BaseSchema {
  protected tableName = 'project_members'

  override async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.timestamp('comment_mention_emailed_at', { useTz: true }).nullable()
    })
  }

  override async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('comment_mention_emailed_at')
    })
  }
}
