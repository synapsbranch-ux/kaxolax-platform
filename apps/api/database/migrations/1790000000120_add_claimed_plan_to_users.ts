import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Dernier plan vu dans un jeton de session vérifié du compte (claims `pla` et `fea` de Clerk
 * Billing) et date d'émission de ce jeton (`iat`). Quand le compte n'est pas l'auteur de la
 * requête (collaborateur qui accepte une invitation, service temps réel), ses droits viennent de
 * la plus récente des deux sources : ce relevé ou le miroir `subscriptions` des webhooks. Toutes
 * les vérifications d'un projet lisent ainsi le même plan, même si un webhook manque ou tarde.
 * Colonnes nullables : aucune ligne existante ne change.
 */
export default class extends BaseSchema {
  protected tableName = 'users'

  override async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('claimed_plan_slug', 64).nullable()
      table.specificType('claimed_plan_features', 'text[]').nullable()
      table.timestamp('claimed_plan_at', { useTz: true }).nullable()
    })
  }

  override async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('claimed_plan_slug')
      table.dropColumn('claimed_plan_features')
      table.dropColumn('claimed_plan_at')
    })
  }
}
