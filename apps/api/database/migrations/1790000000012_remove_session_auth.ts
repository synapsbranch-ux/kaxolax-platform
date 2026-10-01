import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Fin de l'authentification par session de l'étape 1 : plus de mot de passe ni de jeton d'email
 * côté Kaxolax, et chaque compte est relié à Clerk. À appliquer après `clerk:import-users` (commit
 * 56e4814) : un compte vérifié non relié bloque la migration au lieu d'être perdu.
 */
export default class extends BaseSchema {
  override async up() {
    // Comptes jamais vérifiés : ils ne pouvaient pas se connecter, donc n'ont rien créé.
    this.defer(async (db) => {
      await db
        .from('users')
        .whereNull('clerk_user_id')
        .whereNull('email_verified_at')
        .whereNull('deleted_at')
        .delete()
      const unlinked = await db.from('users').whereNull('clerk_user_id').count('* as total')
      const total = Number((unlinked[0] as { total: string | number }).total)
      if (total > 0) {
        throw new Error(
          `${String(total)} verified account(s) are not linked to Clerk: run "node ace clerk:import-users" (commit 56e4814) first`,
        )
      }
    })
    this.schema.dropTable('auth_tokens')
    this.schema.alterTable('users', (table) => {
      table.dropColumn('password_hash')
      table.dropColumn('email_verified_at')
      table.string('clerk_user_id', 64).notNullable().alter()
    })
  }

  override async down() {
    this.schema.alterTable('users', (table) => {
      table.string('clerk_user_id', 64).nullable().alter()
      table.string('password_hash').nullable()
      table.timestamp('email_verified_at', { useTz: true }).nullable()
    })
    this.schema.createTable('auth_tokens', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.enum('type', ['email_verification', 'password_reset']).notNullable()
      table.string('token_hash', 64).notNullable().unique()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('used_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['user_id', 'type'])
    })
  }
}
