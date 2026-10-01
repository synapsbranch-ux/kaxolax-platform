import { verifyWebhook } from '@clerk/backend/webhooks'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import clerkConfig from '#config/clerk'
import { deleteClerkUser, profileFromWebhook, upsertClerkUser } from '#services/clerk_users'
import ObjectStorage from '#services/object_storage'
import { type DeletedProject, releaseDeletedProject } from '#services/project_service'
import RealtimeClient from '#services/realtime_client'

const SIGNATURE_HEADERS = ['svix-id', 'svix-timestamp', 'svix-signature'] as const

/**
 * Webhooks Clerk (user.created, user.updated, user.deleted) : signature vérifiée sur le corps brut,
 * chaque événement traité une seule fois (table clerk_webhook_events, même transaction).
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
    const deleted = await db.transaction(async (trx): Promise<DeletedProject[]> => {
      const inserted: unknown[] = await trx
        .insertQuery()
        .table('clerk_webhook_events')
        .insert({ id: eventId, type: event.type })
        .onConflict('id')
        .ignore()
        .returning('id')
      if (inserted.length === 0) return [] // déjà traité

      if (event.type === 'user.created' || event.type === 'user.updated') {
        const profile = profileFromWebhook(event.data)
        // Sans email principal vérifié, le compte attend : rien à refléter pour l'instant.
        if (profile) await upsertClerkUser(profile, trx)
        return []
      }
      if (event.type === 'user.deleted' && typeof event.data.id === 'string') {
        return deleteClerkUser(event.data.id, trx)
      }
      return []
    })

    for (const project of deleted) {
      await releaseDeletedProject(project, { realtime: this.realtime, storage: this.storage })
    }
    response.noContent()
  }
}
