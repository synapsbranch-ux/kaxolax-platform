import { BaseSchema } from '@adonisjs/lucid/schema'

const KINDS = ['auto', 'compile', 'restore']

const inList = (values: string[]) => values.map((value) => `'${value}'`).join(', ')

/**
 * Historique : nouveau type de version `restored`, l'état du projet juste après une restauration
 * (`restore` reste la sauvegarde créée juste avant). Aucune donnée existante ne change.
 */
export default class extends BaseSchema {
  protected tableName = 'project_versions'

  override async up() {
    this.schema.raw('ALTER TABLE project_versions DROP CONSTRAINT project_versions_kind_check')
    this.schema.raw(
      `ALTER TABLE project_versions ADD CONSTRAINT project_versions_kind_check CHECK (kind IN (${inList([...KINDS, 'restored'])}))`,
    )
  }

  override async down() {
    // Sans perte de ligne : une version après restauration redevient une version automatique.
    this.schema.raw(`UPDATE project_versions SET kind = 'auto' WHERE kind = 'restored'`)
    this.schema.raw('ALTER TABLE project_versions DROP CONSTRAINT project_versions_kind_check')
    this.schema.raw(
      `ALTER TABLE project_versions ADD CONSTRAINT project_versions_kind_check CHECK (kind IN (${inList(KINDS)}))`,
    )
  }
}
