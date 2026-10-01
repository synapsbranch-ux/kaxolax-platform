import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

/**
 * Miroir local d'un compte Clerk (id interne, référencé par toutes les clés étrangères). Kaxolax ne
 * stocke ni mot de passe ni jeton d'authentification.
 */
export default class User extends UuidModel {
  /** Identifiant du compte Clerk (`user_…`). */
  @column()
  declare clerkUserId: string

  @column()
  declare email: string

  @column()
  declare fullName: string | null

  @column()
  declare avatarUrl: string | null

  /** Compte supprimé dans Clerk : la ligne est anonymisée et ne s'authentifie plus. */
  @column.dateTime()
  declare deletedAt: DateTime | null

  /** Compte banni : ses jetons de session sont refusés, même encore valides. */
  @column.dateTime()
  declare bannedAt: DateTime | null

  /** Date Clerk (`updated_at` du compte) de l'état de bannissement reflété. */
  @column.dateTime()
  declare banStateUpdatedAt: DateTime | null

  /**
   * Dernière révocation des sessions par l'admin : les jetons (Clerk et temps réel) émis avant
   * sont refusés, même encore valides.
   */
  @column.dateTime()
  declare sessionsRevokedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
