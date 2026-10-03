import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Emails de mention de commentaire (tâche 10) : la date du dernier envoi à chaque personne sur
 * chaque projet quitte `project_members` pour une table à part, clé (projet, compte). Un membre
 * d'équipe qui accède au projet par son workspace (vue `project_access_roles`) n'a pas de ligne
 * `project_members` mais doit pouvoir être prévenu, au plus une fois par intervalle, comme un
 * invité. Les dates existantes sont recopiées avant la suppression de l'ancienne colonne.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('comment_mention_emails', (table) => {
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.uuid('user_id').notNullable().references('id').inTable('users').onDelete('CASCADE')
      table.timestamp('emailed_at', { useTz: true }).notNullable()
      table.primary(['project_id', 'user_id'])
    })
    this.schema.raw(`
      INSERT INTO comment_mention_emails (project_id, user_id, emailed_at)
      SELECT project_id, user_id, comment_mention_emailed_at
        FROM project_members
       WHERE comment_mention_emailed_at IS NOT NULL
    `)
    this.schema.alterTable('project_members', (table) => {
      table.dropColumn('comment_mention_emailed_at')
    })
  }

  override async down() {
    this.schema.alterTable('project_members', (table) => {
      table.timestamp('comment_mention_emailed_at', { useTz: true }).nullable()
    })
    // Seules les personnes qui ont une ligne `project_members` retrouvent leur date ; celle d'un
    // membre d'équipe (simple limite d'envoi, sans autre valeur) disparaît avec la table.
    this.schema.raw(`
      UPDATE project_members m
         SET comment_mention_emailed_at = e.emailed_at
        FROM comment_mention_emails e
       WHERE e.project_id = m.project_id AND e.user_id = m.user_id
    `)
    this.schema.dropTable('comment_mention_emails')
  }
}
