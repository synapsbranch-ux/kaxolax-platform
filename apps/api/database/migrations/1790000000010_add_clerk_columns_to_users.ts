import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * La table users devient le miroir local des comptes Clerk. `password_hash` reste nullable le
 * temps de la migration des comptes, puis disparaît avec l'authentification par session.
 */
export default class extends BaseSchema {
  protected tableName = 'users'

  override async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('clerk_user_id', 64).nullable().unique()
      table.string('avatar_url', 2048).nullable()
      // Compte supprimé dans Clerk : ligne gardée, anonymisée (auteur des messages à venir).
      table.timestamp('deleted_at', { useTz: true }).nullable()
      table.string('password_hash').nullable().alter()
    })
  }

  override async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('clerk_user_id')
      table.dropColumn('avatar_url')
      table.dropColumn('deleted_at')
    })
  }
}
