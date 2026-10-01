import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import hash from '@adonisjs/core/services/hash'
import clerkConfig from '#config/clerk'
import {
  clerkAdminApi,
  importUsers,
  PASSWORD_FORMATS,
  type PasswordFormat,
  probePasswordFormat,
} from '#services/clerk_import'

/**
 * Importe dans Clerk les comptes de l'étape 1 (idempotent, rejouable). Les mots de passe ne sont
 * repris que si `--probe-hash` a montré que Clerk accepte les hash d'AdonisJS ; sinon chaque compte
 * est créé sans mot de passe et le choisit à la première connexion (« Mot de passe oublié »).
 */
export default class ClerkImportUsers extends BaseCommand {
  static override commandName = 'clerk:import-users'
  static override description = 'Import stage 1 accounts into Clerk and link them (idempotent)'
  static override options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Show what would be created or linked, change nothing' })
  declare dryRun: boolean

  @flags.boolean({ description: 'Only test whether Clerk accepts AdonisJS scrypt hashes' })
  declare probeHash: boolean

  @flags.string({
    description: `Import password hashes in this format (${PASSWORD_FORMATS.join(', ')})`,
  })
  declare passwordFormat: string | undefined

  @flags.number({
    description: 'Pause between accounts, in ms (Backend API rate limit)',
    default: 120,
  })
  declare pauseMs: number

  override async run() {
    const secretKey = clerkConfig.secretKey?.release()
    if (!secretKey) {
      this.logger.error('CLERK_SECRET_KEY is not set')
      this.exitCode = 1
      return
    }
    const api = clerkAdminApi(secretKey)

    if (this.probeHash) {
      const format = await probePasswordFormat(api, (password) => hash.use('scrypt').make(password))
      if (format) this.logger.success(`Clerk accepts AdonisJS hashes as "${format}"`)
      else
        this.logger.warning(
          'Clerk does not accept AdonisJS hashes: users will reset their password',
        )
      return
    }

    const passwordFormat = this.passwordFormat as PasswordFormat | undefined
    if (passwordFormat !== undefined && !PASSWORD_FORMATS.includes(passwordFormat)) {
      this.logger.error(`Unknown password format "${passwordFormat}"`)
      this.exitCode = 1
      return
    }

    const report = await importUsers(api, {
      dryRun: this.dryRun,
      passwordFormat,
      pauseMs: this.pauseMs,
    })
    const verb = this.dryRun ? 'would be' : 'were'
    this.logger.info(`${String(report.created.length)} accounts ${verb} created in Clerk`)
    this.logger.info(`${String(report.linked.length)} accounts ${verb} linked to an existing one`)
    for (const failure of report.failed) this.logger.error(`${failure.email}: ${failure.error}`)
    if (report.failed.length > 0) this.exitCode = 1
  }
}
