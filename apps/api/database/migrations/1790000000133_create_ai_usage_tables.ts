import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Consommation de l'IA :
 * - `ai_usage` : une ligne par appel (utilisateur qui a lancé l'action, projet, workspace,
 *   opération, modèle, tokens et coût calculé en micro-dollars). Projet et workspace passent à
 *   NULL s'ils sont supprimés : la consommation passée reste comptée ;
 * - `ai_credit_periods` : agrégat mensuel par compte (mois civil UTC), lu pour les crédits ;
 * - `ai_credit_reservations` : réservations en cours (estimation avant l'appel), réglées ou
 *   libérées après ; une réservation expirée (processus arrêté pendant l'appel) ne compte plus.
 * Nouvelles tables : aucune donnée existante ne change.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('ai_usage', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.uuid('project_id').nullable().references('id').inTable('projects').onDelete('SET NULL')
      table
        .uuid('workspace_id')
        .nullable()
        .references('id')
        .inTable('workspaces')
        .onDelete('SET NULL')
      table
        .uuid('ai_message_id')
        .nullable()
        .references('id')
        .inTable('ai_messages')
        .onDelete('SET NULL')
      // Liste ouverte côté application (AI_OPERATIONS de @kaxolax/contracts).
      table.string('operation', 32).notNullable()
      table.enum('credit_kind', ['ai', 'image']).notNullable().defaultTo('ai')
      table.string('model', 64).notNullable()
      table.integer('input_tokens').notNullable().defaultTo(0)
      table.integer('output_tokens').notNullable().defaultTo(0)
      table.integer('cache_read_input_tokens').notNullable().defaultTo(0)
      table.integer('cache_creation_input_tokens').notNullable().defaultTo(0)
      // Coût calculé avec la table de prix de l'API (app/services/claude/pricing.ts).
      table.bigInteger('cost_micros').notNullable()
      // Images facturées (crédits « images ») ; 0 pour un appel à Claude.
      table.integer('image_count').notNullable().defaultTo(0)
      // `stop_reason` de la réponse, ou `error` pour un appel interrompu après le début.
      table.string('stop_reason', 32).nullable()
      // En-tête `request-id` de l'API Anthropic (support).
      table.string('request_id', 128).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.check(
        `input_tokens >= 0 AND output_tokens >= 0 AND cache_read_input_tokens >= 0
         AND cache_creation_input_tokens >= 0 AND cost_micros >= 0 AND image_count >= 0`,
        [],
        'ai_usage_positive',
      )
      table.index(['user_id', 'created_at'])
      table.index(['project_id', 'created_at'])
      // Consommation globale (admin).
      table.index(['created_at'])
    })
    // Côté référençant des clés SET NULL : sans index, chaque message ou workspace supprimé
    // (projet supprimé, purge de la corbeille) parcourrait toute la table.
    this.schema.raw(
      `CREATE INDEX ai_usage_ai_message_id_index ON ai_usage (ai_message_id)
         WHERE ai_message_id IS NOT NULL`,
    )
    this.schema.raw(
      `CREATE INDEX ai_usage_workspace_id_index ON ai_usage (workspace_id)
         WHERE workspace_id IS NOT NULL`,
    )

    // Clé de substitution : Lucid ne gère qu'une colonne de clé primaire.
    this.schema.createTable('ai_credit_periods', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      // Premier jour du mois civil (UTC).
      table.date('period_start').notNullable()
      table.bigInteger('ai_used_micros').notNullable().defaultTo(0)
      table.integer('image_used').notNullable().defaultTo(0)
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      // Arbitre aussi les créations simultanées (INSERT … ON CONFLICT DO NOTHING).
      table.unique(['user_id', 'period_start'])
      table.check('ai_used_micros >= 0 AND image_used >= 0', [], 'ai_credit_periods_positive')
    })

    this.schema.createTable('ai_credit_reservations', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.date('period_start').notNullable()
      table.enum('kind', ['ai', 'image']).notNullable()
      // Micro-dollars (`ai`) ou images (`image`).
      table.bigInteger('amount').notNullable()
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.check('amount > 0', [], 'ai_credit_reservations_positive')
      table.index(['user_id', 'period_start', 'kind', 'expires_at'])
    })
  }

  override async down() {
    this.schema.dropTable('ai_credit_reservations')
    this.schema.dropTable('ai_credit_periods')
    this.schema.dropTable('ai_usage')
  }
}
