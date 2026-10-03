import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import ClerkBackend from '#services/clerk_backend'
import ObjectStorage, { CompileOutputStorage } from '#services/object_storage'
import RealtimeClient from '#services/realtime_client'
import { syncOrganizationsFromClerk } from '#services/team_catchup'
import { applyTeamEffects } from '#services/team_sync'

/**
 * Rattrape les workspaces d'équipe depuis l'API Backend de Clerk (organisations, adhésions,
 * abonnements d'organisation) : webhooks perdus, première mise en service. Idempotent.
 */
export default class ClerkSyncOrganizations extends BaseCommand {
  static override commandName = 'clerk:sync-organizations'
  static override description =
    'Mirror Clerk organizations, memberships and organization subscriptions (idempotent)'
  static override options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Read Clerk and report, change nothing' })
  declare dryRun: boolean

  @flags.boolean({
    description: 'Also delete local organizations that no longer exist in Clerk',
  })
  declare prune: boolean

  override async run() {
    const clerk = await this.app.container.make(ClerkBackend)
    const report = await syncOrganizationsFromClerk(clerk, {
      dryRun: this.dryRun,
      prune: this.prune,
    })
    if (!this.dryRun) {
      // Projets supprimés (équipes dissoutes avec `--prune`) libérés, accès relus.
      await applyTeamEffects(
        {
          realtime: await this.app.container.make(RealtimeClient),
          storage: await this.app.container.make(ObjectStorage),
          outputs: await this.app.container.make(CompileOutputStorage),
        },
        report.effects,
      )
    }
    const verb = this.dryRun ? 'read' : 'synchronized'
    this.logger.info(
      `${String(report.organizations)} organizations ${verb} (${String(report.memberships)} memberships, ${String(report.subscriptionItems)} subscription items)`,
    )
    if (report.missing.length > 0) {
      const action = report.pruned ? 'deleted locally' : 'missing from Clerk (use --prune)'
      this.logger.warning(`${String(report.missing.length)} organizations ${action}`)
    }
    for (const failure of report.failed) {
      this.logger.error(`${failure.organizationId}: ${failure.error}`)
    }
    if (report.failed.length > 0) this.exitCode = 1
  }
}
