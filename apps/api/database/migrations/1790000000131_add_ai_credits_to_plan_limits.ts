import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Crédits mensuels par plan : `ai_monthly_credits` (1 crédit = 0,01 $ de coût de l'API
 * Anthropic) et `image_monthly_credits` (images bitmap, à l'unité). Valeurs de départ proposées,
 * à confirmer par l'utilisateur : Free 100 crédits IA et 5 images, Pro 2000 crédits IA et
 * 100 images. Un plan sans valeur reçoit 0 (pas d'IA) tant que sa ligne n'est pas complétée.
 */
export default class extends BaseSchema {
  protected tableName = 'plan_limits'

  override async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.integer('ai_monthly_credits').notNullable().defaultTo(0)
      table.integer('image_monthly_credits').notNullable().defaultTo(0)
      table.check('ai_monthly_credits >= 0', [], 'plan_limits_ai_credits_positive')
      table.check('image_monthly_credits >= 0', [], 'plan_limits_image_credits_positive')
    })
    this.defer(async (db) => {
      await db
        .from(this.tableName)
        .where('plan_slug', 'free')
        .update({ ai_monthly_credits: 100, image_monthly_credits: 5 })
      await db
        .from(this.tableName)
        .where('plan_slug', 'pro')
        .update({ ai_monthly_credits: 2000, image_monthly_credits: 100 })
    })
  }

  override async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropChecks(['plan_limits_ai_credits_positive', 'plan_limits_image_credits_positive'])
      table.dropColumn('image_monthly_credits')
      table.dropColumn('ai_monthly_credits')
    })
  }
}
