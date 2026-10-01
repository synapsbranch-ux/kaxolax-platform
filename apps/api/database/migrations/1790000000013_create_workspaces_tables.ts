import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Workspaces : tout projet appartient à un workspace. Seul le workspace personnel existe à
 * l'étape 2 (un par propriétaire, index unique partiel) ; le type « team » prépare l'étape 3.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('workspaces', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.string('name', 255).notNullable()
      table.enum('type', ['personal', 'team']).notNullable()
      // Un compte est anonymisé, jamais supprimé : CASCADE ne joue que pour une purge manuelle,
      // et projects.workspace_id (RESTRICT) l'empêche tant qu'un projet d'un autre y reste.
      table.uuid('owner_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['owner_id'])
    })
    // Arbitre aussi les créations simultanées (INSERT … ON CONFLICT DO NOTHING).
    this.schema.raw(
      `CREATE UNIQUE INDEX workspaces_personal_owner_unique ON workspaces (owner_id) WHERE type = 'personal'`,
    )

    // Clé de substitution : Lucid ne gère qu'une colonne de clé primaire (voir ProjectMember).
    this.schema.createTable('workspace_members', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('workspace_id')
        .notNullable()
        .references('id')
        .inTable('workspaces')
        .onDelete('CASCADE')
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      // Seul « owner » est utilisé à l'étape 2.
      table.enum('role', ['owner', 'admin', 'member']).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      // Arbitre aussi les ajouts simultanés (INSERT … ON CONFLICT DO NOTHING).
      table.unique(['workspace_id', 'user_id'])
      table.index(['user_id'])
    })
  }

  override async down() {
    this.schema.dropTable('workspace_members')
    this.schema.dropTable('workspaces')
  }
}
