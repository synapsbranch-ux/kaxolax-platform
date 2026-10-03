import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Jetons d'accès personnels (serveur MCP, tâche 7). Le secret n'est jamais stocké : seulement son
 * hachage SHA-256 et un préfixe affichable (`kxp_` + identifiant public, unique, clé de recherche).
 * Portées `read`/`write`, projets autorisés (NULL : tous ceux dont le compte est membre),
 * expiration obligatoire, révocation douce (`revoked_at`) ; jetons d'un compte supprimé révoqués
 * par `deleteClerkUser`. Nouvelle table.
 */
export default class extends BaseSchema {
  protected tableName = 'personal_access_tokens'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.string('name', 100).notNullable()
      table.string('token_prefix', 32).notNullable().unique()
      // SHA-256 du secret complet, en hexadécimal.
      table.string('token_hash', 64).notNullable()
      table.specificType('scopes', 'text[]').notNullable()
      // Pas de clé étrangère possible sur un tableau : un projet supprimé depuis reste nommé, sans
      // effet (l'accès est revérifié à chaque utilisation).
      table.specificType('project_ids', 'uuid[]').nullable()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('last_used_at', { useTz: true }).nullable()
      table.timestamp('revoked_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.check(
        `cardinality(scopes) >= 1 AND scopes <@ ARRAY['read', 'write']::text[]`,
        [],
        'personal_access_tokens_scopes',
      )
      table.check(
        'project_ids IS NULL OR cardinality(project_ids) >= 1',
        [],
        'personal_access_tokens_projects',
      )
      table.check(`token_hash ~ '^[0-9a-f]{64}$'`, [], 'personal_access_tokens_hash')
      table.index(['user_id', 'created_at'])
    })
  }

  override async down() {
    this.schema.dropTable(this.tableName)
  }
}
