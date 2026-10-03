import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Intégration Zotero (tâche 9) : compte Zotero connecté par OAuth 1.0a (un par utilisateur, clé
 * d'API chiffrée au repos avec `APP_KEY`), et demandes OAuth en cours (jeton de requête et son
 * secret chiffré, liés au compte et à la session Clerk qui les a lancées, 15 minutes). Comme pour
 * les liens, un compte supprimé est anonymisé : `deleteClerkUser` supprime ses lignes, le CASCADE
 * ne sert qu'en filet. Nouvelles tables.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('zotero_accounts', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('user_id')
        .notNullable()
        .unique()
        .references('id')
        .inTable('users')
        .onDelete('CASCADE')
      // `userID` et `username` renvoyés par l'échange du jeton d'accès.
      table.string('zotero_user_id', 32).notNullable()
      table.string('zotero_username', 255).nullable()
      table.text('api_key_encrypted').notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
    })

    this.schema.createTable('zotero_oauth_requests', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      // Session Clerk (claim `sid`) qui a lancé la demande : seule elle peut la terminer.
      table.string('session_id', 255).notNullable()
      table.string('request_token', 255).notNullable().unique()
      table.text('request_token_secret_encrypted').notNullable()
      // SHA-256 (hex) du paramètre `state` de l'URL de rappel.
      table.string('state_hash', 64).notNullable()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['user_id'])
    })
  }

  override async down() {
    this.schema.dropTable('zotero_oauth_requests')
    this.schema.dropTable('zotero_accounts')
  }
}
