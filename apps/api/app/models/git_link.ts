import type { GitProvider, IntegrationSyncStatus } from '@kaxolax/contracts'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'
import { encryptedColumn } from '#services/encrypted_column'

/**
 * Lien projet ↔ dépôt Git (tâche 8). Jetons OAuth chiffrés au repos : l'instance les porte en
 * clair, la base ne voit que leur forme chiffrée (`*_encrypted`). Jamais sérialisés.
 */
export default class GitLink extends UuidModel {
  static override table = 'git_links'

  @column()
  declare projectId: string

  /** Membre qui a créé le lien (ses jetons servent à la synchronisation). */
  @column()
  declare ownerId: string

  @column()
  declare provider: GitProvider

  @column()
  declare repositoryOwner: string

  @column()
  declare repositoryName: string

  @column()
  declare branch: string

  @column({ consume: (value: string | number | null) => (value === null ? null : Number(value)) })
  declare installationId: number | null

  @column({ ...encryptedColumn('git_links.access_token'), columnName: 'access_token_encrypted' })
  declare accessToken: string | null

  @column({ ...encryptedColumn('git_links.refresh_token'), columnName: 'refresh_token_encrypted' })
  declare refreshToken: string | null

  @column.dateTime()
  declare tokenExpiresAt: DateTime | null

  @column()
  declare syncStatus: IntegrationSyncStatus

  @column.dateTime()
  declare lastSyncedAt: DateTime | null

  @column()
  declare lastSyncedCommit: string | null

  @column()
  declare lastError: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
