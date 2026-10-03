import type {
  IntegrationSyncStatus,
  ZoteroExportFormat,
  ZoteroLibraryType,
} from '@kaxolax/contracts'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'
import { encryptedColumn } from '#services/encrypted_column'

/**
 * Lien projet ↔ bibliothèque Zotero (tâche 9). Clé d'API OAuth du membre qui a lié (copie de
 * celle de son compte Zotero), chiffrée au repos, jamais sérialisée ; null une fois révoquée.
 */
export default class ZoteroLink extends UuidModel {
  static override table = 'zotero_links'

  @column()
  declare projectId: string

  @column()
  declare ownerId: string

  @column()
  declare zoteroUserId: string | null

  @column()
  declare libraryType: ZoteroLibraryType

  @column()
  declare libraryId: string

  @column()
  declare collectionKey: string | null

  /** Document `.bib` alimenté par la synchronisation. */
  @column()
  declare documentId: string | null

  @column({ ...encryptedColumn('zotero_links.api_key'), columnName: 'api_key_encrypted' })
  declare apiKey: string | null

  @column()
  declare syncStatus: IntegrationSyncStatus

  @column.dateTime()
  declare lastSyncedAt: DateTime | null

  @column({ consume: (value: string | number | null) => (value === null ? null : Number(value)) })
  declare lastLibraryVersion: number | null

  /** Code de la dernière erreur de synchronisation (`E_ZOTERO_…`), null après un succès. */
  @column()
  declare lastError: string | null

  @column()
  declare exportFormat: ZoteroExportFormat

  /** Noms affichés, relevés au moment du lien. */
  @column()
  declare libraryName: string | null

  @column()
  declare collectionName: string | null

  /** Éléments ajoutés hors de la collection par le sélecteur de citations (gardés par la synchro). */
  @column({ prepare: (value: string[]) => JSON.stringify(value) })
  declare pickedItemKeys: string[]

  /**
   * Collection liée et ses sous-collections (relevées au lien et à chaque synchro complète) :
   * ce que les autres éditeurs peuvent chercher et ajouter. Vide : toute la bibliothèque, ou la
   * collection liée seule tant qu'elles ne sont pas relevées.
   */
  @column({ prepare: (value: string[]) => JSON.stringify(value) })
  declare collectionScope: string[]

  /**
   * Clés de citation écrites dans le `.bib` (clé d'élément Zotero → clé de citation), attribuées
   * par Kaxolax : uniques dans le fichier et stables d'une synchro à l'autre.
   */
  @column({ prepare: (value: Record<string, string>) => JSON.stringify(value) })
  declare citationKeys: Record<string, string>

  /** Pause demandée par Zotero (`Backoff`, `Retry-After`) : aucune requête avant. */
  @column.dateTime()
  declare backoffUntil: DateTime | null

  /** Début de la synchronisation en cours (`syncStatus` = `syncing`). */
  @column.dateTime()
  declare syncStartedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
