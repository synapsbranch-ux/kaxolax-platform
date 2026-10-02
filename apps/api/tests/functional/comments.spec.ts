import { createStateAnchor } from '@kaxolax/collab'
import {
  COMMENT_MENTION_EMAIL_INTERVAL_MINUTES,
  COMMENT_RATE_LIMIT,
  commentRateLimitedErrorSchema,
  commentThreadResponseSchema,
  commentThreadsResponseSchema,
  type CommentThread as CommentThreadEntry,
  mentionToken,
  type ProjectEvent,
  type ProjectRole,
} from '@kaxolax/contracts'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import mail from '@adonisjs/mail/services/main'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import { DateTime } from 'luxon'
import CommentMentionMail from '#mails/comment_mention_mail'
import Comment from '#models/comment'
import CommentThread from '#models/comment_thread'
import Document from '#models/document'
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

function useCommentFakes(group: Parameters<Parameters<typeof test.group>[1]>[0]) {
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

/** Projet avec son document principal (texte du modèle de départ). */
async function newProject(client: ApiClient, owner: User) {
  const response = await client.post('/api/v1/projects').json({ name: 'Thèse' }).loginAs(owner)
  response.assertStatus(201)
  const project = response.body().project as { id: string; mainDocumentId: string }
  const document = await Document.findOrFail(project.mainDocumentId)
  return { projectId: project.id, documentId: document.id, state: document.yjsState }
}

async function addMember(projectId: string, role: ProjectRole): Promise<User> {
  const member = await createUser()
  await ProjectMember.create({ projectId, userId: member.id, role })
  return member
}

function anchorOf(state: Buffer | null): string {
  return Buffer.from(createStateAnchor(state, 0, 5)).toString('base64')
}

async function openThread(
  client: ApiClient,
  user: User,
  target: { projectId: string; documentId: string; state: Buffer | null },
  body = 'Une remarque',
) {
  return client
    .post(`/api/v1/projects/${target.projectId}/comment-threads`)
    .json({
      documentId: target.documentId,
      anchor: anchorOf(target.state),
      quotedText: '\\docu',
      body,
    })
    .loginAs(user)
}

function threadFrom(response: { body(): unknown }): CommentThreadEntry {
  const { thread } = commentThreadResponseSchema.parse(response.body())
  if (thread === null) throw new Error('thread expected')
  return thread
}

function mentionMails() {
  return mailer.mails.sent((candidate) => candidate instanceof CommentMentionMail)
}

test.group('comments: permissions', (group) => {
  useCommentFakes(group)

  test('owner, editor and reviewer comment; viewer only reads', async ({ client, assert }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    for (const role of ['editor', 'reviewer'] as const) {
      const member = await addMember(target.projectId, role)
      const response = await openThread(client, member, target, `avis de ${role}`)
      response.assertStatus(201)
      const thread = threadFrom(response)
      assert.equal(thread.documentId, target.documentId)
      assert.equal(thread.quotedText, '\\docu')
      assert.equal(thread.comments[0]?.body, `avis de ${role}`)
      assert.notProperty(thread.comments[0]?.author ?? {}, 'email')
    }
    ;(await openThread(client, owner, target)).assertStatus(201)

    const viewer = await addMember(target.projectId, 'viewer')
    const refused = await openThread(client, viewer, target)
    refused.assertStatus(403)
    assert.equal(refused.body().code, 'E_PROJECT_FORBIDDEN')
    const [first] = await CommentThread.query().where('projectId', target.projectId)
    if (!first) throw new Error('thread expected')
    for (const path of ['comments', 'resolve', 'reopen']) {
      ;(
        await client
          .post(`/api/v1/projects/${target.projectId}/comment-threads/${first.id}/${path}`)
          .json({ body: 'non' })
          .loginAs(viewer)
      ).assertStatus(403)
    }

    // Le lecteur lit tous les fils.
    const list = await client
      .get(`/api/v1/projects/${target.projectId}/comment-threads`)
      .loginAs(viewer)
    list.assertStatus(200)
    assert.lengthOf(commentThreadsResponseSchema.parse(list.body()).threads, 3)
    // Rien n'a été annoncé pour les refus.
    assert.lengthOf(realtime.events, 3)
  })

  test('strangers get 404, anonymous requests 401', async ({ client }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const stranger = await createUser()
    ;(await openThread(client, stranger, target)).assertStatus(404)
    ;(
      await client.get(`/api/v1/projects/${target.projectId}/comment-threads`).loginAs(stranger)
    ).assertStatus(404)
    ;(await client.get(`/api/v1/projects/${target.projectId}/comment-threads`)).assertStatus(401)
  })

  test('rejects an unreadable anchor and a document of another project', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const other = await newProject(client, owner)
    const bad = await client
      .post(`/api/v1/projects/${target.projectId}/comment-threads`)
      .json({ documentId: target.documentId, anchor: 'AAAA', quotedText: 'x', body: 'y' })
      .loginAs(owner)
    bad.assertStatus(422)
    assert.equal(bad.body().code, 'E_COMMENT_INVALID_ANCHOR')
    const foreign = await openThread(client, owner, { ...target, documentId: other.documentId })
    foreign.assertStatus(404)
    assert.equal(foreign.body().code, 'E_DOCUMENT_NOT_FOUND')
    assert.lengthOf(realtime.events, 0)
  })
})

test.group('comments: threads', (group) => {
  useCommentFakes(group)

  test('creates a thread, replies, and announces both after commit', async ({ client, assert }) => {
    const owner = await createUser()
    const reviewer = await createUser()
    const target = await newProject(client, owner)
    await ProjectMember.create({
      projectId: target.projectId,
      userId: reviewer.id,
      role: 'reviewer',
    })
    const created = threadFrom(await openThread(client, owner, target))
    const firstId = created.comments[0]?.id ?? ''
    assert.deepEqual(realtime.events.at(-1), {
      projectId: target.projectId,
      event: {
        type: 'comment.created',
        threadId: created.id,
        commentId: firstId,
        documentId: target.documentId,
        authorId: owner.id,
      },
    })
    // L'ancre est rendue telle qu'envoyée.
    assert.equal(created.anchor, anchorOf(target.state))

    const reply = await client
      .post(`/api/v1/projects/${target.projectId}/comment-threads/${created.id}/comments`)
      .json({ body: 'Je reformule.' })
      .loginAs(reviewer)
    reply.assertStatus(201)
    const thread = threadFrom(reply)
    assert.deepEqual(
      thread.comments.map((comment) => [comment.author.id, comment.body]),
      [
        [owner.id, 'Une remarque'],
        [reviewer.id, 'Je reformule.'],
      ],
    )
    assert.include(realtime.events.at(-1)?.event ?? {}, {
      type: 'comment.created',
      threadId: created.id,
      authorId: reviewer.id,
    })
  })

  test('only the author edits or deletes a comment; the thread goes with its last comment', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const editor = await addMember(target.projectId, 'editor')
    const thread = threadFrom(await openThread(client, owner, target))
    const base = `/api/v1/projects/${target.projectId}/comment-threads/${thread.id}`
    const reply = threadFrom(
      await client.post(`${base}/comments`).json({ body: 'Réponse' }).loginAs(editor),
    )
    const [first, second] = reply.comments
    if (!first || !second) throw new Error('comments expected')

    const notMine = await client
      .patch(`${base}/comments/${first.id}`)
      .json({ body: 'piraté' })
      .loginAs(editor)
    notMine.assertStatus(403)
    assert.equal(notMine.body().code, 'E_COMMENT_NOT_AUTHOR')
    ;(await client.delete(`${base}/comments/${first.id}`).loginAs(editor)).assertStatus(403)

    const edited = await client
      .patch(`${base}/comments/${first.id}`)
      .json({ body: 'Remarque précisée' })
      .loginAs(owner)
    edited.assertStatus(200)
    const afterEdit = threadFrom(edited).comments[0]
    assert.equal(afterEdit?.body, 'Remarque précisée')
    assert.isNotNull(afterEdit?.editedAt)
    assert.deepInclude(realtime.events.at(-1)?.event ?? {}, {
      type: 'comment.thread-updated',
      change: 'comment-edited',
      actorId: owner.id,
    })

    // Supprimé : sa place reste, le texte disparaît (aussi en base).
    const deleted = await client.delete(`${base}/comments/${first.id}`).loginAs(owner)
    deleted.assertStatus(200)
    const kept = threadFrom(deleted)
    assert.isNull(kept.comments[0]?.body)
    assert.isNotNull(kept.comments[0]?.deletedAt)
    assert.equal((await Comment.findOrFail(first.id)).body, '')
    ;(await client.delete(`${base}/comments/${first.id}`).loginAs(owner)).assertStatus(404)
    ;(
      await client.patch(`${base}/comments/${first.id}`).json({ body: 'x' }).loginAs(owner)
    ).assertStatus(404)

    // Dernier message visible supprimé : le fil disparaît.
    const gone = await client.delete(`${base}/comments/${second.id}`).loginAs(editor)
    gone.assertStatus(200)
    assert.isNull(commentThreadResponseSchema.parse(gone.body()).thread)
    assert.isNull(await CommentThread.find(thread.id))
    assert.deepInclude(realtime.events.at(-1)?.event ?? {}, {
      type: 'comment.thread-updated',
      change: 'deleted',
      threadId: thread.id,
    })
    ;(await client.get(base).loginAs(owner)).assertStatus(404)
  })

  test('an author demoted to viewer can no longer change their comment', async ({ client }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const reviewer = await addMember(target.projectId, 'reviewer')
    const thread = threadFrom(await openThread(client, reviewer, target))
    await ProjectMember.query()
      .where({ projectId: target.projectId, userId: reviewer.id })
      .update({ role: 'viewer' })
    const commentId = thread.comments[0]?.id ?? ''
    ;(
      await client
        .patch(
          `/api/v1/projects/${target.projectId}/comment-threads/${thread.id}/comments/${commentId}`,
        )
        .json({ body: 'x' })
        .loginAs(reviewer)
    ).assertStatus(403)
  })

  test('resolves and reopens a thread, idempotently, and filters by status', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const reviewer = await addMember(target.projectId, 'reviewer')
    const open = threadFrom(await openThread(client, owner, target, 'ouvert'))
    const toResolve = threadFrom(await openThread(client, owner, target, 'à résoudre'))
    const base = `/api/v1/projects/${target.projectId}/comment-threads`

    const resolved = await client.post(`${base}/${toResolve.id}/resolve`).loginAs(reviewer)
    resolved.assertStatus(200)
    const thread = threadFrom(resolved)
    assert.isNotNull(thread.resolvedAt)
    assert.equal(thread.resolvedBy?.id, reviewer.id)
    const events = realtime.events.length
    ;(await client.post(`${base}/${toResolve.id}/resolve`).loginAs(owner)).assertStatus(200)
    assert.lengthOf(realtime.events, events, 'a second resolution announces nothing')

    const list = async (status: string) =>
      commentThreadsResponseSchema
        .parse((await client.get(`${base}?status=${status}`).loginAs(owner)).body())
        .threads.map((entry) => entry.id)
    assert.deepEqual(await list('open'), [open.id])
    assert.deepEqual(await list('resolved'), [toResolve.id])
    assert.deepEqual(await list('all'), [open.id, toResolve.id])

    // Une réponse dans un fil résolu est permise ; le fil reste résolu jusqu'à sa réouverture.
    ;(
      await client.post(`${base}/${toResolve.id}/comments`).json({ body: 'après' }).loginAs(owner)
    ).assertStatus(201)
    const reopened = threadFrom(await client.post(`${base}/${toResolve.id}/reopen`).loginAs(owner))
    assert.isNull(reopened.resolvedAt)
    assert.isNull(reopened.resolvedBy)
    assert.deepInclude(realtime.events.at(-1)?.event ?? {}, {
      type: 'comment.thread-updated',
      change: 'reopened',
    })
    // Un fil d'un autre projet n'est pas trouvé.
    const other = await newProject(client, owner)
    ;(
      await client
        .post(`/api/v1/projects/${other.projectId}/comment-threads/${open.id}/resolve`)
        .loginAs(owner)
    ).assertStatus(404)
  })

  test('filters by document', async ({ client, assert }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const created = await client
      .post(`/api/v1/projects/${target.projectId}/documents`)
      .json({ name: 'annexe.tex', content: 'Annexe A' })
      .loginAs(owner)
    created.assertStatus(201)
    const annex = await Document.findOrFail(
      (created.body() as { document: { id: string } }).document.id,
    )
    const first = threadFrom(await openThread(client, owner, target))
    const second = threadFrom(
      await openThread(client, owner, {
        projectId: target.projectId,
        documentId: annex.id,
        state: annex.yjsState,
      }),
    )
    const list = async (documentId: string) =>
      commentThreadsResponseSchema
        .parse(
          (
            await client
              .get(`/api/v1/projects/${target.projectId}/comment-threads?documentId=${documentId}`)
              .loginAs(owner)
          ).body(),
        )
        .threads.map((entry) => entry.id)
    assert.deepEqual(await list(target.documentId), [first.id])
    assert.deepEqual(await list(annex.id), [second.id])
  })

  test('comments are rate limited per member and project', async ({ client, assert }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const editor = await addMember(target.projectId, 'editor')
    const thread = threadFrom(await openThread(client, owner, target))
    const base = `/api/v1/projects/${target.projectId}/comment-threads/${thread.id}/comments`
    for (let index = 1; index < COMMENT_RATE_LIMIT.comments; index++) {
      ;(
        await client
          .post(base)
          .json({ body: `n° ${String(index)}` })
          .loginAs(owner)
      ).assertStatus(201)
    }
    const limited = await client.post(base).json({ body: 'de trop' }).loginAs(owner)
    limited.assertStatus(429)
    const body = commentRateLimitedErrorSchema.parse(limited.body())
    assert.isAtMost(body.retryAfterSeconds, COMMENT_RATE_LIMIT.windowSeconds)
    ;(await client.post(base).json({ body: 'moi je peux' }).loginAs(editor)).assertStatus(201)
  })
})

test.group('comments: mentions', (group) => {
  useCommentFakes(group)

  test('emails mentioned members once per interval, never the author or strangers', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const viewer = await addMember(target.projectId, 'viewer')
    const stranger = await createUser()
    const body = `Tu peux relire ${mentionToken(viewer.id)} ? cc ${mentionToken(stranger.id)} ${mentionToken(owner.id)}`
    const thread = threadFrom(await openThread(client, owner, target, body))
    const sent = mentionMails()
    assert.lengthOf(sent, 1)
    const message = sent[0]?.message.toJSON().message
    assert.deepEqual(message?.to, [viewer.email])
    const text = typeof message?.text === 'string' ? message.text : ''
    assert.include(text, '> \\docu')
    assert.include(text, `?comment=${thread.id}`)
    assert.include(text, '@Ada Lovelace')

    // Deuxième mention dans l'intervalle : pas de nouvel email.
    ;(
      await client
        .post(`/api/v1/projects/${target.projectId}/comment-threads/${thread.id}/comments`)
        .json({ body: `encore ${mentionToken(viewer.id)}` })
        .loginAs(owner)
    ).assertStatus(201)
    assert.lengthOf(mentionMails(), 1)

    // L'intervalle court depuis le dernier email, pas depuis la dernière mention : la mention
    // suivante notifie de nouveau, même si une mention sans email vient d'avoir lieu.
    await db
      .from('project_members')
      .where({ project_id: target.projectId, user_id: viewer.id })
      .update({
        comment_mention_emailed_at: DateTime.now()
          .minus({ minutes: COMMENT_MENTION_EMAIL_INTERVAL_MINUTES + 1 })
          .toJSDate(),
      })
    ;(
      await client
        .post(`/api/v1/projects/${target.projectId}/comment-threads/${thread.id}/comments`)
        .json({ body: `et encore ${mentionToken(viewer.id)}` })
        .loginAs(owner)
    ).assertStatus(201)
    assert.lengthOf(mentionMails(), 2)
  })
})
