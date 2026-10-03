import { BaseSchema } from '@adonisjs/lucid/schema'

const GIB = 1024 * 1024 * 1024

/**
 * Plan d'organisation `team` (Clerk Billing, prix par siège réglé dans le Dashboard Clerk).
 * `credits_per_seat` : les crédits IA et images du plan sont multipliés par le nombre de membres
 * de l'équipe (sièges) ; faux pour les plans existants, qui gardent leurs valeurs. Valeurs de
 * départ proposées, À CONFIRMER par l'utilisateur (docs/decisions.md) : limites de Pro
 * (compilation 240 s, collaborateurs illimités, historique complet), stockage mutualisé de
 * 50 Gio pour toute l'équipe, 2000 crédits IA et 100 images par siège et par mois. Ligne
 * insérée seulement si elle n'existe pas (réglage manuel préservé), retirée par `down`.
 */
export default class extends BaseSchema {
  protected tableName = 'plan_limits'

  override async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.boolean('credits_per_seat').notNullable().defaultTo(false)
    })
    this.defer(async (db) => {
      await db
        .insertQuery()
        .table(this.tableName)
        .insert({
          plan_slug: 'team',
          max_compile_seconds: 240,
          max_collaborators: null,
          history_retention_days: null,
          storage_bytes: 50 * GIB,
          ai_monthly_credits: 2000,
          image_monthly_credits: 100,
          credits_per_seat: true,
        })
        .onConflict('plan_slug')
        .ignore()
    })
  }

  override async down() {
    // Ligne de départ de cette migration, réinsérée par `up` : sans elle, un abonnement `team`
    // reflété prend les limites de Free le temps du retour en arrière (journalisé).
    this.defer(async (db) => {
      await db.from(this.tableName).where('plan_slug', 'team').delete()
    })
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('credits_per_seat')
    })
  }
}
