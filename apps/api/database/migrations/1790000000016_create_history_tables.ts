import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Historique : une version par pause d'édition, compilation manuelle ou restauration. Le texte
 * compressé est dans S3 (`s3_prefix`) ; la base garde les métadonnées et les binaires référencés.
 */
export default class extends BaseSchema {
  override async up() {
    this.schema.createTable('project_versions', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('project_id')
        .notNullable()
        .references('id')
        .inTable('projects')
        .onDelete('CASCADE')
      table.enum('kind', ['auto', 'compile', 'restore']).notNullable()
      // Tableaux sans clé étrangère possible : les comptes sont anonymisés, jamais supprimés, et un
      // document supprimé depuis reste nommé par la version.
      table.specificType('author_ids', 'uuid[]').notNullable().defaultTo(this.raw(`'{}'`))
      table.specificType('changed_document_ids', 'uuid[]').notNullable().defaultTo(this.raw(`'{}'`))
      table.string('s3_prefix', 1024).notNullable()
      // Une version avec label n'est jamais purgée.
      table.string('label', 255).nullable()
      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.index(['project_id', 'created_at'])
    })

    // Clé de substitution : Lucid ne gère qu'une colonne de clé primaire (voir ProjectMember).
    this.schema.createTable('version_files', (table) => {
      table.uuid('id').primary().defaultTo(this.raw('gen_random_uuid()'))
      table
        .uuid('version_id')
        .notNullable()
        .references('id')
        .inTable('project_versions')
        .onDelete('CASCADE')
      // Pas de clé étrangère vers files : le fichier peut quitter l'arborescence, la version garde
      // sa référence (et l'objet S3 reste conservé tant qu'une version y fait référence).
      table.uuid('file_id').notNullable()
      table.string('sha256', 64).notNullable()
      table.unique(['version_id', 'file_id'])
      // « Cet objet est-il encore référencé ? » avant de supprimer un binaire.
      table.index(['sha256'])
    })
  }

  override async down() {
    this.schema.dropTable('version_files')
    this.schema.dropTable('project_versions')
  }
}
