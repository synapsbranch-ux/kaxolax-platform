import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Zotero (tâche 9) : clés de la collection liée et de ses sous-collections, relevées au lien et à
 * chaque synchronisation complète. Elles bornent ce que les autres éditeurs du projet peuvent
 * chercher et ajouter avec la clé du membre qui a lié. Colonne ajoutée avec une valeur par
 * défaut (vide : la collection liée seule, ou toute la bibliothèque) : aucune perte de données.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.alterTable('zotero_links', (table) => {
      table.jsonb('collection_scope').notNullable().defaultTo(this.raw(`'[]'::jsonb`))
    })
  }

  override async down() {
    this.schema.alterTable('zotero_links', (table) => {
      table.dropColumn('collection_scope')
    })
  }
}
