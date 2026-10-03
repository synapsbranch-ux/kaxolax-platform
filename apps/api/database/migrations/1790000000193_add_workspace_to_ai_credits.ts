import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Crédits IA mutualisés d'une équipe : une action de l'IA dans un projet d'équipe est imputée au
 * workspace d'équipe (plan de l'organisation), pas à l'utilisateur qui la lance.
 * - `ai_credit_periods` : agrégat par compte (`user_id`) OU par workspace d'équipe
 *   (`workspace_id`, avec son organisation `clerk_organization_id`) ; index unique partiel pour
 *   chacun. Workspace dissous : `workspace_id` passe à NULL, la ligne reste (consommation
 *   passée, rattachée à son organisation) au lieu d'être supprimée en cascade ;
 * - `ai_credit_reservations` : `user_id` reste l'auteur de l'appel ; `workspace_id` désigne la
 *   réserve d'équipe débitée (NULL : réserve personnelle).
 * Colonnes ajoutées NULL : les lignes existantes restent des réserves personnelles.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.alterTable('ai_credit_periods', (table) => {
      table.setNullable('user_id')
      table
        .uuid('workspace_id')
        .nullable()
        .references('id')
        .inTable('workspaces')
        .onDelete('SET NULL')
      // Pas de clé étrangère : l'organisation reste nommée après la dissolution du workspace.
      table.string('clerk_organization_id', 64).nullable()
      // Un compte ou une organisation ; un workspace seulement avec son organisation.
      table.check(
        'num_nonnulls(user_id, clerk_organization_id) = 1 AND (workspace_id IS NULL OR clerk_organization_id IS NOT NULL)',
        [],
        'ai_credit_periods_single_account',
      )
    })
    // Arbitre aussi les créations simultanées (INSERT … ON CONFLICT DO NOTHING).
    this.schema.raw(
      `CREATE UNIQUE INDEX ai_credit_periods_workspace_unique
         ON ai_credit_periods (workspace_id, period_start) WHERE workspace_id IS NOT NULL`,
    )
    this.schema.alterTable('ai_credit_reservations', (table) => {
      table
        .uuid('workspace_id')
        .nullable()
        .references('id')
        .inTable('workspaces')
        .onDelete('CASCADE')
      table.index(['workspace_id', 'period_start', 'kind', 'expires_at'])
    })
  }

  override async down() {
    // Revenir en arrière perdrait la consommation des équipes : refusé s'il en existe.
    const rows = (await this.db
      .from('ai_credit_periods')
      .whereNotNull('clerk_organization_id')
      .count('* as total')
      .first()) as { total: string | number } | null
    if (Number(rows?.total ?? 0) > 0) {
      throw new Error('Team AI credit periods exist: refusing to drop workspace_id')
    }
    this.schema.alterTable('ai_credit_reservations', (table) => {
      table.dropIndex(['workspace_id', 'period_start', 'kind', 'expires_at'])
      table.dropColumn('workspace_id')
    })
    this.schema.raw('DROP INDEX ai_credit_periods_workspace_unique')
    this.schema.alterTable('ai_credit_periods', (table) => {
      table.dropChecks(['ai_credit_periods_single_account'])
      table.dropColumn('clerk_organization_id')
      table.dropColumn('workspace_id')
      table.dropNullable('user_id')
    })
  }
}
