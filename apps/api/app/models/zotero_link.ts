import type { IntegrationSyncStatus, ZoteroLibraryType } from '@kaxolax/contracts'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'
import { encryptedColumn } from '#services/encrypted_column'

/**
 * Lien projet ↔ bibliothèque Zotero (tâche 9). Clé d'API OAuth chiffrée au repos, jamais
 * sérialisée.
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

  @column()
  declare lastError: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
