import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Clé de substitution `id` pour project_members. Lucid ne gère qu'une colonne de clé primaire :
 * avec la clé composée, `save()` et `delete()` sur une instance ne filtraient que sur `user_id`,
 * donc touchaient tous les projets du membre. Le couple (project_id, user_id) reste unique ; chaque
 * ligne existante reçoit son UUID (gen_random_uuid() est évalué ligne par ligne).
 */
export default class extends BaseSchema {
  protected tableName = 'project_members'

  override async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.uuid('id').notNullable().defaultTo(this.raw('gen_random_uuid()'))
    })
    this.schema.alterTable(this.tableName, (table) => {
      table.dropPrimary()
      table.primary(['id'])
      table.unique(['project_id', 'user_id'])
    })
  }

  override async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropUnique(['project_id', 'user_id'])
      table.dropPrimary()
      table.primary(['project_id', 'user_id'])
    })
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('id')
    })
  }
}
