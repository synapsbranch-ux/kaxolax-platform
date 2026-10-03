import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Abonnements d'organisation (plan `team`, Clerk Billing) dans le miroir `subscriptions` : le
 * payeur est soit un compte (`user_id`), soit une organisation (`clerk_organization_id`, sans clé
 * étrangère : l'abonnement peut arriver avant l'organisation). Les lignes existantes ont toutes
 * un `user_id` : la contrainte est satisfaite sans réécriture.
 */
export default class extends BaseSchema {
  protected tableName = 'subscriptions'

  override async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.setNullable('user_id')
      table.string('clerk_organization_id', 64).nullable()
      table.check(
        '(user_id IS NULL) <> (clerk_organization_id IS NULL)',
        [],
        'subscriptions_single_payer',
      )
      table.index(['clerk_organization_id'])
    })
  }

  override async down() {
    // Revenir en arrière supprimerait des abonnements d'organisation : refusé s'il en existe.
    const rows = (await this.db
      .from(this.tableName)
      .whereNotNull('clerk_organization_id')
      .count('* as total')
      .first()) as { total: string | number } | null
    if (Number(rows?.total ?? 0) > 0) {
      throw new Error('Organization subscriptions exist: refusing to drop clerk_organization_id')
    }
    this.schema.alterTable(this.tableName, (table) => {
      table.dropChecks(['subscriptions_single_payer'])
      table.dropIndex(['clerk_organization_id'])
      table.dropColumn('clerk_organization_id')
      table.dropNullable('user_id')
    })
  }
}
