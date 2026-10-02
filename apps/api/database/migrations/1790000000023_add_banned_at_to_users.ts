import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Compte banni (admin ou Dashboard Clerk) : l'API refuse aussitôt ses jetons de session encore
 * valides, et le service temps réel ses connexions. Posé par l'action de l'admin et par le
 * webhook `user.updated` (champ `banned`). `ban_state_updated_at` garde la date Clerk
 * (`updated_at` du compte) de l'état reflété : un webhook plus ancien, arrivé en retard, ne le
 * remplace pas. `sessions_revoked_at` : date de la dernière révocation des sessions par l'admin ;
 * l'API refuse les jetons Clerk émis avant (`iat`), le service temps réel les jetons temps réel
 * émis avant. Colonnes nullables : aucune ligne existante ne change.
 */
export default class extends BaseSchema {
  protected tableName = 'users'

  override async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.timestamp('banned_at', { useTz: true }).nullable()
      table.timestamp('ban_state_updated_at', { useTz: true }).nullable()
      table.timestamp('sessions_revoked_at', { useTz: true }).nullable()
    })
  }

  override async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('banned_at')
      table.dropColumn('ban_state_updated_at')
      table.dropColumn('sessions_revoked_at')
    })
  }
}
