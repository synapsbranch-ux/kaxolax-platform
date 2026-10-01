import { withAuthFinder } from '@adonisjs/auth/mixins/lucid'
import { compose } from '@adonisjs/core/helpers'
import hash from '@adonisjs/core/services/hash'
import { column } from '@adonisjs/lucid/orm'
import { type DateTime } from 'luxon'
import UuidModel from '#models/uuid_model'

const AuthFinder = withAuthFinder(() => hash.use('scrypt'), {
  uids: ['email'],
  passwordColumnName: 'passwordHash',
})

export default class User extends compose(UuidModel, AuthFinder) {
  @column()
  declare email: string

  /**
   * Mot de passe haché (scrypt) par le mixin à l'enregistrement. Nul pour un compte créé par
   * Clerk : la connexion par session lui est alors refusée.
   */
  @column({ serializeAs: null })
  declare passwordHash: string | null

  /** Identifiant du compte Clerk (`user_…`) ; nul tant qu'un compte de l'étape 1 n'est pas migré. */
  @column()
  declare clerkUserId: string | null

  @column()
  declare avatarUrl: string | null

  /** Compte supprimé dans Clerk : la ligne est anonymisée et ne s'authentifie plus. */
  @column.dateTime()
  declare deletedAt: DateTime | null

  @column()
  declare fullName: string | null

  @column.dateTime()
  declare emailVerifiedAt: DateTime | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  /** Un compte sans mot de passe (créé par Clerk) échoue proprement, sans erreur 500. */
  override async verifyPassword(plainPassword: string): Promise<boolean> {
    if (this.passwordHash === null) return false
    return super.verifyPassword(plainPassword)
  }
}
