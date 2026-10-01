import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

export type BannerLevel = 'info' | 'warning' | 'maintenance'

/** Bannière affichée en haut de l'application entre `startsAt` et `endsAt`. */
export default class SystemBanner extends UuidModel {
  @column()
  declare message: string

  @column()
  declare level: BannerLevel

  @column.dateTime()
  declare startsAt: DateTime

  /** Null : affichée jusqu'à ce qu'un admin la termine. */
  @column.dateTime()
  declare endsAt: DateTime | null

  @column()
  declare createdBy: string

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime
}
