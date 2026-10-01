import { randomUUID } from 'node:crypto'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import ClerkWebhookEvent from '#models/clerk_webhook_event'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import User from '#models/user'
import RealtimeClient from '#services/realtime_client'
import { signWebhook } from '#tests/clerk_keys'
import { createUser, newClerkUserId, uniqueEmail } from '#tests/helpers'

class FakeRealtimeClient extends RealtimeClient {
  closed: string[] = []

  override async closeDocuments(documentIds: readonly string[]) {
    this.closed.push(...documentIds)
    return Promise.resolve()
  }
}

/** Objet `user` d'un webhook Clerk, email principal vérifié par défaut. */
function clerkUser(id: string, email: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    object: 'user',
    first_name: 'Ada',
    last_name: 'Lovelace',
    image_url: 'https://img.clerk.com/ada.png',
    primary_email_address_id: 'idn_1',
    email_addresses: [{ id: 'idn_1', email_address: email, verification: { status: 'verified' } }],
    ...extra,
  }
}

async function send(
  client: ApiClient,
  type: string,
  data: Record<string, unknown>,
  id = `msg_${randomUUID()}`,
) {
  const body = JSON.stringify({ type, object: 'event', data, timestamp: Date.now() })
  return client
    .post('/api/v1/webhooks/clerk')
    .headers({ ...signWebhook(body, undefined, id), 'content-type': 'application/json' })
    .json(JSON.parse(body) as object)
}

test.group('clerk: webhooks', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    app.container.swap(RealtimeClient, () => new FakeRealtimeClient())
    return () => {
      app.container.restore(RealtimeClient)
    }
  })

  test('refuses a missing or wrong signature', async ({ client, assert }) => {
    const data = clerkUser(newClerkUserId(), uniqueEmail())
    const unsigned = await client
      .post('/api/v1/webhooks/clerk')
      .json({ type: 'user.created', data })
    unsigned.assertStatus(400)
    const body = JSON.stringify({ type: 'user.created', data })
    const forged = await client
      .post('/api/v1/webhooks/clerk')
      .headers(signWebhook(body, `whsec_${Buffer.from('another-secret').toString('base64')}`))
      .json(JSON.parse(body) as object)
    forged.assertStatus(400)
    assert.isNull(await User.findBy('clerkUserId', data.id))
  })

  test('mirrors a created then updated user', async ({ client, assert }) => {
    const clerkUserId = newClerkUserId()
    const email = uniqueEmail('mirror')
    ;(await send(client, 'user.created', clerkUser(clerkUserId, email))).assertStatus(204)
    const created = await User.findByOrFail('clerkUserId', clerkUserId)
    assert.equal(created.email, email)
    assert.equal(created.fullName, 'Ada Lovelace')

    const newEmail = uniqueEmail('renamed')
    const updated = clerkUser(clerkUserId, newEmail, { first_name: 'Augusta', image_url: '' })
    ;(await send(client, 'user.updated', updated)).assertStatus(204)
    await created.refresh()
    assert.equal(created.email, newEmail)
    assert.equal(created.fullName, 'Augusta Lovelace')
  })

  test('ignores a user without a verified primary email', async ({ client, assert }) => {
    const data = clerkUser(newClerkUserId(), uniqueEmail(), {
      email_addresses: [
        { id: 'idn_1', email_address: uniqueEmail(), verification: { status: 'unverified' } },
      ],
    })
    ;(await send(client, 'user.created', data)).assertStatus(204)
    assert.isNull(await User.findBy('clerkUserId', data.id))
  })

  test('a replayed event has no effect', async ({ client, assert }) => {
    const clerkUserId = newClerkUserId()
    const messageId = `msg_${randomUUID()}`
    ;(
      await send(client, 'user.created', clerkUser(clerkUserId, uniqueEmail()), messageId)
    ).assertStatus(204)
    const user = await User.findByOrFail('clerkUserId', clerkUserId)
    user.fullName = 'Changed locally'
    await user.save()
    // Même svix-id : l'événement est reconnu et ignoré, même avec un contenu différent.
    const replay = clerkUser(clerkUserId, uniqueEmail(), { first_name: 'Replayed' })
    ;(await send(client, 'user.updated', replay, messageId)).assertStatus(204)
    await user.refresh()
    assert.equal(user.fullName, 'Changed locally')
    assert.equal((await ClerkWebhookEvent.query().where('id', messageId)).length, 1)
  })

  test('an update received before the creation still creates the user', async ({
    client,
    assert,
  }) => {
    const clerkUserId = newClerkUserId()
    ;(await send(client, 'user.updated', clerkUser(clerkUserId, uniqueEmail()))).assertStatus(204)
    ;(await send(client, 'user.created', clerkUser(clerkUserId, uniqueEmail()))).assertStatus(204)
    assert.equal((await User.query().where('clerkUserId', clerkUserId)).length, 1)
  })

  test('a deleted user is anonymised, leaves shared projects and loses own projects', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const clerkUserId = user.clerkUserId
    const other = await createUser()

    const own = await client.post('/api/v1/projects').json({ name: 'Mine' }).loginAs(user)
    const shared = await client.post('/api/v1/projects').json({ name: 'Theirs' }).loginAs(other)
    const ownId = String(own.body().project.id)
    const sharedId = String(shared.body().project.id)
    await ProjectMember.create({ projectId: sharedId, userId: user.id, role: 'editor' })

    ;(await send(client, 'user.deleted', { id: clerkUserId, deleted: true })).assertStatus(204)

    await user.refresh()
    assert.isNotNull(user.deletedAt)
    assert.equal(user.email, `deleted+${user.id}@users.invalid`)
    assert.isNull(user.fullName)
    assert.equal(user.clerkUserId, clerkUserId)
    assert.isNull(await Project.find(ownId))
    assert.isNotNull(await Project.find(sharedId))
    assert.equal((await ProjectMember.query().where('userId', user.id)).length, 0)

    // Un événement en retard ne ressuscite pas le compte.
    ;(await send(client, 'user.updated', clerkUser(clerkUserId, uniqueEmail()))).assertStatus(204)
    await user.refresh()
    assert.equal(user.email, `deleted+${user.id}@users.invalid`)
  })
})
