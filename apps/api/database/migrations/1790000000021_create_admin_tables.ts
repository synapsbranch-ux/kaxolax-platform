import { BaseSchema } from '@adonisjs/lucid/schema'

/** Admin : bannière système et journal des actions (auteurs en RESTRICT, jamais effacés). */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('system_banners', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.string('message', 500).notNullable()
      table.enum('level', ['info', 'warning', 'maintenance']).notNullable()
      table.timestamp('starts_at', { useTz: true }).notNullable()
      // NULL : affichée jusqu'à ce qu'un admin la termine.
      table.timestamp('ends_at', { useTz: true }).nullable()
      table.uuid('created_by').notNullable().references('id').inTable('users').onDelete('RESTRICT')
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.check('ends_at IS NULL OR ends_at > starts_at', [], 'system_banners_period')
      table.index(['starts_at', 'ends_at'])
    })

    this.schema.createTable('admin_audit_log', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.uuid('admin_id').notNullable().references('id').inTable('users').onDelete('RESTRICT')
      table.string('action', 100).notNullable()
      table.string('target_type', 50).notNullable()
      // Texte : la cible peut être un uuid local ou un identifiant Clerk.
      table.string('target_id', 255).nullable()
      table.jsonb('metadata').notNullable().defaultTo(this.raw(`'{}'::jsonb`))
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.check(`jsonb_typeof(metadata) = 'object'`, [], 'admin_audit_log_metadata_object')
      table.index(['created_at'])
      table.index(['admin_id', 'created_at'])
      table.index(['target_type', 'target_id'])
    })
  }

  override async down() {
    this.schema.dropTable('admin_audit_log')
    this.schema.dropTable('system_banners')
  }
}
