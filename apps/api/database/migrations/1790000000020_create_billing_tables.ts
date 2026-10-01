import { BaseSchema } from '@adonisjs/lucid/schema'

const MIB = 1024 * 1024

/**
 * Abonnements : limites chiffrées par slug de plan Clerk (valeurs Kaxolax, NULL = illimité) et
 * miroir des abonnements alimenté par les webhooks Billing.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('plan_limits', (table) => {
      table.string('plan_slug', 64).primary()
      table.integer('max_compile_seconds').notNullable()
      // Collaborateurs en plus du propriétaire ; NULL = illimité.
      table.integer('max_collaborators').nullable()
      // NULL = historique complet.
      table.integer('history_retention_days').nullable()
      table.bigInteger('storage_bytes').notNullable()
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.check('max_compile_seconds > 0', [], 'plan_limits_compile_positive')
      table.check(
        'max_collaborators IS NULL OR max_collaborators >= 0',
        [],
        'plan_limits_collaborators_positive',
      )
      table.check(
        'history_retention_days IS NULL OR history_retention_days > 0',
        [],
        'plan_limits_history_positive',
      )
      table.check('storage_bytes > 0', [], 'plan_limits_storage_positive')
    })
    // Valeurs de départ, par slug de plan du Dashboard Clerk (Mo et Go comptés en binaire).
    this.defer(async (db) => {
      await db
        .insertQuery()
        .table('plan_limits')
        .multiInsert([
          {
            plan_slug: 'free',
            max_compile_seconds: 20,
            max_collaborators: 1,
            history_retention_days: 1,
            storage_bytes: 500 * MIB,
          },
          {
            plan_slug: 'pro',
            max_compile_seconds: 240,
            max_collaborators: null,
            history_retention_days: null,
            storage_bytes: 20 * 1024 * MIB,
          },
        ])
    })

    this.schema.createTable('subscriptions', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      // Clé de l'upsert des webhooks subscriptionItem.*.
      table.string('clerk_subscription_item_id', 64).notNullable().unique()
      // Pas de clé étrangère vers plan_limits : un plan créé dans Clerk avant sa ligne de limites
      // ne doit pas faire échouer le webhook.
      table.string('plan_slug', 64).notNullable()
      // Statut Clerk tel quel (active, past_due, canceled, ended…) : liste ouverte côté Clerk.
      table.string('status', 32).notNullable()
      table.timestamp('period_end', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['user_id'])
      table.index(['plan_slug', 'status'])
    })
  }

  override async down() {
    this.schema.dropTable('subscriptions')
    this.schema.dropTable('plan_limits')
  }
}
