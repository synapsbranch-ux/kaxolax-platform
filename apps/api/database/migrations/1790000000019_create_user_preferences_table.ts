import { BaseSchema } from '@adonisjs/lucid/schema'

/** Préférences de l'éditeur par utilisateur (thème, police, raccourcis, correcteur…). */
export default class extends BaseSchema {
  protected tableName = 'user_preferences'

  override async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.uuid('user_id').primary().references('id').inTable('users').onDelete('CASCADE')
      // Contenu validé par l'API (schéma zod partagé) ; la base garantit seulement un objet.
      table.jsonb('prefs').notNullable().defaultTo(this.raw(`'{}'::jsonb`))
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.check(`jsonb_typeof(prefs) = 'object'`, [], 'user_preferences_prefs_object')
    })
  }

  override async down() {
    this.schema.dropTable(this.tableName)
  }
}
