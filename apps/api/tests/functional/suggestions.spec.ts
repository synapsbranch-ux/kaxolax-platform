import {
  anchorToBase64,
  APPLIED_SUGGESTIONS_FIELD,
  applySuggestion,
  createCommentAnchor,
  createPointAnchor,
  TEXT_FIELD,
} from '@kaxolax/collab'
import {
  type AppliedSuggestionsResponse,
  type ApplySuggestionsRequest,
  type ApplySuggestionsResponse,
  decideSuggestionsResponseSchema,
  type ProjectEvent,
  type ProjectRole,
  SUGGESTION_EDIT_RATE_LIMIT,
  SUGGESTION_OPEN_LIMIT,
  SUGGESTION_RATE_LIMIT,
  suggestionRateLimitedErrorSchema,
  suggestionResponseSchema,
  suggestionsResponseSchema,
  type Suggestion as SuggestionEntry,
} from '@kaxolax/contracts'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import db from '@adonisjs/lucid/services/db'
import * as Y from 'yjs'
import Document from '#models/document'
import ProjectMember from '#models/project_member'
import Suggestion from '#models/suggestion'
import type User from '#models/user'
import RealtimeClient from '#services/realtime_client'
import { createUser } from '#tests/helpers'

/**
 * Service temps réel simulé : un Y.Doc par document, chargé depuis l'état enregistré, auquel les
 * suggestions acceptées sont appliquées comme le ferait le service (même fonction de
 * `@kaxolax/collab`, origine = auteur). Les événements du projet sont enregistrés.
 */
class FakeRealtimeClient extends RealtimeClient {
  readonly events: { projectId: string; event: ProjectEvent }[] = []
  readonly calls: { documentId: string; request: ApplySuggestionsRequest }[] = []
  /** Vérifications « déjà appliquée ? » (refus et retraits de suggestions ouvertes). */
  readonly checks: { documentId: string; ids: string[] }[] = []
  /** Auteur de chaque transaction appliquée (journal de l'historique simulé). */
  readonly authors: string[] = []
  readonly docs = new Map<string, Y.Doc>()
  available = true
  /** Applique le texte puis « perd » la réponse (délai dépassé côté API). */
  loseResponses = false
  /** Appels d'application qui réussissent avant que le service ne réponde plus. */
  failAfterCalls = Number.POSITIVE_INFINITY
  checksAvailable = true
  delayMs = 0

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

  /** Texte Yjs « en cours d'édition » d'un document. */
  async text(documentId: string): Promise<Y.Text> {
    let doc = this.docs.get(documentId)
    if (!doc) {
      doc = new Y.Doc()
      const document = await Document.findOrFail(documentId)
      if (document.yjsState) Y.applyUpdate(doc, new Uint8Array(document.yjsState))
      doc.on('afterTransaction', (transaction: Y.Transaction) => {
        const origin = transaction.origin as { userId?: string } | null
        if (origin?.userId) this.authors.push(origin.userId)
      })
      this.docs.set(documentId, doc)
    }
    return doc.getText(TEXT_FIELD)
  }

  override async applySuggestions(
    _projectId: string,
    documentId: string,
    request: ApplySuggestionsRequest,
  ): Promise<ApplySuggestionsResponse | null> {
    this.calls.push({ documentId, request })
    if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs))
    if (!this.available || this.calls.length > this.failAfterCalls) return null
    const text = await this.text(documentId)
    const results = request.suggestions.map((suggestion) => ({
      id: suggestion.id,
      outcome: applySuggestion(text, suggestion, {
        decidedBy: request.decidedBy,
        origin: { userId: suggestion.authorId },
      }),
    }))
    return this.loseResponses ? null : { results }
  }

  override async appliedSuggestions(
    _projectId: string,
    documentId: string,
    ids: string[],
  ): Promise<AppliedSuggestionsResponse | null> {
    this.checks.push({ documentId, ids })
    if (!this.checksAvailable) return null
    const doc = (await this.text(documentId)).doc
    const applied = doc?.getMap<string>(APPLIED_SUGGESTIONS_FIELD)
    return {
      applied: ids.flatMap((id) => {
        const decidedBy = applied?.get(id)
        return decidedBy === undefined ? [] : [{ id, decidedBy }]
      }),
    }
  }
}

let realtime: FakeRealtimeClient

function useFakes(group: Parameters<Parameters<typeof test.group>[1]>[0], global = true) {
  if (global) group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    realtime = new FakeRealtimeClient()
    app.container.swap(RealtimeClient, () => realtime)
    return () => {
      app.container.restore(RealtimeClient)
    }
  })
}

interface Target {
  projectId: string
  documentId: string
  /** Copie du document à l'état enregistré : les ancres y sont créées comme dans le navigateur. */
  text: Y.Text
}

async function newProject(client: ApiClient, owner: User): Promise<Target> {
  const response = await client.post('/api/v1/projects').json({ name: 'Thèse' }).loginAs(owner)
  response.assertStatus(201)
  const project = response.body().project as { id: string; mainDocumentId: string }
  const document = await Document.findOrFail(project.mainDocumentId)
  const doc = new Y.Doc()
  if (document.yjsState) Y.applyUpdate(doc, new Uint8Array(document.yjsState))
  return { projectId: project.id, documentId: document.id, text: doc.getText(TEXT_FIELD) }
}

async function addMember(projectId: string, role: ProjectRole): Promise<User> {
  const member = await createUser()
  await ProjectMember.create({ projectId, userId: member.id, role })
  return member
}

/** Remplacement de [from, to[ du texte d'origine. */
function replaceBody(target: Target, from: number, to: number, proposedText: string) {
  return {
    documentId: target.documentId,
    kind: 'replace',
    anchor: anchorToBase64(createCommentAnchor(target.text, from, to)),
    originalText: target.text.toJSON().slice(from, to),
    proposedText,
  }
}

function insertBody(target: Target, at: number, proposedText: string) {
  return {
    documentId: target.documentId,
    kind: 'insert',
    anchor: anchorToBase64(createPointAnchor(target.text, at)),
    proposedText,
  }
}

/** Corps d'une modification (`PATCH`) : le document ne change pas. */
function changeOf(body: { documentId: string } & Record<string, unknown>) {
  const { documentId: _documentId, ...change } = body
  return change
}

async function suggest(client: ApiClient, user: User, target: Target, body: object) {
  return client.post(`/api/v1/projects/${target.projectId}/suggestions`).json(body).loginAs(user)
}

async function suggestionOf(
  client: ApiClient,
  user: User,
  target: Target,
  body: object,
): Promise<SuggestionEntry> {
  const response = await suggest(client, user, target, body)
  response.assertStatus(201)
  return suggestionResponseSchema.parse(response.body()).suggestion
}

async function decide(client: ApiClient, user: User, target: Target, body: object) {
  return client
    .post(`/api/v1/projects/${target.projectId}/suggestions/decide`)
    .json(body)
    .loginAs(user)
}

test.group('suggestions: permissions', (group) => {
  useFakes(group)

  test('owner, editor and reviewer suggest; viewer only reads', async ({ client, assert }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    for (const [index, role] of (['editor', 'reviewer'] as const).entries()) {
      const member = await addMember(target.projectId, role)
      const suggestion = await suggestionOf(client, member, target, insertBody(target, index, role))
      assert.equal(suggestion.author.id, member.id)
      assert.equal(suggestion.status, 'open')
      assert.equal(suggestion.origin, 'user')
      assert.notProperty(suggestion.author, 'email')
    }
    await suggestionOf(client, owner, target, replaceBody(target, 0, 5, '\\Docu'))

    const viewer = await addMember(target.projectId, 'viewer')
    const refused = await suggest(client, viewer, target, insertBody(target, 0, 'x'))
    refused.assertStatus(403)
    assert.equal(refused.body().code, 'E_PROJECT_FORBIDDEN')
    const list = await client
      .get(`/api/v1/projects/${target.projectId}/suggestions`)
      .loginAs(viewer)
    list.assertStatus(200)
    assert.lengthOf(suggestionsResponseSchema.parse(list.body()).suggestions, 3)
    // Le texte du document n'a pas changé : rien n'est appliqué avant l'acceptation.
    assert.lengthOf(realtime.calls, 0)
    assert.deepEqual(
      realtime.events.map(({ event }) => event.type),
      ['suggestion.created', 'suggestion.created', 'suggestion.created'],
    )
  })

  test('only editors and the owner decide', async ({ client, assert }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const reviewer = await addMember(target.projectId, 'reviewer')
    const viewer = await addMember(target.projectId, 'viewer')
    const editor = await addMember(target.projectId, 'editor')
    const suggestion = await suggestionOf(client, reviewer, target, insertBody(target, 0, '% '))
    for (const user of [reviewer, viewer]) {
      const refused = await decide(client, user, target, { decision: 'reject', all: true })
      refused.assertStatus(403)
    }
    const accepted = await decide(client, editor, target, {
      decision: 'accept',
      ids: [suggestion.id],
    })
    accepted.assertStatus(200)
    const body = decideSuggestionsResponseSchema.parse(accepted.body())
    assert.deepEqual(body.results, [{ id: suggestion.id, outcome: 'accepted' }])
    assert.equal(body.suggestions[0]?.decidedBy?.id, editor.id)
    assert.isTrue((await realtime.text(target.documentId)).toJSON().startsWith('% \\docu'))

    const stranger = await createUser()
    ;(await decide(client, stranger, target, { decision: 'reject', all: true })).assertStatus(404)
    ;(
      await client.post(`/api/v1/projects/${target.projectId}/suggestions/decide`).json({})
    ).assertStatus(401)
  })

  test('only the author changes or withdraws an open suggestion', async ({ client, assert }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const reviewer = await addMember(target.projectId, 'reviewer')
    const suggestion = await suggestionOf(client, reviewer, target, insertBody(target, 0, 'a'))
    const path = `/api/v1/projects/${target.projectId}/suggestions/${suggestion.id}`
    const change = {
      kind: 'insert',
      anchor: anchorToBase64(createPointAnchor(target.text, 0)),
      proposedText: 'ab',
    }

    const notAuthor = await client.patch(path).json(change).loginAs(owner)
    notAuthor.assertStatus(403)
    assert.equal(notAuthor.body().code, 'E_SUGGESTION_NOT_AUTHOR')
    ;(await client.delete(path).loginAs(owner)).assertStatus(403)

    const edited = await client.patch(path).json(change).loginAs(reviewer)
    edited.assertStatus(200)
    assert.equal(suggestionResponseSchema.parse(edited.body()).suggestion.proposedText, 'ab')
    ;(await client.get(path).loginAs(owner)).assertStatus(200)

    const other = await suggestionOf(client, reviewer, target, insertBody(target, 3, 'z'))
    ;(
      await client
        .delete(`/api/v1/projects/${target.projectId}/suggestions/${other.id}`)
        .loginAs(reviewer)
    ).assertStatus(204)
    assert.isNull(await Suggestion.find(other.id))

    ;(
      await decide(client, owner, target, { decision: 'reject', ids: [suggestion.id] })
    ).assertStatus(200)
    const decided = await client.patch(path).json(change).loginAs(reviewer)
    decided.assertStatus(409)
    assert.equal(decided.body().code, 'E_SUGGESTION_ALREADY_DECIDED')
    ;(await client.delete(path).loginAs(reviewer)).assertStatus(409)
    assert.deepEqual(
      realtime.events.map(({ event }) =>
        event.type === 'suggestion.updated' ? `${event.type}:${event.change}` : event.type,
      ),
      [
        'suggestion.created',
        'suggestion.updated:edited',
        'suggestion.created',
        'suggestion.updated:deleted',
        'suggestion.decided',
      ],
    )
  })

  test('validates the document, the anchor and the texts', async ({ client, assert }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const other = await newProject(client, owner)

    const foreign = await suggest(client, owner, target, {
      ...insertBody(target, 0, 'x'),
      documentId: other.documentId,
    })
    foreign.assertStatus(404)
    assert.equal(foreign.body().code, 'E_DOCUMENT_NOT_FOUND')

    // Un point pour un remplacement, une plage pour une insertion, une ancre illisible.
    for (const anchor of [anchorToBase64(createPointAnchor(target.text, 0)), 'AAAA']) {
      const bad = await suggest(client, owner, target, {
        ...replaceBody(target, 0, 5, 'x'),
        anchor,
      })
      bad.assertStatus(422)
      assert.equal(bad.body().code, 'E_SUGGESTION_INVALID_ANCHOR')
    }
    const range = anchorToBase64(createCommentAnchor(target.text, 0, 1))
    ;(
      await suggest(client, owner, target, { ...insertBody(target, 0, 'x'), anchor: range })
    ).assertStatus(422)

    for (const invalid of [
      { ...insertBody(target, 0, 'x'.repeat(20_001)) },
      { ...insertBody(target, 0, '') },
      { ...replaceBody(target, 0, 5, 'x'), kind: 'delete' },
    ]) {
      const response = await suggest(client, owner, target, invalid)
      response.assertStatus(422)
      assert.equal(response.body().code, 'E_VALIDATION_ERROR')
    }
    assert.lengthOf(realtime.events, 0)
  })

  test('limits the rate of new suggestions', async ({ client, assert }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const anchor = Buffer.from(createPointAnchor(target.text, 0))
    for (let index = 0; index < SUGGESTION_RATE_LIMIT.suggestions; index++) {
      await Suggestion.create({
        projectId: target.projectId,
        documentId: target.documentId,
        authorId: owner.id,
        origin: 'user',
        kind: 'insert',
        anchor,
        originalText: '',
        proposedText: 'x',
        status: 'open',
        decidedBy: null,
        decidedAt: null,
        aiMessageId: null,
      })
    }
    const limited = await suggest(client, owner, target, insertBody(target, 0, 'y'))
    limited.assertStatus(429)
    const body = suggestionRateLimitedErrorSchema.parse(limited.body())
    assert.isAbove(body.retryAfterSeconds, 0)
    assert.equal(limited.header('retry-after'), String(body.retryAfterSeconds))
  })

  test('limits the rate of changes and withdrawals', async ({ client, assert }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const reviewer = await addMember(target.projectId, 'reviewer')
    const suggestion = await suggestionOf(client, reviewer, target, insertBody(target, 0, 'a'))
    const url = `/api/v1/projects/${target.projectId}/suggestions/${suggestion.id}`
    const edited = await client
      .patch(url)
      .json(changeOf(insertBody(target, 0, 'ab')))
      .loginAs(reviewer)
    edited.assertStatus(200)
    // Fenêtre en cours déjà pleine (frappes envoyées en boucle).
    await db
      .from('suggestion_edit_rates')
      .where({ project_id: target.projectId, user_id: reviewer.id })
      .update({ edits: SUGGESTION_EDIT_RATE_LIMIT.edits })

    const limited = await client
      .patch(url)
      .json(changeOf(insertBody(target, 0, 'abc')))
      .loginAs(reviewer)
    limited.assertStatus(429)
    const body = suggestionRateLimitedErrorSchema.parse(limited.body())
    assert.isAbove(body.retryAfterSeconds, 0)
    assert.isAtMost(body.retryAfterSeconds, SUGGESTION_EDIT_RATE_LIMIT.windowSeconds)
    assert.equal(limited.header('retry-after'), String(body.retryAfterSeconds))
    const withdrawn = await client.delete(url).loginAs(reviewer)
    withdrawn.assertStatus(429)
    assert.equal((await Suggestion.findOrFail(suggestion.id)).proposedText, 'ab')
    // Refusés, ils ne sont pas annoncés : seules la création et la première modification le sont.
    assert.lengthOf(realtime.events, 2)
    // Le compteur est propre au membre et au projet : l'éditeur n'est pas limité.
    const mine = await suggestionOf(client, owner, target, insertBody(target, 1, 'z'))
    const own = await client
      .patch(`/api/v1/projects/${target.projectId}/suggestions/${mine.id}`)
      .json(changeOf(insertBody(target, 1, 'zz')))
      .loginAs(owner)
    own.assertStatus(200)
  })

  test('caps the pending suggestions of an author and of a project', async ({ client, assert }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const reviewer = await addMember(target.projectId, 'reviewer')
    const anchor = Buffer.from(createPointAnchor(target.text, 0))
    // Hors de la fenêtre de débit des créations : seul le plafond s'applique.
    const createdAt = new Date(Date.now() - 10 * 60 * 1000)
    const rows = (authorId: string, count: number, status: 'open' | 'stale') =>
      Array.from({ length: count }, () => ({
        project_id: target.projectId,
        document_id: target.documentId,
        author_id: authorId,
        origin: 'user',
        kind: 'insert',
        anchor,
        original_text: '',
        proposed_text: 'x',
        status,
        decided_at: status === 'stale' ? createdAt : null,
        created_at: createdAt,
        updated_at: createdAt,
      }))
    await db
      .table('suggestions')
      .multiInsert(rows(reviewer.id, SUGGESTION_OPEN_LIMIT.perAuthor - 1, 'open'))
    await db.table('suggestions').multiInsert(rows(reviewer.id, 1, 'stale'))

    const capped = await suggest(client, reviewer, target, insertBody(target, 0, 'y'))
    capped.assertStatus(409)
    assert.equal(capped.body().code, 'E_SUGGESTION_OPEN_LIMIT')
    // Une suggestion écartée libère une place.
    const stale = await Suggestion.query()
      .where({ projectId: target.projectId, status: 'stale' })
      .firstOrFail()
    const discarded = await decide(client, owner, target, { decision: 'reject', ids: [stale.id] })
    discarded.assertStatus(200)
    const created = await suggest(client, reviewer, target, insertBody(target, 0, 'y'))
    created.assertStatus(201)

    // Plafond du projet, tous auteurs confondus.
    const others = SUGGESTION_OPEN_LIMIT.perProject - SUGGESTION_OPEN_LIMIT.perAuthor
    for (let start = 0; start < others; start += 1000) {
      const author = await addMember(target.projectId, 'editor')
      await db
        .table('suggestions')
        .multiInsert(rows(author.id, Math.min(1000, others - start), 'open'))
    }
    const full = await suggest(client, owner, target, insertBody(target, 0, 'w'))
    full.assertStatus(409)
    assert.equal(full.body().code, 'E_SUGGESTION_OPEN_LIMIT')
  })
})

test.group('suggestions: decisions', (group) => {
  useFakes(group)

  test('accepts in the name of the author and announces the decision', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const reviewer = await addMember(target.projectId, 'reviewer')
    const original = target.text.toJSON()
    const replace = await suggestionOf(client, reviewer, target, replaceBody(target, 1, 9, 'DOC'))
    const insert = await suggestionOf(client, owner, target, insertBody(target, 0, '% début\n'))

    const response = await decide(client, owner, target, { decision: 'accept', all: true })
    response.assertStatus(200)
    const body = decideSuggestionsResponseSchema.parse(response.body())
    assert.deepEqual(body.results, [
      { id: replace.id, outcome: 'accepted' },
      { id: insert.id, outcome: 'accepted' },
    ])
    assert.equal(body.remaining, 0)
    assert.deepEqual(
      body.suggestions.map((suggestion) => [suggestion.status, suggestion.decidedBy?.id]),
      [
        ['accepted', owner.id],
        ['accepted', owner.id],
      ],
    )
    assert.equal(
      (await realtime.text(target.documentId)).toJSON(),
      `% début\n\\DOC${original.slice(9)}`,
    )
    // Historique : chaque modification au nom de l'auteur de sa suggestion.
    assert.deepEqual(realtime.authors, [reviewer.id, owner.id])
    assert.deepEqual(realtime.calls[0]?.request.decidedBy, owner.id)
    assert.deepEqual(realtime.events.at(-1), {
      projectId: target.projectId,
      event: {
        type: 'suggestion.decided',
        decisions: [
          { suggestionId: replace.id, documentId: target.documentId, status: 'accepted' },
          { suggestionId: insert.id, documentId: target.documentId, status: 'accepted' },
        ],
        actorId: owner.id,
      },
    })
  })

  test('rejects every open suggestion of one author, in one document', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const second = await client
      .post(`/api/v1/projects/${target.projectId}/documents`)
      .json({ name: 'annexe.tex' })
      .loginAs(owner)
    second.assertStatus(201)
    const annexId = (second.body() as { document: { id: string } }).document.id
    const annex = { ...target, documentId: annexId, text: new Y.Doc().getText(TEXT_FIELD) }
    const reviewer = await addMember(target.projectId, 'reviewer')
    const editor = await addMember(target.projectId, 'editor')
    const mine = [
      await suggestionOf(client, reviewer, target, insertBody(target, 0, 'a')),
      await suggestionOf(client, reviewer, target, insertBody(target, 1, 'b')),
    ]
    const inAnnex = await suggestionOf(client, reviewer, annex, insertBody(annex, 0, 'c'))
    const theirs = await suggestionOf(client, editor, target, insertBody(target, 2, 'd'))

    const response = await decide(client, owner, target, {
      decision: 'reject',
      authorId: reviewer.id,
      documentId: target.documentId,
    })
    const body = decideSuggestionsResponseSchema.parse(response.body())
    assert.deepEqual(
      body.results,
      mine.map((suggestion) => ({ id: suggestion.id, outcome: 'rejected' })),
    )
    assert.lengthOf(realtime.calls, 0)
    const open = await client.get(`/api/v1/projects/${target.projectId}/suggestions`).loginAs(owner)
    assert.sameMembers(
      suggestionsResponseSchema.parse(open.body()).suggestions.map((suggestion) => suggestion.id),
      [inAnnex.id, theirs.id],
    )
    const rejected = await client
      .get(`/api/v1/projects/${target.projectId}/suggestions`)
      .qs({ status: 'rejected', authorId: reviewer.id })
      .loginAs(owner)
    assert.lengthOf(suggestionsResponseSchema.parse(rejected.body()).suggestions, 2)
  })

  test('marks a suggestion stale when its original text changed', async ({ client, assert }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const suggestion = await suggestionOf(client, owner, target, replaceBody(target, 1, 9, 'DOC'))
    // Quelqu'un tape dans la plage avant la décision.
    const live = await realtime.text(target.documentId)
    live.insert(4, 'X')
    const before = live.toJSON()

    const response = await decide(client, owner, target, {
      decision: 'accept',
      ids: [suggestion.id],
    })
    const body = decideSuggestionsResponseSchema.parse(response.body())
    assert.deepEqual(body.results, [{ id: suggestion.id, outcome: 'stale' }])
    assert.equal(body.suggestions[0]?.status, 'stale')
    assert.isNull(body.suggestions[0]?.decidedBy)
    assert.isNotNull(body.suggestions[0]?.decidedAt)
    assert.equal(live.toJSON(), before)
  })

  test('is idempotent and never half-applies when the realtime service fails', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const suggestion = await suggestionOf(client, owner, target, insertBody(target, 0, '%% '))

    realtime.available = false
    const failed = await decide(client, owner, target, { decision: 'accept', ids: [suggestion.id] })
    failed.assertStatus(503)
    assert.equal(failed.body().code, 'E_SUGGESTION_REALTIME_UNAVAILABLE')
    assert.equal((await Suggestion.findOrFail(suggestion.id)).status, 'open')
    assert.isFalse(realtime.events.some(({ event }) => event.type === 'suggestion.decided'))

    realtime.available = true
    const accepted = await decide(client, owner, target, {
      decision: 'accept',
      ids: [suggestion.id],
    })
    assert.deepEqual(decideSuggestionsResponseSchema.parse(accepted.body()).results, [
      { id: suggestion.id, outcome: 'accepted' },
    ])
    // Double clic : déjà décidée, rien de plus.
    const again = await decide(client, owner, target, { decision: 'accept', ids: [suggestion.id] })
    assert.deepEqual(decideSuggestionsResponseSchema.parse(again.body()).results, [
      { id: suggestion.id, outcome: 'unchanged' },
    ])
    const rejectedLater = await decide(client, owner, target, {
      decision: 'reject',
      ids: [suggestion.id, '00000000-0000-4000-8000-000000000000'],
    })
    assert.deepEqual(decideSuggestionsResponseSchema.parse(rejectedLater.body()).results, [
      { id: suggestion.id, outcome: 'unchanged' },
      { id: '00000000-0000-4000-8000-000000000000', outcome: 'missing' },
    ])
    assert.lengthOf(realtime.calls, 2)
    const text = (await realtime.text(target.documentId)).toJSON()
    assert.isTrue(text.startsWith('%% \\docu'))
    assert.isFalse(text.startsWith('%% %% '))
    assert.lengthOf(
      realtime.events.filter(({ event }) => event.type === 'suggestion.decided'),
      1,
    )
  })

  test('discards a stale suggestion, or lets its author withdraw it', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const reviewer = await addMember(target.projectId, 'reviewer')
    const first = await suggestionOf(client, reviewer, target, replaceBody(target, 1, 9, 'DOC'))
    const second = await suggestionOf(client, reviewer, target, replaceBody(target, 1, 5, 'X'))
    const open = await suggestionOf(client, reviewer, target, insertBody(target, 0, '% '))
    ;(await realtime.text(target.documentId)).insert(4, 'Z')
    const accepted = await decide(client, owner, target, {
      decision: 'accept',
      ids: [first.id, second.id],
    })
    assert.deepEqual(
      decideSuggestionsResponseSchema.parse(accepted.body()).results.map((r) => r.outcome),
      ['stale', 'stale'],
    )
    // Accepter à nouveau : rien à faire.
    const again = await decide(client, owner, target, { decision: 'accept', ids: [first.id] })
    assert.deepEqual(decideSuggestionsResponseSchema.parse(again.body()).results, [
      { id: first.id, outcome: 'unchanged' },
    ])

    // Un relecteur ne décide pas, même pour écarter.
    const refused = await decide(client, reviewer, target, { decision: 'reject', ids: [first.id] })
    refused.assertStatus(403)
    // L'éditeur ou le propriétaire l'écarte : refusée, décideur noté, annoncée.
    const discarded = await decide(client, owner, target, { decision: 'reject', ids: [first.id] })
    discarded.assertStatus(200)
    const body = decideSuggestionsResponseSchema.parse(discarded.body())
    assert.deepEqual(body.results, [{ id: first.id, outcome: 'rejected' }])
    assert.equal(body.suggestions[0]?.status, 'rejected')
    assert.equal(body.suggestions[0]?.decidedBy?.id, owner.id)
    assert.deepEqual(realtime.events.at(-1)?.event, {
      type: 'suggestion.decided',
      decisions: [{ suggestionId: first.id, documentId: target.documentId, status: 'rejected' }],
      actorId: owner.id,
    })
    // Seules les suggestions ouvertes sont vérifiées auprès du service temps réel.
    assert.lengthOf(realtime.checks, 0)

    // L'auteur retire la sienne ; il ne peut plus la modifier.
    const url = `/api/v1/projects/${target.projectId}/suggestions/${second.id}`
    const edit = await client
      .patch(url)
      .json(changeOf(replaceBody(target, 1, 5, 'Y')))
      .loginAs(reviewer)
    edit.assertStatus(409)
    const withdrawn = await client.delete(url).loginAs(reviewer)
    withdrawn.assertStatus(204)
    assert.isNull(await Suggestion.find(second.id))

    // « Tout refuser » écarte aussi les obsolètes.
    const third = await Suggestion.findOrFail(open.id)
    third.status = 'stale'
    third.decidedAt = third.createdAt
    await third.save()
    const fresh = await suggestionOf(client, reviewer, target, insertBody(target, 2, '!'))
    const all = await decide(client, owner, target, { decision: 'reject', all: true })
    assert.sameDeepMembers(decideSuggestionsResponseSchema.parse(all.body()).results, [
      { id: open.id, outcome: 'rejected' },
      { id: fresh.id, outcome: 'rejected' },
    ])
    const listed = await client
      .get(`/api/v1/projects/${target.projectId}/suggestions`)
      .qs({ status: 'stale' })
      .loginAs(owner)
    assert.lengthOf(suggestionsResponseSchema.parse(listed.body()).suggestions, 0)
  })

  test('keeps the batches applied before the realtime service failed', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const second = await client
      .post(`/api/v1/projects/${target.projectId}/documents`)
      .json({ name: 'annexe.tex' })
      .loginAs(owner)
    second.assertStatus(201)
    const annexId = (second.body() as { document: { id: string } }).document.id
    const annex = { ...target, documentId: annexId, text: new Y.Doc().getText(TEXT_FIELD) }
    const main = await suggestionOf(client, owner, target, insertBody(target, 0, '%% '))
    const other = await suggestionOf(client, owner, annex, insertBody(annex, 0, 'annexe'))
    realtime.failAfterCalls = 1

    const failed = await decide(client, owner, target, { decision: 'accept', all: true })
    failed.assertStatus(503)
    assert.equal(failed.body().code, 'E_SUGGESTION_REALTIME_UNAVAILABLE')
    // Le premier lot, appliqué, est enregistré et annoncé ; le second reste ouvert.
    assert.equal((await Suggestion.findOrFail(main.id)).status, 'accepted')
    assert.equal((await Suggestion.findOrFail(other.id)).status, 'open')
    assert.deepEqual(realtime.events.at(-1)?.event, {
      type: 'suggestion.decided',
      decisions: [{ suggestionId: main.id, documentId: target.documentId, status: 'accepted' }],
      actorId: owner.id,
    })

    realtime.failAfterCalls = Number.POSITIVE_INFINITY
    const retried = await decide(client, owner, target, { decision: 'accept', all: true })
    assert.deepEqual(decideSuggestionsResponseSchema.parse(retried.body()).results, [
      { id: other.id, outcome: 'accepted' },
    ])
    assert.isTrue((await realtime.text(target.documentId)).toJSON().startsWith('%% \\docu'))
    assert.isFalse((await realtime.text(target.documentId)).toJSON().startsWith('%% %% '))
  })

  test('records as accepted an open suggestion already applied by a lost acceptance', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const editor = await addMember(target.projectId, 'editor')
    const reviewer = await addMember(target.projectId, 'reviewer')
    const rejected = await suggestionOf(client, reviewer, target, insertBody(target, 0, '%% '))
    const withdrawn = await suggestionOf(client, reviewer, target, insertBody(target, 3, 'w'))
    const untouched = await suggestionOf(client, reviewer, target, insertBody(target, 5, 'u'))
    const edited = await suggestionOf(client, reviewer, target, insertBody(target, 7, 'e'))

    // Texte appliqué, mais la réponse n'arrive pas : rien n'est marqué.
    realtime.loseResponses = true
    const lost = await decide(client, editor, target, {
      decision: 'accept',
      ids: [rejected.id, withdrawn.id, edited.id],
    })
    lost.assertStatus(503)
    realtime.loseResponses = false
    assert.equal((await Suggestion.findOrFail(rejected.id)).status, 'open')

    // Vérification impossible : ni refus ni retrait.
    realtime.checksAvailable = false
    const unavailable = await decide(client, owner, target, {
      decision: 'reject',
      ids: [rejected.id],
    })
    unavailable.assertStatus(503)
    const url = `/api/v1/projects/${target.projectId}/suggestions/${withdrawn.id}`
    ;(await client.delete(url).loginAs(reviewer)).assertStatus(503)
    assert.equal((await Suggestion.findOrFail(rejected.id)).status, 'open')
    assert.isNotNull(await Suggestion.find(withdrawn.id))
    realtime.checksAvailable = true

    // Refuser : déjà dans le texte, donc acceptée au nom de celui qui l'avait acceptée.
    const response = await decide(client, owner, target, {
      decision: 'reject',
      ids: [rejected.id, untouched.id],
    })
    const body = decideSuggestionsResponseSchema.parse(response.body())
    assert.deepEqual(body.results, [
      { id: rejected.id, outcome: 'accepted' },
      { id: untouched.id, outcome: 'rejected' },
    ])
    assert.equal(body.suggestions[0]?.decidedBy?.id, editor.id)
    assert.equal(body.suggestions[1]?.decidedBy?.id, owner.id)

    // Retirer : de même, acceptée (409) au lieu d'être supprimée, et annoncée.
    const refused = await client.delete(url).loginAs(reviewer)
    refused.assertStatus(409)
    assert.equal(refused.body().code, 'E_SUGGESTION_ALREADY_DECIDED')
    const stored = await Suggestion.findOrFail(withdrawn.id)
    assert.equal(stored.status, 'accepted')
    assert.equal(stored.decidedBy, editor.id)
    assert.deepEqual(realtime.events.at(-1)?.event, {
      type: 'suggestion.decided',
      decisions: [
        { suggestionId: withdrawn.id, documentId: target.documentId, status: 'accepted' },
      ],
      actorId: editor.id,
    })

    // Modifier : de même, le texte appliqué est l'ancien ; acceptée telle quelle (409).
    const editUrl = `/api/v1/projects/${target.projectId}/suggestions/${edited.id}`
    const changed = await client
      .patch(editUrl)
      .json(changeOf(insertBody(target, 7, 'autre')))
      .loginAs(reviewer)
    changed.assertStatus(409)
    assert.equal(changed.body().code, 'E_SUGGESTION_ALREADY_DECIDED')
    const kept = await Suggestion.findOrFail(edited.id)
    assert.equal(kept.status, 'accepted')
    assert.equal(kept.proposedText, 'e')
    assert.equal(kept.decidedBy, editor.id)
    assert.deepEqual(realtime.events.at(-1)?.event, {
      type: 'suggestion.decided',
      decisions: [{ suggestionId: edited.id, documentId: target.documentId, status: 'accepted' }],
      actorId: editor.id,
    })
  })

  test('never records a decider read from the document who cannot decide in the project', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const editor = await addMember(target.projectId, 'editor')
    const reviewer = await addMember(target.projectId, 'reviewer')
    const outsider = await createUser()
    const first = await suggestionOf(client, reviewer, target, insertBody(target, 0, 'a'))
    const second = await suggestionOf(client, reviewer, target, insertBody(target, 2, 'b'))
    const third = await suggestionOf(client, reviewer, target, insertBody(target, 4, 'c'))
    // Map du document falsifiée (un client éditeur, avant que le service temps réel n'annule son
    // écriture) : un compte hors projet, un relecteur, un identifiant quelconque.
    const applied = (await realtime.text(target.documentId)).doc?.getMap<string>(
      APPLIED_SUGGESTIONS_FIELD,
    )
    applied?.set(first.id, outsider.id)
    applied?.set(second.id, reviewer.id)
    applied?.set(third.id, 'pas-un-uuid')

    // Refus par l'éditeur : décideur = l'éditeur, jamais le compte inscrit dans la map.
    const response = await decide(client, editor, target, {
      decision: 'reject',
      ids: [first.id, second.id],
    })
    const body = decideSuggestionsResponseSchema.parse(response.body())
    assert.deepEqual(
      body.suggestions.map((suggestion) => suggestion.decidedBy),
      [
        { id: editor.id, fullName: editor.fullName, avatarUrl: null },
        { id: editor.id, fullName: editor.fullName, avatarUrl: null },
      ],
    )
    assert.notInclude(JSON.stringify(body), outsider.id)

    // Retrait par le relecteur (qui ne décide pas) : décideur = le propriétaire du projet.
    const url = `/api/v1/projects/${target.projectId}/suggestions/${third.id}`
    ;(await client.delete(url).loginAs(reviewer)).assertStatus(409)
    assert.equal((await Suggestion.findOrFail(third.id)).decidedBy, owner.id)
    const stored = await Suggestion.query().whereIn('id', [first.id, second.id, third.id])
    assert.notInclude(
      stored.map((suggestion) => suggestion.decidedBy),
      outsider.id,
    )
  })

  test('pages through the suggestions of a project', async ({ client, assert }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const created = []
    for (let index = 0; index < 5; index++) {
      created.push(await suggestionOf(client, owner, target, insertBody(target, index, `${index}`)))
    }
    const seen: string[] = []
    let after: string | null = null
    do {
      const page = await client
        .get(`/api/v1/projects/${target.projectId}/suggestions`)
        .qs({ limit: 2, ...(after === null ? {} : { after }) })
        .loginAs(owner)
      page.assertStatus(200)
      const body = suggestionsResponseSchema.parse(page.body())
      seen.push(...body.suggestions.map((suggestion) => suggestion.id))
      after = body.nextCursor
    } while (after !== null)
    assert.deepEqual(
      seen,
      created.map((suggestion) => suggestion.id),
    )

    // La suggestion du curseur est retirée entre deux pages : la lecture continue après elle.
    const first = await client
      .get(`/api/v1/projects/${target.projectId}/suggestions`)
      .qs({ limit: 2 })
      .loginAs(owner)
    const cursor = suggestionsResponseSchema.parse(first.body()).nextCursor
    assert.isNotNull(cursor)
    ;(
      await client
        .delete(`/api/v1/projects/${target.projectId}/suggestions/${created[1]?.id ?? ''}`)
        .loginAs(owner)
    ).assertStatus(204)
    const next = await client
      .get(`/api/v1/projects/${target.projectId}/suggestions`)
      .qs({ limit: 2, after: cursor })
      .loginAs(owner)
    next.assertStatus(200)
    const rest = suggestionsResponseSchema.parse(next.body())
    assert.deepEqual(
      rest.suggestions.map((suggestion) => suggestion.id),
      [created[2]?.id, created[3]?.id],
    )
    assert.isNotNull(rest.nextCursor)
    const bad = await client
      .get(`/api/v1/projects/${target.projectId}/suggestions`)
      .qs({ status: 'pending' })
      .loginAs(owner)
    bad.assertStatus(422)
  })
})

/**
 * Concurrence réelle : sans transaction globale (chaque requête a sa propre connexion), comme deux
 * décideurs sur deux instances de l'API. Les données restent jusqu'au retour arrière des
 * migrations en fin de suite.
 */
test.group('suggestions: concurrent decisions', (group) => {
  useFakes(group, false)

  test('two simultaneous decisions apply the text once', async ({ client, assert }) => {
    const owner = await createUser()
    const target = await newProject(client, owner)
    const editor = await addMember(target.projectId, 'editor')
    const suggestion = await suggestionOf(client, owner, target, insertBody(target, 0, '%% '))
    realtime.delayMs = 200

    const responses = await Promise.all([
      decide(client, owner, target, { decision: 'accept', ids: [suggestion.id] }),
      decide(client, editor, target, { decision: 'accept', all: true }),
      decide(client, owner, target, { decision: 'reject', ids: [suggestion.id] }),
    ])
    const outcomes = responses.flatMap(
      (response) => decideSuggestionsResponseSchema.parse(response.body()).results,
    )
    const decisive = outcomes.filter((result) => result.outcome !== 'unchanged')
    assert.lengthOf(decisive, 1)
    const stored = await Suggestion.findOrFail(suggestion.id)
    assert.equal(stored.status, decisive[0]?.outcome)
    const applied = realtime.calls.filter(({ request }) =>
      request.suggestions.some((entry) => entry.id === suggestion.id),
    )
    assert.isAtMost(applied.length, 1)
    const text = (await realtime.text(target.documentId)).toJSON()
    assert.equal(text.startsWith('%% '), stored.status === 'accepted')
    assert.isFalse(text.startsWith('%% %% '))
  })
})
