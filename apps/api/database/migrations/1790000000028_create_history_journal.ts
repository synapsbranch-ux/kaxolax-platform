import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Historique (tâche 8) : journal des mises à jour Yjs avec leur auteur (écrit par le service temps
 * réel), textes des versions adressés par sha256 (table version_documents, comme version_files
 * pour les binaires) et repère des versions automatiques sur projects.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('document_updates', (table) => {
      // Ordre d'arrivée dans le journal (ordre du rejeu d'une fenêtre).
      table.bigIncrements('id')
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table
        .uuid('document_id')
        .notNullable()
        .references('id')
        .inTable('documents')
        .onDelete('CASCADE')
      // Nul : origine inconnue (rattrapage depuis l'état enregistré, base compactée).
      table.uuid('user_id').nullable().references('id').inTable('users').onDelete('SET NULL')
      table.binary('yjs_update').notNullable()
      // Version qui a intégré la mise à jour ; nul : pas encore versionnée. Sans clé étrangère :
      // la base compactée d'un document reste quand sa version est purgée.
      table.uuid('version_id').nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['document_id', 'id'])
    })
    // Mises à jour pas encore versionnées : balayage des versions automatiques.
    this.schema.raw(
      'CREATE INDEX document_updates_pending_index ON document_updates (project_id, created_at) WHERE version_id IS NULL',
    )

    // Clé de substitution, comme version_files ; le couple (versionId, documentId) est unique.
    this.schema.createTable('version_documents', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('version_id')
        .notNullable()
        .references('id')
        .inTable('project_versions')
        .onDelete('CASCADE')
      // Pas de clé étrangère : le document a pu être supprimé depuis.
      table.uuid('document_id').notNullable()
      // Texte compressé dans le stockage objet, sous ce sha256 (conservé tant qu'il est référencé).
      table.string('sha256', 64).notNullable()
      table.unique(['version_id', 'document_id'])
      table.index(['sha256'])
    })

    this.schema.alterTable('projects', (table) => {
      // Valeur de updated_at couverte par la dernière version (ou vérification sans changement).
      table.timestamp('history_synced_at', { useTz: true }).nullable()
      // Échec de la dernière version automatique : pas de nouvel essai avant cette date (un projet
      // en échec ne bloque pas le balayage des autres).
      table.timestamp('history_retry_at', { useTz: true }).nullable()
    })
    // Projets existants : pas de version automatique tant que rien ne change.
    this.defer(async (db) => {
      await db.rawQuery('UPDATE projects SET history_synced_at = updated_at')
    })
  }

  override async down() {
    this.schema.alterTable('projects', (table) => {
      table.dropColumn('history_synced_at')
      table.dropColumn('history_retry_at')
    })
    this.schema.dropTable('version_documents')
    this.schema.dropTable('document_updates')
  }
}
