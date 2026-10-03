import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Zotero (tâche 9) : clés de citation attribuées par Kaxolax à chaque élément écrit dans le `.bib`
 * lié (objet `{ clé d'élément Zotero: clé de citation }`), pour garder des clés uniques et
 * stables quand Zotero en produit deux identiques ; pause demandée par Zotero (`Backoff`,
 * `Retry-After`) enregistrée aussi sur le compte connecté, pour les appels faits avant tout lien
 * (bibliothèques, collections, création du lien). Colonnes ajoutées avec des valeurs par défaut :
 * aucune perte de données.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.alterTable('zotero_links', (table) => {
      table.jsonb('citation_keys').notNullable().defaultTo(this.raw(`'{}'::jsonb`))
    })
    this.schema.alterTable('zotero_accounts', (table) => {
      table.timestamp('backoff_until', { useTz: true }).nullable()
    })
  }

  override async down() {
    this.schema.alterTable('zotero_accounts', (table) => {
      table.dropColumn('backoff_until')
    })
    this.schema.alterTable('zotero_links', (table) => {
      table.dropColumn('citation_keys')
    })
  }
}
