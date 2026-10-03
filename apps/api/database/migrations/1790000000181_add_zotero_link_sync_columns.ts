import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Synchronisation Zotero (tâche 9) : format d'export, noms affichés de la bibliothèque et de la
 * collection, éléments ajoutés hors collection par le sélecteur de citations (gardés par la
 * synchro), pause demandée par Zotero (`Backoff`, `Retry-After`) et début de la synchro en cours
 * (une synchro abandonnée depuis plus de 5 minutes peut être reprise). Colonnes ajoutées avec
 * des valeurs par défaut : aucune perte de données.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.alterTable('zotero_links', (table) => {
      table.string('export_format', 16).notNullable().defaultTo('biblatex')
      table.string('library_name', 255).nullable()
      table.string('collection_name', 255).nullable()
      table.jsonb('picked_item_keys').notNullable().defaultTo(this.raw(`'[]'::jsonb`))
      table.timestamp('backoff_until', { useTz: true }).nullable()
      table.timestamp('sync_started_at', { useTz: true }).nullable()
      table.check(`export_format IN ('biblatex', 'bibtex')`, [], 'zotero_links_export_format')
    })
  }

  override async down() {
    this.schema.alterTable('zotero_links', (table) => {
      table.dropChecks(['zotero_links_export_format'])
      table.dropColumns(
        'export_format',
        'library_name',
        'collection_name',
        'picked_item_keys',
        'backoff_until',
        'sync_started_at',
      )
    })
  }
}
