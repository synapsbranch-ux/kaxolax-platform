import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Partage : une invitation annulée est gardée (`cancelled_at`) pour que les limites d'envoi
 * (fréquence, nombre d'envois, créations par heure) survivent à une annulation ; et journal des
 * actions de partage (qui a invité, changé un rôle, activé un lien, rejoint par un lien…). Le
 * journal n'a pas de clé étrangère : il reste lisible après la suppression du projet.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.alterTable('project_invitations', (table) => {
      table.timestamp('cancelled_at', { useTz: true }).nullable()
      table.check(
        'cancelled_at IS NULL OR accepted_at IS NULL',
        [],
        'project_invitations_cancelled_or_accepted',
      )
      // Limite de créations par heure et par compte.
      table.index(['invited_by', 'created_at'])
    })

    this.schema.createTable('project_sharing_events', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table.uuid('project_id').notNullable()
      // Compte à l'origine de l'action (l'invité lui-même pour une acceptation à l'inscription).
      table.uuid('actor_id').notNullable()
      table.string('action', 100).notNullable()
      table.uuid('target_user_id').nullable()
      // Jamais de jeton ni d'URL de lien.
      table.jsonb('metadata').notNullable().defaultTo(this.raw(`'{}'::jsonb`))
      // Heure de l'action elle-même (pas celle du début de la transaction) : ordre fidèle.
      table
        .timestamp('created_at', { useTz: true })
        .notNullable()
        .defaultTo(this.raw('clock_timestamp()'))
      table.check(`jsonb_typeof(metadata) = 'object'`, [], 'project_sharing_events_metadata_object')
      table.index(['project_id', 'created_at'])
      table.index(['actor_id', 'created_at'])
    })
  }

  override async down() {
    this.schema.dropTable('project_sharing_events')
    this.schema.alterTable('project_invitations', (table) => {
      table.dropIndex(['invited_by', 'created_at'])
      table.dropChecks(['project_invitations_cancelled_or_accepted'])
      table.dropColumn('cancelled_at')
    })
  }
}
