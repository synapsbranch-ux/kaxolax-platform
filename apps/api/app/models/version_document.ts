import { column } from '@adonisjs/lucid/orm'
import UuidModel from '#models/uuid_model'

/**
 * Texte d'un document cité par une version (présent, ou montré supprimé : son dernier texte) :
 * compressé dans le stockage objet sous son sha256, conservé tant qu'une ligne y fait référence.
 * Clé de substitution `id`, comme VersionFile.
 */
export default class VersionDocument extends UuidModel {
  static override table = 'version_documents'

  @column()
  declare versionId: string

  /** Pas de clé étrangère : le document a pu être supprimé depuis. */
  @column()
  declare documentId: string

  @column({ columnName: 'sha256' })
  declare sha256: string
}
