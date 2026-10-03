import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Workspaces d'équipe (tâche 10) : miroir des Organisations Clerk et de leurs adhésions, tenu par
 * les webhooks `organization.*` et `organizationMembership.*` (et la commande de rattrapage
 * `clerk:sync-organizations`). Le miroir garde l'état Clerk tel quel, même quand le compte ou le
 * workspace local n'existe pas encore (événements désordonnés) ; les workspaces d'équipe et
 * `workspace_members` en sont dérivés (#services/team_sync). `event_at` : date Clerk du dernier
 * état appliqué (un événement plus ancien ne l'écrase pas) ; `deleted_at` : pierre tombale (une
 * adhésion peut renaître, une organisation supprimée jamais : Clerk ne réutilise pas ses
 * identifiants).
 *
 * `projects.team_role` : rôle des membres `member` de l'équipe sur un projet du workspace
 * (réglable par projet), `editor` par défaut. Nouvelles tables et colonne à valeur par défaut
 * constante : aucune donnée existante ne change.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('clerk_organizations', (table) => {
      table.string('clerk_organization_id', 64).primary()
      table.string('name', 255).notNullable()
      table.string('slug', 255).nullable()
      // Créateur dans Clerk (`created_by`), premier responsable pressenti du workspace.
      table.string('created_by_clerk_user_id', 64).nullable()
      table.timestamp('deleted_at', { useTz: true }).nullable()
      table.timestamp('event_at', { useTz: true }).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
    })

    this.schema.createTable('clerk_organization_memberships', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      // Pas de clé étrangère : une adhésion peut arriver avant son organisation.
      table.string('clerk_organization_id', 64).notNullable()
      table.string('clerk_user_id', 64).notNullable()
      // Rôle Clerk tel quel (`org:admin`, `org:member`, rôle personnalisé).
      table.string('role', 64).notNullable()
      table.timestamp('deleted_at', { useTz: true }).nullable()
      table.timestamp('event_at', { useTz: true }).notNullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      // Arbitre aussi les livraisons simultanées (INSERT … ON CONFLICT).
      table.unique(['clerk_organization_id', 'clerk_user_id'])
      // Rattachement d'un compte qui arrive après ses adhésions (user.created).
      table.index(['clerk_user_id'])
    })

    this.schema.alterTable('projects', (table) => {
      table.enum('team_role', ['editor', 'reviewer', 'viewer']).notNullable().defaultTo('editor')
    })
  }

  override async down() {
    this.schema.alterTable('projects', (table) => {
      table.dropColumn('team_role')
    })
    this.schema.dropTable('clerk_organization_memberships')
    this.schema.dropTable('clerk_organizations')
  }
}
