import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

export type ShareLinkKind = 'view' | 'edit'

/** Lien de partage d'un projet (un par type) ; régénérer remplace le hash du jeton. */
export default class ShareLink extends UuidModel {
  @column()
  declare projectId: string

  @column()
  declare kind: ShareLinkKind

  @column({ serializeAs: null })
  declare tokenHash: string

  @column()
  declare enabled: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
