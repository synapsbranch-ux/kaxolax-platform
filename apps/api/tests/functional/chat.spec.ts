import {
  CHAT_MESSAGE_MAX_LENGTH,
  CHAT_RATE_LIMIT,
  chatMessageResponseSchema,
  chatMessagesResponseSchema,
  chatRateLimitedErrorSchema,
  chatUnreadResponseSchema,
  mentionToken,
  type ProjectEvent,
  type ProjectRole,
} from '@kaxolax/contracts'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import mail from '@adonisjs/mail/services/main'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import { DateTime } from 'luxon'
import ChatMentionMail from '#mails/chat_mention_mail'
import ChatMessage from '#models/chat_message'
import ProjectMember from '#models/project_member'
import type User from '#models/user'
import RealtimeClient from '#services/realtime_client'
import { createUser } from '#tests/helpers'

/** Service temps réel simulé : événements du projet enregistrés. */
class FakeRealtimeClient extends RealtimeClient {
  readonly events: { projectId: string; event: ProjectEvent }[] = []

  override publishProjectEvent(projectId: string, event: ProjectEvent): Promise<void> {
    this.events.push({ projectId, event })
    return Promise.resolve()
  }

  override membersChanged(): Promise<void> {
    return Promise.resolve()
  }

  override closeDocuments(): Promise<void> {
    return Promise.resolve()
  }
}

let realtime: FakeRealtimeClient
let mailer: ReturnType<typeof mail.fake>

function useChatFakes(group: Parameters<Parameters<typeof test.group>[1]>[0]) {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    realtime = new FakeRealtimeClient()
    app.container.swap(RealtimeClient, () => realtime)
    mailer = mail.fake()
    return () => {
      app.container.restore(RealtimeClient)
      mail.restore()
    }
  })
}

async function newProject(client: ApiClient, owner: User): Promise<string> {
  const response = await client.post('/api/v1/projects').json({ name: 'Thèse' }).loginAs(owner)
  response.assertStatus(201)
  return response.body().project.id as string
}

/** Membre ajouté une minute plus tôt (l'historique d'avant son arrivée n'est pas non lu). */
async function addMember(projectId: string, role: ProjectRole, user?: User): Promise<User> {
  const member = user ?? (await createUser())
  await ProjectMember.create({
    projectId,
    userId: member.id,
    role,
    createdAt: DateTime.now().minus({ minutes: 1 }),
  })
  return member
}

async function send(client: ApiClient, user: User, projectId: string, body: string) {
  return client.post(`/api/v1/projects/${projectId}/chat/messages`).json({ body }).loginAs(user)
}

async function history(client: ApiClient, user: User, projectId: string, qs = '') {
  const response = await client
    .get(`/api/v1/projects/${projectId}/chat/messages${qs}`)
    .loginAs(user)
  response.assertStatus(200)
  return chatMessagesResponseSchema.parse(response.body())
}

/** Messages datés d'une seconde en seconde (insertion directe, sans limite de débit). */
async function seed(projectId: string, authorId: string, count: number): Promise<ChatMessage[]> {
  const start = DateTime.now().minus({ hours: 1 })
  const messages: ChatMessage[] = []
  for (let index = 0; index < count; index++) {
    messages.push(
      await ChatMessage.create({
        projectId,
        authorId,
        body: `message ${String(index)}`,
        createdAt: start.plus({ seconds: index }),
      }),
    )
  }
  return messages
}

function mentionMails() {
  return mailer.mails.sent((candidate) => candidate instanceof ChatMentionMail)
}

test.group('chat: messages', (group) => {
  useChatFakes(group)

  test('every role reads and writes; the message is announced after commit', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    for (const role of ['editor', 'reviewer', 'viewer'] as const) {
      const member = await addMember(projectId, role)
      const response = await send(client, member, projectId, `  bonjour de ${role}  `)
      response.assertStatus(201)
      const { message } = chatMessageResponseSchema.parse(response.body())
      assert.equal(message.body, `bonjour de ${role}`)
      assert.equal(message.author.id, member.id)
      assert.deepEqual(realtime.events.at(-1), {
        projectId,
        event: { type: 'chat.message-created', messageId: message.id, authorId: member.id },
      })
    }
    const page = await history(client, owner, projectId)
    assert.deepEqual(
      page.messages.map((message) => message.body),
      ['bonjour de editor', 'bonjour de reviewer', 'bonjour de viewer'],
    )
    // Jamais l'email de l'auteur.
    assert.notProperty(page.messages[0]?.author ?? {}, 'email')
  })

  test('non-members get 404, and nothing is published', async ({ client }) => {
    const owner = await createUser()
    const stranger = await createUser()
    const projectId = await newProject(client, owner)
    ;(await send(client, stranger, projectId, 'intrus')).assertStatus(404)
    ;(
      await client.get(`/api/v1/projects/${projectId}/chat/messages`).loginAs(stranger)
    ).assertStatus(404)
    ;(
      await client.post(`/api/v1/projects/${projectId}/chat/read`).json({}).loginAs(stranger)
    ).assertStatus(404)
    ;(await client.get(`/api/v1/projects/${projectId}/chat/messages`)).assertStatus(401)
  })

  test('the body is required and bounded', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    ;(await send(client, owner, projectId, '   ')).assertStatus(422)
    ;(await send(client, owner, projectId, 'x'.repeat(CHAT_MESSAGE_MAX_LENGTH + 1))).assertStatus(
      422,
    )
    ;(await send(client, owner, projectId, 'x'.repeat(CHAT_MESSAGE_MAX_LENGTH))).assertStatus(201)
    assert.lengthOf(realtime.events, 1)
  })

  test('HTML is stored and returned as plain text', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const body = '<script>alert(1)</script> & <b>gras</b>'
    const response = await send(client, owner, projectId, body)
    response.assertStatus(201)
    assert.equal(chatMessageResponseSchema.parse(response.body()).message.body, body)
  })

  test('sending is rate limited per member and project', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const editor = await addMember(projectId, 'editor')
    for (let index = 0; index < CHAT_RATE_LIMIT.messages; index++) {
      ;(await send(client, owner, projectId, `n° ${String(index)}`)).assertStatus(201)
    }
    const limited = await send(client, owner, projectId, 'un de trop')
    limited.assertStatus(429)
    const body = chatRateLimitedErrorSchema.parse(limited.body())
    assert.isAtMost(body.retryAfterSeconds, CHAT_RATE_LIMIT.windowSeconds)
    assert.equal(limited.header('retry-after'), String(body.retryAfterSeconds))
    // Les autres membres ne sont pas concernés.
    ;(await send(client, editor, projectId, 'moi je peux')).assertStatus(201)
    assert.lengthOf(realtime.events, CHAT_RATE_LIMIT.messages + 1)
  })
})

test.group('chat: history', (group) => {
  useChatFakes(group)

  test('pages backwards with before and forwards with after', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const seeded = await seed(projectId, owner.id, 7)
    const bodies = (page: { messages: { body: string }[] }) => page.messages.map((m) => m.body)

    const latest = await history(client, owner, projectId, '?limit=3')
    assert.deepEqual(bodies(latest), ['message 4', 'message 5', 'message 6'])
    assert.isTrue(latest.hasMore)

    const older = await history(client, owner, projectId, `?limit=3&before=${seeded[4]?.id ?? ''}`)
    assert.deepEqual(bodies(older), ['message 1', 'message 2', 'message 3'])
    assert.isTrue(older.hasMore)
    const oldest = await history(client, owner, projectId, `?limit=3&before=${seeded[1]?.id ?? ''}`)
    assert.deepEqual(bodies(oldest), ['message 0'])
    assert.isFalse(oldest.hasMore)

    const newer = await history(client, owner, projectId, `?limit=4&after=${seeded[2]?.id ?? ''}`)
    assert.deepEqual(bodies(newer), ['message 3', 'message 4', 'message 5', 'message 6'])
    assert.isFalse(newer.hasMore)
  })

  test('messages of the same millisecond are neither lost nor repeated', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const at = DateTime.now().minus({ minutes: 5 })
    for (let index = 0; index < 5; index++) {
      await ChatMessage.create({
        projectId,
        authorId: owner.id,
        body: String(index),
        createdAt: at,
      })
    }
    const seen: string[] = []
    let page = await history(client, owner, projectId, '?limit=2')
    seen.unshift(...page.messages.map((message) => message.id))
    while (page.hasMore) {
      page = await history(client, owner, projectId, `?limit=2&before=${seen[0] ?? ''}`)
      seen.unshift(...page.messages.map((message) => message.id))
    }
    assert.lengthOf(new Set(seen), 5)
  })

  test('rejects an unknown cursor or two cursors', async ({ client }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const other = await newProject(client, owner)
    const [foreign] = await seed(other, owner.id, 1)
    ;(
      await client
        .get(`/api/v1/projects/${projectId}/chat/messages?before=${foreign?.id ?? ''}`)
        .loginAs(owner)
    ).assertStatus(404)
    ;(
      await client
        .get(
          `/api/v1/projects/${projectId}/chat/messages?before=${foreign?.id ?? ''}&after=${foreign?.id ?? ''}`,
        )
        .loginAs(owner)
    ).assertStatus(422)
  })
})

test.group('chat: unread', (group) => {
  useChatFakes(group)

  test('counts messages of others since the last read, which never goes back', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const editor = await addMember(projectId, 'editor')
    const sent: string[] = []
    for (const body of ['un', 'deux', 'trois']) {
      const response = await send(client, owner, projectId, body)
      sent.push(chatMessageResponseSchema.parse(response.body()).message.id)
    }
    await send(client, editor, projectId, 'ma réponse')

    // Ses propres messages ne comptent pas.
    assert.equal((await history(client, editor, projectId)).unread.count, 3)
    assert.equal((await history(client, owner, projectId)).unread.count, 1)

    const read = await client
      .post(`/api/v1/projects/${projectId}/chat/read`)
      .json({ upTo: sent[1] })
      .loginAs(editor)
    read.assertStatus(200)
    assert.equal(chatUnreadResponseSchema.parse(read.body()).unread.count, 1)

    // Une lecture plus ancienne (autre onglet) ne fait pas reculer la dernière lecture.
    const back = await client
      .post(`/api/v1/projects/${projectId}/chat/read`)
      .json({ upTo: sent[0] })
      .loginAs(editor)
    assert.equal(chatUnreadResponseSchema.parse(back.body()).unread.count, 1)

    const all = await client
      .post(`/api/v1/projects/${projectId}/chat/read`)
      .json({})
      .loginAs(editor)
    const unread = chatUnreadResponseSchema.parse(all.body()).unread
    assert.equal(unread.count, 0)
    assert.isNotNull(unread.lastReadAt)

    // Exact après rechargement : relu depuis chat_reads.
    assert.equal((await history(client, editor, projectId)).unread.count, 0)
  })

  test('history from before joining the project is not unread', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    await seed(projectId, owner.id, 3)
    const newcomer = await createUser()
    await ProjectMember.create({ projectId, userId: newcomer.id, role: 'viewer' })
    assert.equal((await history(client, newcomer, projectId)).unread.count, 0)
    await send(client, owner, projectId, 'bienvenue')
    assert.equal((await history(client, newcomer, projectId)).unread.count, 1)
  })
})

test.group('chat: mentions', (group) => {
  useChatFakes(group)

  test('emails a mentioned member once until they read the chat', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const editor = await addMember(projectId, 'editor')
    editor.fullName = 'Grace Hopper'
    await editor.save()

    await send(client, owner, projectId, `Regarde main.tex:4 ${mentionToken(editor.id)} <b>!</b>`)
    const [first] = mentionMails()
    assert.instanceOf(first, ChatMentionMail)
    if (!(first instanceof ChatMentionMail)) return
    assert.equal(first.data.to, editor.email)
    assert.equal(first.data.excerpt, 'Regarde main.tex:4 @Grace Hopper <b>!</b>')
    assert.match(first.data.url, new RegExp(`/project/${projectId}\\?panel=chat$`))
    first.prepare()
    assert.include(first.message.toJSON().message.html ?? '', '&lt;b&gt;!&lt;/b&gt;')

    // Deuxième mention non lue : pas de nouvel email.
    await send(client, owner, projectId, `${mentionToken(editor.id)} tu as vu ?`)
    assert.lengthOf(mentionMails(), 1)

    // Après lecture, une nouvelle mention notifie de nouveau.
    await client.post(`/api/v1/projects/${projectId}/chat/read`).json({}).loginAs(editor)
    await send(client, owner, projectId, `${mentionToken(editor.id)} et maintenant ?`)
    assert.lengthOf(mentionMails(), 2)
  })

  test('ignores self, non-members and deleted accounts', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const stranger = await createUser()
    const gone = await addMember(projectId, 'viewer')
    gone.deletedAt = DateTime.now()
    await gone.save()
    const response = await send(
      client,
      owner,
      projectId,
      `${mentionToken(owner.id)} ${mentionToken(stranger.id)} ${mentionToken(gone.id)}`,
    )
    response.assertStatus(201)
    assert.lengthOf(mentionMails(), 0)
  })

  test('a failing email does not fail the message', async ({ client, assert }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const editor = await addMember(projectId, 'editor')
    mail.restore()
    const original = mail.send.bind(mail)
    mail.send = () => Promise.reject(new Error('smtp down'))
    try {
      const response = await send(client, owner, projectId, `${mentionToken(editor.id)} ping`)
      response.assertStatus(201)
      assert.lengthOf(realtime.events, 1)
    } finally {
      mail.send = original
    }
  })
})
