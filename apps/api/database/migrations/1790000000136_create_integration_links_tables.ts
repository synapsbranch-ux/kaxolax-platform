import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Intégrations d'un projet (schéma seulement ; logique : tâches 8 et 9) : un lien Git (GitHub)
 * et un lien Zotero au plus par projet. Les jetons OAuth sont chiffrés au repos par l'API
 * (encryption AdonisJS, AES-256-GCM avec `APP_KEY`, lié à leur colonne) : les colonnes
 * `*_encrypted` ne contiennent jamais de jeton en clair. Le compte qui a créé un lien étant
 * anonymisé et non supprimé, `deleteClerkUser` supprime ses liens (et leurs jetons) : le CASCADE sur
 * `owner_id` ne sert qu'en filet. Nouvelles tables.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('git_links', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('project_id')
        .notNullable()
        .unique()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      // Membre qui a créé le lien : ses jetons servent à la synchronisation.
      table.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('provider', 32).notNullable().defaultTo('github')
      table.string('repository_owner', 100).notNullable()
      table.string('repository_name', 100).notNullable()
      table.string('branch', 255).notNullable()
      // Installation de l'application GitHub (permissions minimales, dépôts choisis).
      table.bigInteger('installation_id').nullable()
      table.text('access_token_encrypted').nullable()
      table.text('refresh_token_encrypted').nullable()
      table.timestamp('token_expires_at', { useTz: true }).nullable()
      table.enum('sync_status', ['idle', 'syncing', 'error']).notNullable().defaultTo('idle')
      table.timestamp('last_synced_at', { useTz: true }).nullable()
      table.string('last_synced_commit', 64).nullable()
      table.text('last_error').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.check(`provider IN ('github')`, [], 'git_links_provider')
      table.index(['owner_id'])
    })

    this.schema.createTable('zotero_links', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('project_id')
        .notNullable()
        .unique()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      // Compte Zotero du propriétaire du lien (`userID` de l'OAuth).
      table.string('zotero_user_id', 32).nullable()
      table.enum('library_type', ['user', 'group']).notNullable()
      table.string('library_id', 32).notNullable()
      // Collection synchronisée ; NULL : toute la bibliothèque.
      table.string('collection_key', 16).nullable()
      // Document `.bib` alimenté par la synchronisation.
      table
        .uuid('document_id')
        .nullable()
        .references('id')
        .inTable('documents')
        .onDelete('SET NULL')
      table.text('api_key_encrypted').nullable()
      table.enum('sync_status', ['idle', 'syncing', 'error']).notNullable().defaultTo('idle')
      table.timestamp('last_synced_at', { useTz: true }).nullable()
      table.bigInteger('last_library_version').nullable()
      table.text('last_error').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['owner_id'])
    })
  }

  override async down() {
    this.schema.dropTable('zotero_links')
    this.schema.dropTable('git_links')
  }
}
