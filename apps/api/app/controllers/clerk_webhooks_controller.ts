import { verifyWebhook } from '@clerk/backend/webhooks'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import clerkConfig from '#config/clerk'
import User from '#models/user'
import {
  applyBillingEvent,
  deliverBillingMails,
  isBillingEvent,
  queueBillingMails,
} from '#services/billing_webhooks'
import {
  applyBanState,
  banStateFromWebhook,
  deleteClerkUser,
  profileFromWebhook,
  upsertClerkUser,
} from '#services/clerk_users'
import ObjectStorage from '#services/object_storage'
import { type DeletedProject, releaseDeletedProject } from '#services/project_service'
import RealtimeClient from '#services/realtime_client'

const SIGNATURE_HEADERS = ['svix-id', 'svix-timestamp', 'svix-signature'] as const

/** Effets à appliquer hors de la base, une fois la transaction du webhook validée. */
interface WebhookEffects {
  deleted: DeletedProject[]
  /** Utilisateur local dont il faut fermer les connexions temps réel (banni, supprimé). */
  disconnectUserId: string | null
}

const NO_EFFECTS: WebhookEffects = { deleted: [], disconnectUserId: null }

/**
 * Webhooks Clerk (user.created, user.updated, user.deleted, et Billing : subscription.*,
 * subscriptionItem.*) : signature vérifiée sur le corps brut, chaque événement traité une seule
 * fois (table clerk_webhook_events, même transaction). Le champ `banned` est reflété dans
 * `users.banned_at` ; un compte banni ou supprimé perd aussitôt ses connexions temps réel. Les
 * abonnements sont reflétés dans `subscriptions` (#services/billing_webhooks) ; leurs emails sont
 * inscrits dans `billing_mails` par la même transaction, puis envoyés après validation. Tant qu'un
 * email de l'événement n'est pas parti, la réponse est 503 : Clerk relivre l'événement, et la
 * relivraison (déjà traitée) ne fait que renvoyer les emails en attente.
 */
@inject()
export default class ClerkWebhooksController {
  constructor(
    private readonly realtime: RealtimeClient,
    private readonly storage: ObjectStorage,
  ) {}

  async handle({ request, response }: HttpContext) {
    const secret = clerkConfig.webhookSigningSecret
    if (!secret) {
      logger.error('CLERK_WEBHOOK_SIGNING_SECRET is not configured')
      response.serviceUnavailable({ code: 'E_WEBHOOKS_DISABLED' })
      return
    }

    const headers = new Headers({ 'content-type': 'application/json' })
    for (const name of SIGNATURE_HEADERS) headers.set(name, request.header(name) ?? '')
    let event: Awaited<ReturnType<typeof verifyWebhook>>
    try {
      event = await verifyWebhook(
        new Request('http://webhook.invalid/', {
          method: 'POST',
          headers,
          body: request.raw() ?? '',
        }),
        { signingSecret: secret.release() },
      )
    } catch (error) {
      logger.warn({ err: error }, 'clerk webhook refused')
      response.badRequest({ code: 'E_INVALID_WEBHOOK', message: 'Invalid signature' })
      return
    }

    const eventId = String(request.header('svix-id'))
    const effects = await db.transaction(async (trx): Promise<WebhookEffects> => {
      const inserted: unknown[] = await trx
        .insertQuery()
        .table('clerk_webhook_events')
        .insert({ id: eventId, type: event.type })
        .onConflict('id')
        .ignore()
        .returning('id')
      if (inserted.length === 0) return NO_EFFECTS // déjà traité

      if (event.type === 'user.created' || event.type === 'user.updated') {
        const profile = profileFromWebhook(event.data)
        // Sans email principal vérifié, le compte attend : rien à refléter pour l'instant.
        if (!profile) return NO_EFFECTS
        const user = await upsertClerkUser(profile, trx)
        const banState = banStateFromWebhook(event.data)
        const banned = banState !== null && (await applyBanState(user, banState, trx))
        return { ...NO_EFFECTS, disconnectUserId: banned ? user.id : null }
      }
      if (event.type === 'user.deleted' && typeof event.data.id === 'string') {
        const user = await User.query({ client: trx }).where('clerkUserId', event.data.id).first()
        const deleted = await deleteClerkUser(event.data.id, trx)
        return {
          ...NO_EFFECTS,
          deleted,
          disconnectUserId: user?.deletedAt === null ? user.id : null,
        }
      }
      if (isBillingEvent(event.type)) {
        await queueBillingMails(eventId, await applyBillingEvent(event, trx), trx)
      }
      return NO_EFFECTS
    })

    for (const project of effects.deleted) {
      await releaseDeletedProject(project, { realtime: this.realtime, storage: this.storage })
    }
    if (effects.disconnectUserId !== null) {
      await this.realtime.disconnectUser(effects.disconnectUserId)
    }
    if (!(await deliverBillingMails(eventId))) {
      response.serviceUnavailable({
        code: 'E_BILLING_MAIL_PENDING',
        message: 'A billing email could not be sent, retry later',
      })
      return
    }
    response.noContent()
  }
}
