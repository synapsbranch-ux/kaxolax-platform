import { ADMIN_ROLE, type ProjectEvent } from '@kaxolax/contracts'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import type { Group } from '@japa/runner/core'
import { DateTime } from 'luxon'
import type User from '#models/user'
import { forgetAdminStatus } from '#services/admin_access'
import ClerkBackend, {
  type ClerkAccount,
  ClerkRequestFailedException,
} from '#services/clerk_backend'
import RealtimeClient from '#services/realtime_client'
import { clerkTokenFor } from '#tests/clerk'
import { createUser, uniqueEmail } from '#tests/helpers'

/** API Backend de Clerk simulée : comptes en mémoire, appels enregistrés, pannes à la demande. */
export class FakeClerkBackend extends ClerkBackend {
  readonly accounts = new Map<string, ClerkAccount>()
  readonly calls: string[] = []
  /** Opérations qui échouent comme si Clerk répondait en erreur (502). */
  readonly failing = new Set<string>()
  activeSessions = 2

  /** Ajoute (ou remplace) l'état Clerk d'un compte. */
  account(user: User, state: Partial<ClerkAccount> = {}): void {
    this.accounts.set(user.clerkUserId, {
      clerkUserId: user.clerkUserId,
      role: null,
      twoFactorEnabled: false,
      banned: false,
      lastSignInAt: null,
      lastActiveAt: null,
      ...state,
    })
  }

  private record(operation: string, clerkUserId: string): void {
    this.calls.push(`${operation}:${clerkUserId}`)
    if (this.failing.has(operation)) throw new ClerkRequestFailedException()
  }

  private setBanned(clerkUserId: string, banned: boolean): DateTime {
    const account = this.accounts.get(clerkUserId)
    if (account) this.accounts.set(clerkUserId, { ...account, banned })
    return DateTime.utc()
  }

  override getAccount(clerkUserId: string): Promise<ClerkAccount | null> {
    this.record('getUser', clerkUserId)
    return Promise.resolve(this.accounts.get(clerkUserId) ?? null)
  }

  override banUser(clerkUserId: string): Promise<DateTime> {
    this.record('banUser', clerkUserId)
    return Promise.resolve(this.setBanned(clerkUserId, true))
  }

  override unbanUser(clerkUserId: string): Promise<DateTime> {
    this.record('unbanUser', clerkUserId)
    return Promise.resolve(this.setBanned(clerkUserId, false))
  }

  override revokeSessions(clerkUserId: string): Promise<number> {
    this.record('revokeSessions', clerkUserId)
    const revoked = this.activeSessions
    this.activeSessions = 0
    return Promise.resolve(revoked)
  }

  override deleteUser(clerkUserId: string): Promise<boolean> {
    this.record('deleteUser', clerkUserId)
    return Promise.resolve(this.accounts.delete(clerkUserId))
  }
}

/**
 * Service temps réel simulé : déconnexions, fermetures, changements de membres, événements du
 * projet et de bannière enregistrés.
 */
export class FakeRealtimeClient extends RealtimeClient {
  readonly disconnected: string[] = []
  readonly closed: string[] = []
  readonly bannerNotifications: number[] = []
  /** Changements de membres notifiés (`projet:utilisateur`). */
  readonly memberChanges: string[] = []
  /** Événements publiés sur le document meta des projets. */
  readonly events: { projectId: string; event: ProjectEvent }[] = []
  /** Service injoignable : `disconnectUser` renvoie null, comme le vrai client en cas d'échec. */
  unreachable = false

  override disconnectUser(userId: string): Promise<number | null> {
    this.disconnected.push(userId)
    return Promise.resolve(this.unreachable ? null : 1)
  }

  override closeDocuments(documentIds: readonly string[]): Promise<void> {
    this.closed.push(...documentIds)
    return Promise.resolve()
  }

  override membersChanged(projectId: string, userIds: readonly string[]): Promise<void> {
    for (const userId of userIds) this.memberChanges.push(`${projectId}:${userId}`)
    return Promise.resolve()
  }

  override publishProjectEvent(projectId: string, event: ProjectEvent): Promise<void> {
    this.events.push({ projectId, event })
    return Promise.resolve()
  }

  override notifyBannerChanged(active: readonly unknown[]): Promise<void> {
    this.bannerNotifications.push(active.length)
    return Promise.resolve()
  }
}

/** Jeton de session d'un admin : rôle dans le claim `metadata`, second facteur vérifié (`fva`). */
export function adminTokenFor(user: User, overrides: Record<string, unknown> = {}): string {
  return clerkTokenFor(user, { metadata: { role: ADMIN_ROLE }, fva: [3, 3], ...overrides })
}

/** Admin complet : jeton admin et compte Clerk admin avec MFA activée. */
export async function createAdmin(
  clerk: FakeClerkBackend,
): Promise<{ admin: User; token: string }> {
  const admin = await createUser({ email: uniqueEmail('admin') })
  clerk.account(admin, { role: ADMIN_ROLE, twoFactorEnabled: true })
  return { admin, token: adminTokenFor(admin) }
}

/** Faux services de l'admin, recréés avant chaque test par `useAdminFakes`. */
export const adminFakes = {
  clerk: new FakeClerkBackend(),
  realtime: new FakeRealtimeClient(),
}

/**
 * Chaque test du groupe : transaction globale annulée à la fin, faux Clerk et faux service temps
 * réel injectés par le conteneur, cache des admins vidé.
 */
export function useAdminFakes(group: Group): void {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    adminFakes.clerk = new FakeClerkBackend()
    adminFakes.realtime = new FakeRealtimeClient()
    forgetAdminStatus()
    app.container.swap(ClerkBackend, () => adminFakes.clerk)
    app.container.swap(RealtimeClient, () => adminFakes.realtime)
    return () => {
      app.container.restore(ClerkBackend)
      app.container.restore(RealtimeClient)
    }
  })
}
