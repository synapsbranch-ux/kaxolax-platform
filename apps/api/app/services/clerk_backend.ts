import { type ClerkClient, createClerkClient } from '@clerk/backend'
import { isClerkAPIResponseError } from '@clerk/backend/errors'
import { Exception } from '@adonisjs/core/exceptions'
import logger from '@adonisjs/core/services/logger'
import { DateTime } from 'luxon'
import clerkConfig from '#config/clerk'

/** API Backend de Clerk non configurée (`CLERK_SECRET_KEY` absente). */
export class ClerkUnavailableException extends Exception {
  static override status = 503
  static override code = 'E_CLERK_UNAVAILABLE'
  static override message = 'The Clerk Backend API is not configured'
}

/** Clerk a refusé la demande ou n'a pas répondu. */
export class ClerkRequestFailedException extends Exception {
  static override status = 502
  static override code = 'E_CLERK_REQUEST_FAILED'
  static override message = 'The Clerk Backend API request failed'
}

/** Ce que l'API lit d'un compte dans Clerk. */
export interface ClerkAccount {
  clerkUserId: string
  /** `publicMetadata.role`, null s'il est absent. */
  role: string | null
  twoFactorEnabled: boolean
  banned: boolean
  lastSignInAt: DateTime | null
  lastActiveAt: DateTime | null
}

/** Organisation lue par l'API Backend (commande `clerk:sync-organizations`). */
export interface ClerkOrganizationSnapshot {
  id: string
  name: string
  slug: string | null
  createdBy: string | null
}

/** Adhésion lue par l'API Backend. */
export interface ClerkMembershipSnapshot {
  clerkUserId: string
  /** Rôle Clerk (`org:admin`, `org:member`…). */
  role: string
}

/** Élément d'abonnement d'organisation lu par l'API Backend, au format des webhooks Billing. */
export interface ClerkSubscriptionItemSnapshot {
  id: string
  status: string
  period_end: number | null
  plan: { slug: string; name: string; is_default: boolean } | null
}

/** Taille des pages de l'API Backend (maximum accepté par Clerk). */
const PAGE_SIZE = 100
/** Garde-fou : au plus 100 000 éléments par liste. */
const MAX_PAGES = 1000

/** Pages de sessions révoquées au plus par appel (100 sessions par page). */
const MAX_SESSION_PAGES = 10

let sharedClient: ClerkClient | undefined

function fromMillis(value: number | null): DateTime | null {
  return value === null ? null : DateTime.fromMillis(value, { zone: 'utc' })
}

/**
 * Appels à l'API Backend de Clerk (`CLERK_SECRET_KEY`) : état d'un compte, bannissement, sessions,
 * suppression, organisations et leurs adhésions et abonnements (rattrapage des équipes). Résolue par le conteneur AdonisJS ; les tests la remplacent par un faux
 * (`app.container.swap`), sans réseau.
 */
export default class ClerkBackend {
  protected client(): ClerkClient {
    const secretKey = clerkConfig.secretKey
    if (!secretKey) throw new ClerkUnavailableException()
    sharedClient ??= createClerkClient({
      secretKey: secretKey.release(),
      telemetry: { disabled: true },
    })
    return sharedClient
  }

  /** Erreur de Clerk traduite en 502, détail dans le journal (`clerkId` : compte ou organisation). */
  private failed(error: unknown, operation: string, clerkId: string): never {
    if (error instanceof ClerkUnavailableException) throw error
    logger.error({ err: error, operation, clerkId }, 'clerk backend request failed')
    throw new ClerkRequestFailedException()
  }

  /** Compte Clerk, ou null s'il n'existe pas (ou plus). */
  async getAccount(clerkUserId: string): Promise<ClerkAccount | null> {
    try {
      const user = await this.client().users.getUser(clerkUserId)
      const role: unknown = user.publicMetadata.role
      return {
        clerkUserId: user.id,
        role: typeof role === 'string' ? role : null,
        twoFactorEnabled: user.twoFactorEnabled,
        banned: user.banned,
        lastSignInAt: fromMillis(user.lastSignInAt),
        lastActiveAt: fromMillis(user.lastActiveAt),
      }
    } catch (error) {
      if (isClerkAPIResponseError(error) && error.status === 404) return null
      return this.failed(error, 'getUser', clerkUserId)
    }
  }

  /**
   * Bannit le compte : Clerk révoque toutes ses sessions et refuse ses connexions. Renvoie la date
   * de modification du compte chez Clerk, qui ordonne cet état face aux webhooks en retard.
   */
  async banUser(clerkUserId: string): Promise<DateTime> {
    try {
      const user = await this.client().users.banUser(clerkUserId)
      return DateTime.fromMillis(user.updatedAt, { zone: 'utc' })
    } catch (error) {
      return this.failed(error, 'banUser', clerkUserId)
    }
  }

  /** Lève le bannissement ; renvoie la date de modification du compte chez Clerk. */
  async unbanUser(clerkUserId: string): Promise<DateTime> {
    try {
      const user = await this.client().users.unbanUser(clerkUserId)
      return DateTime.fromMillis(user.updatedAt, { zone: 'utc' })
    } catch (error) {
      return this.failed(error, 'unbanUser', clerkUserId)
    }
  }

  /** Révoque toutes les sessions actives du compte ; renvoie leur nombre. */
  async revokeSessions(clerkUserId: string): Promise<number> {
    try {
      const sessions = this.client().sessions
      let revoked = 0
      for (let page = 0; page < MAX_SESSION_PAGES; page++) {
        // Une session révoquée quitte la liste des actives : on relit toujours la première page.
        const { data } = await sessions.getSessionList({
          userId: clerkUserId,
          status: 'active',
          limit: 100,
        })
        if (data.length === 0) break
        for (const session of data) await sessions.revokeSession(session.id)
        revoked += data.length
      }
      return revoked
    } catch (error) {
      return this.failed(error, 'revokeSessions', clerkUserId)
    }
  }

  /** Toutes les organisations de l'instance. */
  async listOrganizations(): Promise<ClerkOrganizationSnapshot[]> {
    try {
      const organizations: ClerkOrganizationSnapshot[] = []
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data } = await this.client().organizations.getOrganizationList({
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          orderBy: '+created_at',
        })
        for (const organization of data) {
          organizations.push({
            id: organization.id,
            name: organization.name,
            slug: organization.slug,
            createdBy: organization.createdBy ?? null,
          })
        }
        if (data.length < PAGE_SIZE) break
      }
      return organizations
    } catch (error) {
      return this.failed(error, 'getOrganizationList', '')
    }
  }

  /** Une organisation ; null si elle n'existe pas (ou plus) chez Clerk. */
  async getOrganization(organizationId: string): Promise<ClerkOrganizationSnapshot | null> {
    try {
      const organization = await this.client().organizations.getOrganization({ organizationId })
      return {
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        createdBy: organization.createdBy ?? null,
      }
    } catch (error) {
      if (isClerkAPIResponseError(error) && error.status === 404) return null
      return this.failed(error, 'getOrganization', organizationId)
    }
  }

  /** Adhésions d'une organisation. */
  async listOrganizationMemberships(organizationId: string): Promise<ClerkMembershipSnapshot[]> {
    try {
      const memberships: ClerkMembershipSnapshot[] = []
      for (let page = 0; page < MAX_PAGES; page++) {
        const { data } = await this.client().organizations.getOrganizationMembershipList({
          organizationId,
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
        })
        for (const membership of data) {
          const userId = membership.publicUserData?.userId
          if (userId) memberships.push({ clerkUserId: userId, role: membership.role })
        }
        if (data.length < PAGE_SIZE) break
      }
      return memberships
    } catch (error) {
      return this.failed(error, 'getOrganizationMembershipList', organizationId)
    }
  }

  /**
   * Éléments de l'abonnement Billing d'une organisation ; null si elle n'en a pas (Billing
   * désactivé, 404).
   */
  async organizationSubscriptionItems(
    organizationId: string,
  ): Promise<ClerkSubscriptionItemSnapshot[] | null> {
    try {
      const subscription =
        await this.client().billing.getOrganizationBillingSubscription(organizationId)
      return subscription.subscriptionItems.map((item) => ({
        id: item.id,
        status: item.status,
        period_end: item.periodEnd,
        plan: item.plan
          ? { slug: item.plan.slug, name: item.plan.name, is_default: item.plan.isDefault }
          : null,
      }))
    } catch (error) {
      if (isClerkAPIResponseError(error) && error.status === 404) return null
      return this.failed(error, 'getOrganizationBillingSubscription', organizationId)
    }
  }

  /** Supprime le compte dans Clerk ; faux s'il n'existait déjà plus. */
  async deleteUser(clerkUserId: string): Promise<boolean> {
    try {
      await this.client().users.deleteUser(clerkUserId)
      return true
    } catch (error) {
      if (isClerkAPIResponseError(error) && error.status === 404) return false
      return this.failed(error, 'deleteUser', clerkUserId)
    }
  }
}
