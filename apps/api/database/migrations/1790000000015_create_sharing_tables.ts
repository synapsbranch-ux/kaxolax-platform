import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Partage d'un projet : invitations par email et liens de partage. Seul le hash (sha256) des
 * jetons est stocké. Règle des auteurs (ici `invited_by`) : RESTRICT, car un compte est anonymisé
 * et jamais supprimé ; une suppression accidentelle échoue au lieu d'effacer l'historique.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('project_invitations', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.string('email', 254).notNullable()
      // La propriété ne s'obtient que par transfert à un membre existant.
      table.enum('role', ['editor', 'reviewer', 'viewer']).notNullable()
      table.string('token_hash', 64).notNullable().unique()
      table.uuid('invited_by').notNullable().references('id').inTable('users').onDelete('RESTRICT')
      table.timestamp('expires_at', { useTz: true }).notNullable()
      table.timestamp('accepted_at', { useTz: true }).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.check('email = lower(email)', [], 'project_invitations_email_lowercase')
      // Invitations en attente d'un compte qui vient de s'inscrire.
      table.index(['email'])
    })
    // Une seule invitation en attente par email et par projet : relancer la met à jour.
    this.schema.raw(
      `CREATE UNIQUE INDEX project_invitations_pending_unique ON project_invitations (project_id, email) WHERE accepted_at IS NULL`,
    )

    this.schema.createTable('share_links', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.enum('kind', ['view', 'edit']).notNullable()
      // Régénérer remplace le hash : l'ancien lien cesse aussitôt de fonctionner.
      table.string('token_hash', 64).notNullable().unique()
      table.boolean('enabled').notNullable().defaultTo(true)
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      // Un lien lecture seule et un lien d'édition au plus par projet.
      table.unique(['project_id', 'kind'])
    })
  }

  override async down() {
    this.schema.dropTable('share_links')
    this.schema.dropTable('project_invitations')
  }
}
