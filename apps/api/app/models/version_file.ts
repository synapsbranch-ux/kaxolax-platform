import { column } from '@adonisjs/lucid/orm'
import UuidModel from '#models/uuid_model'

/**
 * Binaire référencé par une version : son objet S3 est conservé tant qu'une ligne existe. Clé de
 * substitution `id`, comme ProjectMember ; le couple (versionId, fileId) est unique.
 */
export default class VersionFile extends UuidModel {
  static override table = 'version_files'

  @column()
  declare versionId: string

  /** Pas de clé étrangère : le fichier a pu quitter l'arborescence depuis. */
  @column()
  declare fileId: string

  @column({ columnName: 'sha256' })
  declare sha256: string
}
