import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Relances d'invitation : date du dernier envoi et nombre d'envois, pour limiter leur fréquence
 * (une relance remplace le jeton et repousse l'expiration). Les lignes existantes reçoivent leur
 * date de création et un envoi : aucune donnée perdue.
 */
export default class extends BaseSchema {
  protected tableName = 'project_invitations'

  override async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.timestamp('last_sent_at', { useTz: true }).nullable()
      table.integer('send_count').notNullable().defaultTo(1)
    })
    this.defer(async (db) => {
      await db.rawQuery('UPDATE project_invitations SET last_sent_at = created_at')
    })
    this.schema.raw(
      `ALTER TABLE project_invitations
         ALTER COLUMN last_sent_at SET DEFAULT now(),
         ALTER COLUMN last_sent_at SET NOT NULL,
         ADD CONSTRAINT project_invitations_send_count_positive CHECK (send_count > 0)`,
    )
  }

  override async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropChecks(['project_invitations_send_count_positive'])
      table.dropColumn('send_count')
      table.dropColumn('last_sent_at')
    })
  }
}
