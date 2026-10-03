import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * IA désactivable par projet et par workspace (`ai_enabled`, activée par défaut : les lignes
 * existantes gardent l'IA disponible), et Organisation Clerk d'un workspace d'équipe
 * (`clerk_organization_id`, tâche 10 ; le type `team` existe depuis la migration 0013). Colonnes
 * ajoutées avec une valeur par défaut constante : aucune réécriture des tables (PostgreSQL ≥ 11),
 * aucune donnée existante ne change.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.alterTable('workspaces', (table) => {
      table.boolean('ai_enabled').notNullable().defaultTo(true)
      // Identifiant Clerk (`org_…`) ; un workspace personnel n'en a jamais.
      table.string('clerk_organization_id', 64).nullable().unique()
      table.check(
        `type = 'team' OR clerk_organization_id IS NULL`,
        [],
        'workspaces_organization_team_only',
      )
    })
    this.schema.alterTable('projects', (table) => {
      table.boolean('ai_enabled').notNullable().defaultTo(true)
    })
  }

  override async down() {
    this.schema.alterTable('projects', (table) => {
      table.dropColumn('ai_enabled')
    })
    this.schema.alterTable('workspaces', (table) => {
      table.dropChecks(['workspaces_organization_team_only'])
      table.dropUnique(['clerk_organization_id'])
      table.dropColumn('clerk_organization_id')
      table.dropColumn('ai_enabled')
    })
  }
}
