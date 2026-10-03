import { createHash, randomUUID } from 'node:crypto'
import { blockAppendix, readDocumentText, replaceStateText } from '@kaxolax/collab'
import {
  addZoteroCitationResponseSchema,
  type ProjectEvent,
  projectZoteroResponseSchema,
  type ReplaceDocumentRequest,
  zoteroCollectionsResponseSchema,
  zoteroConnectionResponseSchema,
  zoteroConnectResponseSchema,
  zoteroLibrariesResponseSchema,
  zoteroSearchResponseSchema,
  zoteroSyncResponseSchema,
} from '@kaxolax/contracts'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import type { ApiClient } from '@japa/api-client'
import { test } from '@japa/runner'
import type { Group } from '@japa/runner/core'
import { DateTime } from 'luxon'
import Document from '#models/document'
import ProjectMember from '#models/project_member'
import type User from '#models/user'
import ZoteroAccount from '#models/zotero_account'
import ZoteroLink from '#models/zotero_link'
import ZoteroOAuthRequest from '#models/zotero_oauth_request'
import { createProject } from '#services/project_service'
import RealtimeClient from '#services/realtime_client'
import { MANAGED_BIB_HEADER } from '#services/zotero/bib'
import ZoteroClient from '#services/zotero/client'
import { addZoteroCitation, syncProjectZotero } from '#services/zotero/project_zotero'
import { clerkTokenFor } from '#tests/clerk'
import { signWebhook } from '#tests/clerk_keys'
import { createUser } from '#tests/helpers'
import { FAKE_GROUP, FAKE_ZOTERO_USER, FakeZotero } from '#tests/zotero'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/**
 * Faux service temps réel : instantané et remplacement de texte sur l'état enregistré en base,
 * comme le fait le service (modification minimale journalisée au nom de `userId`).
 */
class FakeRealtime extends RealtimeClient {
  events: ProjectEvent[] = []
  replaced: { documentId: string; request: ReplaceDocumentRequest }[] = []
  unavailable = false
  /** Appelé (une fois) au début du prochain remplacement : frappe concurrente, verrous… */
  beforeNextReplace: (() => Promise<void>) | null = null
  /** Prochain remplacement appliqué, mais sans réponse (délai dépassé). */
  loseNextAnswer = false

  override async publishProjectEvent(_projectId: string, event: ProjectEvent) {
    this.events.push(event)
    return Promise.resolve()
  }

  override async closeDocuments() {
    return Promise.resolve()
  }

  override async snapshot(projectId: string) {
    if (this.unavailable) return null
    const documents = await Document.query().where('projectId', projectId)
    return {
      projectId,
      documents: documents.map((document) => {
        const content = readDocumentText(
          document.yjsState ? new Uint8Array(document.yjsState) : null,
        )
        return { id: document.id, content, sha256: sha256(content) }
      }),
    }
  }

  override async replaceDocument(
    projectId: string,
    documentId: string,
    request: ReplaceDocumentRequest,
  ) {
    if (this.unavailable) return null
    const before = this.beforeNextReplace
    this.beforeNextReplace = null
    if (before) await before()
    this.replaced.push({ documentId, request })
    const document = await Document.findOrFail(documentId)
    const current = readDocumentText(document.yjsState ? new Uint8Array(document.yjsState) : null)
    // Ajout en fin de texte (insertion seule), comme le service temps réel.
    const appendix = request.append === true ? blockAppendix(current, request.content) : null
    if (request.append === true && appendix === null) return { changed: false }
    const next = appendix === null ? request.content : `${current}${appendix}`
    const { state, update } = replaceStateText(
      document.yjsState ? new Uint8Array(document.yjsState) : null,
      next,
    )
    if (!update) return { changed: false }
    await db
      .insertQuery()
      .table('document_updates')
      .insert({
        project_id: projectId,
        document_id: documentId,
        user_id: request.userId,
        yjs_update: Buffer.from(update),
      })
    await Document.query()
      .where('id', documentId)
      .update({ yjsState: Buffer.from(state), contentSha256: sha256(next) })
    if (this.loseNextAnswer) {
      this.loseNextAnswer = false
      return null
    }
    return { changed: true }
  }
}

let zotero: FakeZotero
let realtime: FakeRealtime

function useFakes(group: Group, configured = true) {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    zotero = new FakeZotero()
    realtime = new FakeRealtime()
    app.container.swap(ZoteroClient, () => zotero.client(configured))
    app.container.swap(RealtimeClient, () => realtime)
    return () => {
      app.container.restore(ZoteroClient)
      app.container.restore(RealtimeClient)
    }
  })
}

const bearer = (user: User, sid: string) => `Bearer ${clerkTokenFor(user, { sid })}`

/** `state` de l'URL de rappel envoyée à Zotero par la dernière demande de jeton. */
function lastCallbackState(): string {
  const request = zotero.requests.filter((entry) => entry.url.pathname === '/oauth/request').at(-1)
  const header = request?.headers.get('authorization') ?? ''
  const callback = decodeURIComponent(/oauth_callback="([^"]*)"/.exec(header)?.[1] ?? '')
  return new URL(callback).searchParams.get('state') ?? ''
}

/** Parcours OAuth complet dans la session `sid` ; renvoie la clé émise par le faux Zotero. */
async function connect(client: ApiClient, user: User, sid = 'sess_main'): Promise<string> {
  const started = await client
    .post('/api/v1/me/integrations/zotero/connect')
    .header('authorization', bearer(user, sid))
  started.assertStatus(200)
  const { authorizeUrl } = zoteroConnectResponseSchema.parse(started.body())
  const token = new URL(authorizeUrl).searchParams.get('oauth_token') ?? ''
  const verifier = zotero.authorize(token)
  const done = await client
    .get('/api/v1/integrations/zotero/callback')
    .qs({ oauth_token: token, oauth_verifier: verifier, state: lastCallbackState() })
    .header('authorization', bearer(user, sid))
  done.assertStatus(200)
  return [...zotero.validKeys].at(-1) ?? ''
}

async function bibText(projectId: string, name = 'references.bib'): Promise<string> {
  const document = await Document.query().where({ projectId, name }).firstOrFail()
  return readDocumentText(document.yjsState ? new Uint8Array(document.yjsState) : null)
}

async function linkCollection(client: ApiClient, user: User, projectId: string) {
  const response = await client
    .put(`/api/v1/projects/${projectId}/zotero`)
    .json({
      libraryType: 'user',
      libraryId: FAKE_ZOTERO_USER.id,
      collectionKey: 'THES2345',
      target: { kind: 'new', name: 'references.bib', folderId: null },
    })
    .loginAs(user)
  response.assertStatus(200)
  return projectZoteroResponseSchema.parse(response.body())
}

test.group('zotero: not configured', (group) => {
  useFakes(group, false)

  test('answers 503 E_ZOTERO_UNAVAILABLE without client key and secret', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const project = await createProject(user, 'Thesis')
    const state = await client.get('/api/v1/me/integrations/zotero').loginAs(user)
    state.assertStatus(200)
    assert.deepEqual(zoteroConnectionResponseSchema.parse(state.body()), {
      available: false,
      connection: null,
    })
    const started = await client.post('/api/v1/me/integrations/zotero/connect').loginAs(user)
    started.assertStatus(503)
    started.assertBodyContains({ code: 'E_ZOTERO_UNAVAILABLE' })
    const linkState = await client.get(`/api/v1/projects/${project.id}/zotero`).loginAs(user)
    assert.isFalse(projectZoteroResponseSchema.parse(linkState.body()).available)
    // Ouverture du projet : rien à faire, pas d'erreur.
    const opened = await client
      .post(`/api/v1/projects/${project.id}/zotero/sync`)
      .json({ trigger: 'open' })
      .loginAs(user)
    opened.assertStatus(200)
    assert.equal(zoteroSyncResponseSchema.parse(opened.body()).outcome, 'skipped')
    assert.lengthOf(zotero.requests, 0)
  })
})

test.group('zotero: OAuth connection', (group) => {
  useFakes(group)

  test('connects an account with OAuth 1.0a and keeps the key encrypted', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const started = await client
      .post('/api/v1/me/integrations/zotero/connect')
      .header('authorization', bearer(user, 'sess_a'))
    started.assertStatus(200)
    const { authorizeUrl } = zoteroConnectResponseSchema.parse(started.body())
    const authorize = new URL(authorizeUrl)
    assert.equal(authorize.origin + authorize.pathname, 'https://zotero.test/oauth/authorize')
    // Permissions minimales : lecture seule, sans les notes.
    assert.equal(authorize.searchParams.get('library_access'), '1')
    assert.equal(authorize.searchParams.get('notes_access'), '0')
    assert.equal(authorize.searchParams.get('write_access'), '0')
    assert.equal(authorize.searchParams.get('all_groups'), 'read')
    // Rappel vers la page web, avec un `state` aléatoire.
    const state = lastCallbackState()
    assert.isAbove(state.length, 30)
    const request = await ZoteroOAuthRequest.findByOrFail('userId', user.id)
    assert.equal(request.sessionId, 'sess_a')
    assert.notEqual(request.stateHash, state)
    const rawSecret = await db
      .from('zotero_oauth_requests')
      .where('id', request.id)
      .select('request_token_secret_encrypted')
      .firstOrFail()
    assert.notInclude(JSON.stringify(rawSecret), 'request-secret')

    const token = authorize.searchParams.get('oauth_token') ?? ''
    const verifier = zotero.authorize(token)
    const done = await client
      .get('/api/v1/integrations/zotero/callback')
      .qs({ oauth_token: token, oauth_verifier: verifier, state })
      .header('authorization', bearer(user, 'sess_a'))
    done.assertStatus(200)
    done.assertBodyContains({
      connection: { zoteroUserId: FAKE_ZOTERO_USER.id, username: FAKE_ZOTERO_USER.username },
    })
    const key = [...zotero.validKeys][0] ?? ''
    assert.notInclude(JSON.stringify(done.body()), key)
    // La demande est consommée, la clé chiffrée au repos.
    assert.isNull(await ZoteroOAuthRequest.findBy('userId', user.id))
    const account = await ZoteroAccount.findByOrFail('userId', user.id)
    assert.equal(account.apiKey, key)
    const raw = await db
      .from('zotero_accounts')
      .where('id', account.id)
      .select('api_key_encrypted')
      .firstOrFail()
    assert.notInclude(JSON.stringify(raw), key)

    const shown = await client.get('/api/v1/me/integrations/zotero').loginAs(user)
    const body = zoteroConnectionResponseSchema.parse(shown.body())
    assert.isTrue(body.available)
    assert.equal(body.connection?.zoteroUserId, FAKE_ZOTERO_USER.id)
    assert.notInclude(JSON.stringify(shown.body()), key)
  })

  test('refuses a callback from another session, another account or with a wrong state', async ({
    client,
  }) => {
    const user = await createUser()
    const other = await createUser()
    const started = await client
      .post('/api/v1/me/integrations/zotero/connect')
      .header('authorization', bearer(user, 'sess_a'))
    const token =
      new URL(zoteroConnectResponseSchema.parse(started.body()).authorizeUrl).searchParams.get(
        'oauth_token',
      ) ?? ''
    const verifier = zotero.authorize(token)
    const state = lastCallbackState()
    const attempt = (who: User, sid: string, query: Record<string, string>) =>
      client
        .get('/api/v1/integrations/zotero/callback')
        .qs({ oauth_token: token, oauth_verifier: verifier, state, ...query })
        .header('authorization', bearer(who, sid))

    // Chaque refus consomme la demande : on en relance une pour chaque cas.
    const otherSession = await attempt(user, 'sess_b', {})
    otherSession.assertStatus(400)
    otherSession.assertBodyContains({ code: 'E_ZOTERO_OAUTH_STATE' })
    const replay = await attempt(user, 'sess_a', {})
    replay.assertStatus(400)

    const retry = async (who: User, sid: string, query: Record<string, string>) => {
      const again = await client
        .post('/api/v1/me/integrations/zotero/connect')
        .header('authorization', bearer(user, 'sess_a'))
      const fresh =
        new URL(zoteroConnectResponseSchema.parse(again.body()).authorizeUrl).searchParams.get(
          'oauth_token',
        ) ?? ''
      return client
        .get('/api/v1/integrations/zotero/callback')
        .qs({
          oauth_token: fresh,
          oauth_verifier: zotero.authorize(fresh),
          state: lastCallbackState(),
          ...query,
        })
        .header('authorization', bearer(who, sid))
    }
    ;(await retry(other, 'sess_a', {})).assertStatus(400)
    ;(await retry(user, 'sess_a', { state: 'forged-state' })).assertStatus(400)
    // Le bon parcours aboutit toujours.
    ;(await retry(user, 'sess_a', {})).assertStatus(200)
  })

  test('refuses an expired authorization request', async ({ client }) => {
    const user = await createUser()
    const started = await client
      .post('/api/v1/me/integrations/zotero/connect')
      .header('authorization', bearer(user, 'sess_a'))
    const token =
      new URL(zoteroConnectResponseSchema.parse(started.body()).authorizeUrl).searchParams.get(
        'oauth_token',
      ) ?? ''
    await ZoteroOAuthRequest.query()
      .where('userId', user.id)
      .update({ expiresAt: DateTime.utc().minus({ minutes: 1 }).toJSDate() })
    const done = await client
      .get('/api/v1/integrations/zotero/callback')
      .qs({
        oauth_token: token,
        oauth_verifier: zotero.authorize(token),
        state: lastCallbackState(),
      })
      .header('authorization', bearer(user, 'sess_a'))
    done.assertStatus(400)
    done.assertBodyContains({ code: 'E_ZOTERO_OAUTH_STATE' })
  })

  test('lists libraries and collections', async ({ client, assert }) => {
    const user = await createUser()
    const before = await client.get('/api/v1/me/integrations/zotero/libraries').loginAs(user)
    before.assertStatus(409)
    before.assertBodyContains({ code: 'E_ZOTERO_NOT_CONNECTED' })
    await connect(client, user)
    const libraries = zoteroLibrariesResponseSchema.parse(
      (await client.get('/api/v1/me/integrations/zotero/libraries').loginAs(user)).body(),
    ).libraries
    assert.deepEqual(
      libraries.map((library) => [library.type, library.id]),
      [
        ['user', FAKE_ZOTERO_USER.id],
        ['group', FAKE_GROUP.id],
      ],
    )
    const collections = zoteroCollectionsResponseSchema.parse(
      (
        await client
          .get(`/api/v1/me/integrations/zotero/libraries/group/${FAKE_GROUP.id}/collections`)
          .loginAs(user)
      ).body(),
    ).collections
    assert.deepEqual(collections, [{ key: 'GRUP2345', name: 'Lab papers', parentKey: null }])
    const invalid = await client
      .get('/api/v1/me/integrations/zotero/libraries/team/1/collections')
      .loginAs(user)
    invalid.assertStatus(422)
  })

  test('disconnects: revokes the key at Zotero and erases it everywhere', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const key = await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await linkCollection(client, user, project.id)

    const removed = await client.delete('/api/v1/me/integrations/zotero').loginAs(user)
    removed.assertStatus(204)
    assert.deepEqual(zotero.revokedKeys, [key])
    assert.isNull(await ZoteroAccount.findBy('userId', user.id))
    const link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.isNull(link.apiKey)
    assert.equal(link.lastError, 'E_ZOTERO_KEY_INVALID')
    ;(await client.delete('/api/v1/me/integrations/zotero').loginAs(user)).assertStatus(204)

    // Lien sans clé : synchro refusée, à l'ouverture ignorée.
    const sync = await client
      .post(`/api/v1/projects/${project.id}/zotero/sync`)
      .json({ trigger: 'manual' })
      .loginAs(user)
    sync.assertStatus(409)
    sync.assertBodyContains({ code: 'E_ZOTERO_KEY_INVALID' })

    // Reconnexion : la nouvelle clé reprend ses liens.
    const fresh = await connect(client, user)
    await link.refresh()
    assert.equal(link.apiKey, fresh)
    assert.isNull(link.lastError)
  })

  test('erases the Zotero account of a deleted user and revokes its key', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const key = await connect(client, user)
    const body = JSON.stringify({
      type: 'user.deleted',
      object: 'event',
      data: { id: user.clerkUserId, deleted: true },
      timestamp: Date.now(),
    })
    const deleted = await client
      .post('/api/v1/webhooks/clerk')
      .headers({
        ...signWebhook(body, undefined, `msg_${randomUUID()}`),
        'content-type': 'application/json',
      })
      .json(JSON.parse(body) as object)
    deleted.assertStatus(204)
    assert.isNull(await ZoteroAccount.findBy('userId', user.id))
    // Révoquée chez Zotero (`DELETE /keys/current`) une fois la suppression validée.
    assert.deepEqual(zotero.revokedKeys, [key])
    const revocation = zotero.apiCalls('/keys/current').at(-1)
    assert.equal(revocation?.method, 'DELETE')
    assert.equal(revocation?.headers.get('zotero-api-key'), key)
  })

  test('revokes the previous key when the account reconnects', async ({ client, assert }) => {
    const user = await createUser()
    const first = await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await linkCollection(client, user, project.id)
    const second = await connect(client, user)
    assert.notEqual(first, second)
    // L'ancienne clé, que plus aucun lien n'utilise, est révoquée ; le lien prend la nouvelle.
    assert.deepEqual(zotero.revokedKeys, [first])
    const link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.equal(link.apiKey, second)
  })

  test('respects a pause requested while listing libraries', async ({ client, assert }) => {
    const user = await createUser()
    await connect(client, user)
    zotero.addHeadersOnce('/groups', { backoff: '60' })
    const listed = await client.get('/api/v1/me/integrations/zotero/libraries').loginAs(user)
    listed.assertStatus(200)
    const account = await ZoteroAccount.findByOrFail('userId', user.id)
    assert.isNotNull(account.backoffUntil)
    const calls = zotero.requests.length
    const again = await client.get('/api/v1/me/integrations/zotero/libraries').loginAs(user)
    again.assertStatus(429)
    again.assertBodyContains({ code: 'E_ZOTERO_BACKOFF' })
    const collections = await client
      .get(`/api/v1/me/integrations/zotero/libraries/user/${FAKE_ZOTERO_USER.id}/collections`)
      .loginAs(user)
    collections.assertStatus(429)
    assert.equal(zotero.requests.length, calls)
  })
})

test.group('zotero: project link and synchronization', (group) => {
  useFakes(group)

  test('links a collection and writes the managed .bib', async ({ client, assert }) => {
    const user = await createUser()
    const key = await connect(client, user)
    const project = await createProject(user, 'Thesis')
    const { link } = await linkCollection(client, user, project.id)
    assert.isNotNull(link)
    assert.equal(link?.syncStatus, 'idle')
    assert.equal(link?.collectionName, 'Thesis')
    assert.equal(link?.documentPath, 'references.bib')
    assert.equal(link?.lastLibraryVersion, 10)
    assert.isTrue(link?.hasKey)
    assert.notInclude(JSON.stringify(link), key)

    const text = await bibText(project.id)
    assert.isTrue(text.startsWith(MANAGED_BIB_HEADER))
    assert.include(text, '@article{lovelace_notes_1843,')
    assert.notInclude(text, 'babbage_passages_1864')
    // Écrit au nom du membre, annoncé aux clients connectés (arborescence, état du lien).
    assert.equal(realtime.replaced[0]?.request.userId, user.id)
    assert.includeMembers(
      realtime.events.map((event) => event.type),
      ['tree.changed', 'zotero.updated'],
    )
    // Export biblatex de la collection, élément par élément, avec l'en-tête de version de l'API.
    const exportCall = zotero.apiCalls('/collections/THES2345/items/top')[0]
    assert.equal(exportCall?.url.searchParams.get('include'), 'biblatex')
    assert.equal(exportCall?.headers.get('zotero-api-version'), '3')

    // La clé est aussi chiffrée sur le lien.
    const raw = await db
      .from('zotero_links')
      .where('project_id', project.id)
      .select('api_key_encrypted')
      .firstOrFail()
    assert.notInclude(JSON.stringify(raw), key)
  })

  test('synchronizes idempotently and skips unchanged libraries', async ({ client, assert }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await linkCollection(client, user, project.id)
    const firstText = await bibText(project.id)

    // À la demande : export complet, même texte, rien de réécrit.
    const again = await client
      .post(`/api/v1/projects/${project.id}/zotero/sync`)
      .json({ trigger: 'manual' })
      .loginAs(user)
    again.assertStatus(200)
    assert.equal(zoteroSyncResponseSchema.parse(again.body()).outcome, 'unchanged')
    assert.equal(await bibText(project.id), firstText)
    const updates = await db
      .from('document_updates')
      .where('project_id', project.id)
      .count('* as n')
    const before = Number((updates[0] as { n: string }).n)

    // À l'ouverture juste après : tentative récente, rien n'est demandé à Zotero.
    const calls = zotero.requests.length
    const opened = await client
      .post(`/api/v1/projects/${project.id}/zotero/sync`)
      .json({ trigger: 'open' })
      .loginAs(user)
    assert.equal(zoteroSyncResponseSchema.parse(opened.body()).outcome, 'skipped')
    assert.equal(zotero.requests.length, calls)

    // Plus tard, bibliothèque inchangée : une requête conditionnelle (304), rien d'écrit.
    const later = DateTime.utc().plus({ minutes: 20 })
    const unchanged = await syncProjectZotero(
      { zotero: zotero.client(), realtime },
      user,
      project.id,
      'open',
      later,
    )
    assert.equal(unchanged.outcome, 'unchanged')
    const conditional = zotero.apiCalls('/items/top').at(-1)
    assert.equal(conditional?.headers.get('if-modified-since-version'), '10')
    const after = await db.from('document_updates').where('project_id', project.id).count('* as n')
    assert.equal(Number((after[0] as { n: string }).n), before)

    // Nouvelle référence dans la collection : nouvelle version, le .bib suit.
    zotero.libraryVersion = 11
    const item = zotero.items.find((entry) => entry.key === 'BBBB3333')
    item?.collections.push('THES2345')
    const updated = await syncProjectZotero(
      { zotero: zotero.client(), realtime },
      user,
      project.id,
      'open',
      later.plus({ minutes: 20 }),
    )
    assert.equal(updated.outcome, 'updated')
    assert.equal(updated.link?.lastLibraryVersion, 11)
    assert.include(await bibText(project.id), 'babbage_passages_1864')
  })

  test('respects Backoff and Retry-After from Zotero', async ({ client, assert }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await linkCollection(client, user, project.id)

    // 429 avec Retry-After : erreur enregistrée, pause respectée sans nouvel appel.
    zotero.respondOnce('/items/top', 429, { 'retry-after': '120' })
    const limited = await client
      .post(`/api/v1/projects/${project.id}/zotero/sync`)
      .json({ trigger: 'manual' })
      .loginAs(user)
    limited.assertStatus(429)
    limited.assertBodyContains({ code: 'E_ZOTERO_BACKOFF', retryAfterSeconds: 120 })
    assert.equal(limited.header('retry-after'), '120')
    const link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.equal(link.syncStatus, 'error')
    assert.equal(link.lastError, 'E_ZOTERO_BACKOFF')
    assert.isNotNull(link.backoffUntil)

    const calls = zotero.requests.length
    const refused = await client
      .post(`/api/v1/projects/${project.id}/zotero/sync`)
      .json({ trigger: 'manual' })
      .loginAs(user)
    refused.assertStatus(429)
    const search = await client
      .get(`/api/v1/projects/${project.id}/zotero/search`)
      .qs({ q: 'engine' })
      .loginAs(user)
    search.assertStatus(429)
    assert.equal(zotero.requests.length, calls)

    // La pause vaut pour la clé : la liste des bibliothèques attend aussi.
    const libraries = await client.get('/api/v1/me/integrations/zotero/libraries').loginAs(user)
    libraries.assertStatus(429)
    assert.equal(zotero.requests.length, calls)

    // Pause écoulée ; un `Backoff` sur une réponse réussie est retenu pour la suite.
    await ZoteroLink.query().where('id', link.id).update({ backoffUntil: null })
    await ZoteroAccount.query().where('userId', user.id).update({ backoffUntil: null })
    zotero.addHeadersOnce('/items/top', { backoff: '30' })
    const done = await client
      .post(`/api/v1/projects/${project.id}/zotero/sync`)
      .json({ trigger: 'manual' })
      .loginAs(user)
    done.assertStatus(200)
    const synced = zoteroSyncResponseSchema.parse(done.body()).link
    assert.equal(synced?.syncStatus, 'idle')
    assert.isNull(synced?.lastError)
    assert.isNotNull(synced?.backoffUntil)
  })

  test('reports a revoked key and a missing library', async ({ client, assert }) => {
    const user = await createUser()
    const key = await connect(client, user)
    const project = await createProject(user, 'Thesis')
    const missing = await client
      .put(`/api/v1/projects/${project.id}/zotero`)
      .json({
        libraryType: 'group',
        libraryId: '999',
        collectionKey: null,
        target: { kind: 'new', name: 'refs.bib', folderId: null },
      })
      .loginAs(user)
    missing.assertStatus(404)
    missing.assertBodyContains({ code: 'E_ZOTERO_LIBRARY_NOT_FOUND' })
    const otherUser = await client
      .put(`/api/v1/projects/${project.id}/zotero`)
      .json({
        libraryType: 'user',
        libraryId: '1',
        collectionKey: null,
        target: { kind: 'new', name: 'refs.bib', folderId: null },
      })
      .loginAs(user)
    otherUser.assertStatus(404)

    await linkCollection(client, user, project.id)
    // Clé révoquée depuis zotero.org.
    zotero.validKeys.delete(key)
    const sync = await client
      .post(`/api/v1/projects/${project.id}/zotero/sync`)
      .json({ trigger: 'manual' })
      .loginAs(user)
    sync.assertStatus(409)
    sync.assertBodyContains({ code: 'E_ZOTERO_KEY_INVALID' })
    const link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.equal(link.lastError, 'E_ZOTERO_KEY_INVALID')
    assert.equal(link.syncStatus, 'error')
  })

  test('links a group library into an existing .bib', async ({ client, assert }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    const created = await client
      .post(`/api/v1/projects/${project.id}/documents`)
      .json({ name: 'lab.bib', folderId: null, content: '% vide\n' })
      .loginAs(user)
    const documentId = String(created.body().document.id)
    const notBib = await Document.query()
      .where({ projectId: project.id })
      .whereNot('id', documentId)
      .firstOrFail()
    const refused = await client
      .put(`/api/v1/projects/${project.id}/zotero`)
      .json({
        libraryType: 'group',
        libraryId: FAKE_GROUP.id,
        collectionKey: null,
        target: { kind: 'existing', documentId: notBib.id },
      })
      .loginAs(user)
    refused.assertStatus(422)
    refused.assertBodyContains({ code: 'E_ZOTERO_INVALID_TARGET' })

    const linked = await client
      .put(`/api/v1/projects/${project.id}/zotero`)
      .json({
        libraryType: 'group',
        libraryId: FAKE_GROUP.id,
        collectionKey: null,
        target: { kind: 'existing', documentId },
        exportFormat: 'bibtex',
      })
      .loginAs(user)
    linked.assertStatus(200)
    const link = projectZoteroResponseSchema.parse(linked.body()).link
    assert.equal(link?.libraryName, FAKE_GROUP.name)
    assert.equal(link?.exportFormat, 'bibtex')
    assert.include(await bibText(project.id, 'lab.bib'), 'menabrea_sketch_1842')
    assert.equal(
      zotero.apiCalls(`/groups/${FAKE_GROUP.id}/items/top`)[0]?.url.searchParams.get('include'),
      'bibtex',
    )

    const removed = await client.delete(`/api/v1/projects/${project.id}/zotero`).loginAs(user)
    removed.assertStatus(204)
    assert.isNull(await ZoteroLink.findBy('projectId', project.id))
    // Le .bib reste.
    assert.include(await bibText(project.id, 'lab.bib'), 'menabrea_sketch_1842')
    assert.deepEqual(realtime.events.at(-1), {
      type: 'zotero.updated',
      actorId: user.id,
      link: null,
    })
  })

  test('requires edit to link, sync and search; uses the key of the member who linked', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const ownerKey = await connect(client, owner)
    const project = await createProject(owner, 'Thesis')
    await linkCollection(client, owner, project.id)
    const editor = await createUser()
    const reviewer = await createUser()
    const viewer = await createUser()
    const stranger = await createUser()
    await ProjectMember.create({ projectId: project.id, userId: editor.id, role: 'editor' })
    await ProjectMember.create({ projectId: project.id, userId: reviewer.id, role: 'reviewer' })
    await ProjectMember.create({ projectId: project.id, userId: viewer.id, role: 'viewer' })

    // Lecture du lien : tout membre ; non-membre : 404.
    ;(await client.get(`/api/v1/projects/${project.id}/zotero`).loginAs(viewer)).assertStatus(200)
    ;(await client.get(`/api/v1/projects/${project.id}/zotero`).loginAs(stranger)).assertStatus(404)
    for (const member of [reviewer, viewer]) {
      ;(
        await client
          .post(`/api/v1/projects/${project.id}/zotero/sync`)
          .json({ trigger: 'manual' })
          .loginAs(member)
      ).assertStatus(403)
      ;(
        await client
          .get(`/api/v1/projects/${project.id}/zotero/search`)
          .qs({ q: 'ada' })
          .loginAs(member)
      ).assertStatus(403)
      ;(
        await client
          .post(`/api/v1/projects/${project.id}/zotero/citations`)
          .json({ itemKey: 'BBBB3333' })
          .loginAs(member)
      ).assertStatus(403)
      ;(await client.delete(`/api/v1/projects/${project.id}/zotero`).loginAs(member)).assertStatus(
        403,
      )
    }
    // Un éditeur sans compte Zotero rafraîchit avec la clé du propriétaire du lien…
    const synced = await client
      .post(`/api/v1/projects/${project.id}/zotero/sync`)
      .json({ trigger: 'manual' })
      .loginAs(editor)
    synced.assertStatus(200)
    assert.equal(zotero.apiCalls('/items/top').at(-1)?.headers.get('zotero-api-key'), ownerKey)
    // …mais ne peut pas lier sans connecter son propre compte.
    const relink = await client
      .put(`/api/v1/projects/${project.id}/zotero`)
      .json({
        libraryType: 'user',
        libraryId: FAKE_ZOTERO_USER.id,
        collectionKey: null,
        target: { kind: 'new', name: 'references.bib', folderId: null },
      })
      .loginAs(editor)
    relink.assertStatus(409)
    relink.assertBodyContains({ code: 'E_ZOTERO_NOT_CONNECTED' })
    const viewerLink = await client
      .put(`/api/v1/projects/${project.id}/zotero`)
      .json({
        libraryType: 'user',
        libraryId: FAKE_ZOTERO_USER.id,
        collectionKey: null,
        target: { kind: 'new', name: 'references.bib', folderId: null },
      })
      .loginAs(viewer)
    viewerLink.assertStatus(403)
  })

  test('searches the linked library and adds a missing entry', async ({ client, assert }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await linkCollection(client, user, project.id)

    const short = await client
      .get(`/api/v1/projects/${project.id}/zotero/search`)
      .qs({ q: 'a' })
      .loginAs(user)
    short.assertStatus(422)
    const found = await client
      .get(`/api/v1/projects/${project.id}/zotero/search`)
      .qs({ q: 'lovelace' })
      .loginAs(user)
    found.assertStatus(200)
    const items = zoteroSearchResponseSchema.parse(found.body()).items
    assert.deepEqual(
      items.map((item) => [item.itemKey, item.citationKey, item.inBibliography, item.creators]),
      [['AAAA2222', 'lovelace_notes_1843', true, 'Lovelace']],
    )
    const babbage = zoteroSearchResponseSchema.parse(
      (
        await client
          .get(`/api/v1/projects/${project.id}/zotero/search`)
          .qs({ q: 'babbage' })
          .loginAs(user)
      ).body(),
    ).items[0]
    assert.equal(babbage?.year, '1864')
    assert.isFalse(babbage?.inBibliography)

    const added = await client
      .post(`/api/v1/projects/${project.id}/zotero/citations`)
      .json({ itemKey: 'BBBB3333' })
      .loginAs(user)
    added.assertStatus(200)
    assert.deepEqual(addZoteroCitationResponseSchema.parse(added.body()), {
      citationKey: 'babbage_passages_1864',
      added: true,
    })
    const text = await bibText(project.id)
    assert.include(text, '@article{babbage_passages_1864,')
    assert.include(text, 'lovelace_notes_1843')
    const twice = await client
      .post(`/api/v1/projects/${project.id}/zotero/citations`)
      .json({ itemKey: 'BBBB3333' })
      .loginAs(user)
    assert.isFalse(addZoteroCitationResponseSchema.parse(twice.body()).added)
    assert.equal(await bibText(project.id), text)

    // Hors de la collection : retenu, la synchro suivante le garde.
    const link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.deepEqual(link.pickedItemKeys, ['BBBB3333'])
    ;(
      await client
        .post(`/api/v1/projects/${project.id}/zotero/sync`)
        .json({ trigger: 'manual' })
        .loginAs(user)
    ).assertStatus(200)
    assert.include(await bibText(project.id), 'babbage_passages_1864')

    const unknown = await client
      .post(`/api/v1/projects/${project.id}/zotero/citations`)
      .json({ itemKey: 'ZZZZ9999' })
      .loginAs(user)
    unknown.assertStatus(404)
    unknown.assertBodyContains({ code: 'E_ZOTERO_ITEM_NOT_FOUND' })

    // Service temps réel indisponible : rien n'est écrit.
    realtime.unavailable = true
    const offline = await client
      .post(`/api/v1/projects/${project.id}/zotero/citations`)
      .json({ itemKey: 'AAAA2222' })
      .loginAs(user)
    offline.assertStatus(503)
    offline.assertBodyContains({ code: 'E_ZOTERO_REALTIME_UNAVAILABLE' })
  })

  test('refuses a second synchronization while one is running', async ({ client }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await linkCollection(client, user, project.id)
    await ZoteroLink.query()
      .where('projectId', project.id)
      .update({
        syncStatus: 'syncing',
        syncStartedAt: DateTime.utc().minus({ minutes: 1 }).toJSDate(),
      })
    const busy = await client
      .post(`/api/v1/projects/${project.id}/zotero/sync`)
      .json({ trigger: 'manual' })
      .loginAs(user)
    busy.assertStatus(409)
    busy.assertBodyContains({ code: 'E_ZOTERO_SYNC_IN_PROGRESS' })
    // Synchro abandonnée (processus arrêté) : reprise après le délai.
    await ZoteroLink.query()
      .where('projectId', project.id)
      .update({ syncStartedAt: DateTime.utc().minus({ minutes: 10 }).toJSDate() })
    ;(
      await client
        .post(`/api/v1/projects/${project.id}/zotero/sync`)
        .json({ trigger: 'manual' })
        .loginAs(user)
    ).assertStatus(200)
  })

  test('stops using the key of a member who left, was removed or lost edit', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const editor = await createUser()
    const other = await createUser()
    const project = await createProject(owner, 'Thesis')
    await ProjectMember.create({ projectId: project.id, userId: editor.id, role: 'editor' })
    await ProjectMember.create({ projectId: project.id, userId: other.id, role: 'editor' })
    await connect(client, editor)
    await linkCollection(client, editor, project.id)
    const sync = () =>
      client
        .post(`/api/v1/projects/${project.id}/zotero/sync`)
        .json({ trigger: 'manual' })
        .loginAs(other)
    const search = () =>
      client.get(`/api/v1/projects/${project.id}/zotero/search`).qs({ q: 'babbage' }).loginAs(other)
    ;(await sync()).assertStatus(200)

    // Passé lecteur : sa clé est effacée du lien, les autres éditeurs ne s'en servent plus.
    ;(
      await client
        .patch(`/api/v1/projects/${project.id}/members/${editor.id}`)
        .json({ role: 'viewer' })
        .loginAs(owner)
    ).assertStatus(200)
    let link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.isNull(link.apiKey)
    assert.equal(link.lastError, 'E_ZOTERO_KEY_INVALID')
    const calls = zotero.requests.length
    for (const response of [await sync(), await search()]) {
      response.assertStatus(409)
      response.assertBodyContains({ code: 'E_ZOTERO_KEY_INVALID' })
    }
    ;(
      await client
        .post(`/api/v1/projects/${project.id}/zotero/citations`)
        .json({ itemKey: 'BBBB3333' })
        .loginAs(other)
    ).assertStatus(409)
    assert.equal(zotero.requests.length, calls)

    // De nouveau éditeur : il reconnecte Zotero, sa nouvelle clé reprend le lien.
    await ProjectMember.query()
      .where({ projectId: project.id, userId: editor.id })
      .update({ role: 'editor' })
    await connect(client, editor)
    await link.refresh()
    assert.isNotNull(link.apiKey)
    ;(await sync()).assertStatus(200)

    // Retiré du projet : même chose.
    ;(
      await client.delete(`/api/v1/projects/${project.id}/members/${editor.id}`).loginAs(owner)
    ).assertStatus(204)
    link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.isNull(link.apiKey)
    ;(await search()).assertStatus(409)
    // Une reconnexion ne rend pas sa clé à un projet qu'il a quitté.
    await connect(client, editor)
    await link.refresh()
    assert.isNull(link.apiKey)

    // Filet : un retrait qui n'est pas passé par le partage est vu à l'usage.
    await connect(client, other)
    await linkCollection(client, other, project.id)
    await ProjectMember.query().where({ projectId: project.id, userId: other.id }).delete()
    const ownerSync = await client
      .post(`/api/v1/projects/${project.id}/zotero/sync`)
      .json({ trigger: 'manual' })
      .loginAs(owner)
    ownerSync.assertStatus(409)
    ownerSync.assertBodyContains({ code: 'E_ZOTERO_KEY_INVALID' })
    await link.refresh()
    assert.isNull(link.apiKey)
  })

  test('keeps the first sync waiting when Zotero asks for a pause while linking', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    const link = (collectionKey: string | null) =>
      client
        .put(`/api/v1/projects/${project.id}/zotero`)
        .json({
          libraryType: 'group',
          libraryId: FAKE_GROUP.id,
          collectionKey,
          target: { kind: 'new', name: 'lab.bib', folderId: null },
        })
        .loginAs(user)
    zotero.addHeadersOnce('/groups', { backoff: '120' })
    const linked = await link(null)
    linked.assertStatus(200)
    const summary = projectZoteroResponseSchema.parse(linked.body()).link
    assert.isNotNull(summary?.backoffUntil)
    assert.isNull(summary?.lastSyncedAt)
    // Pas d'export pendant la pause : la première synchro attend.
    assert.lengthOf(zotero.apiCalls('/items/top'), 0)
    const calls = zotero.requests.length
    const sync = await client
      .post(`/api/v1/projects/${project.id}/zotero/sync`)
      .json({ trigger: 'manual' })
      .loginAs(user)
    sync.assertStatus(429)
    // Changer de collection pendant la pause : refusé sans appel à Zotero.
    const relinked = await link('GRUP2345')
    relinked.assertStatus(429)
    relinked.assertBodyContains({ code: 'E_ZOTERO_BACKOFF' })
    assert.equal(zotero.requests.length, calls)
  })

  test('refuses a new .bib whose name is already taken', async ({ client, assert }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await client
      .post(`/api/v1/projects/${project.id}/documents`)
      .json({ name: 'references.bib', folderId: null, content: '@misc{mine, title = {x}}\n' })
      .loginAs(user)
    const refused = await client
      .put(`/api/v1/projects/${project.id}/zotero`)
      .json({
        libraryType: 'user',
        libraryId: FAKE_ZOTERO_USER.id,
        collectionKey: 'THES2345',
        target: { kind: 'new', name: 'references.bib', folderId: null },
      })
      .loginAs(user)
    refused.assertStatus(409)
    refused.assertBodyContains({ code: 'E_ZOTERO_TARGET_EXISTS' })
    assert.include(await bibText(project.id), '@misc{mine')
    assert.isNull(await ZoteroLink.findBy('projectId', project.id))

    // Le `.bib` déjà lié peut être redonné comme « nouveau fichier » (relien).
    const other = await createProject(user, 'Other')
    await linkCollection(client, user, other.id)
    await linkCollection(client, user, other.id)
  })

  test('gives distinct items sharing a citation key distinct keys', async ({ client, assert }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    // Deux références distinctes, même clé produite par Zotero.
    zotero.items.push(
      {
        key: 'XXXX2222',
        citationKey: 'smith_2020',
        title: 'Article X',
        creators: [{ lastName: 'Smith', firstName: 'Ann' }],
        date: '2020',
        collections: ['THES2345'],
        library: 'user',
      },
      {
        key: 'YYYY3333',
        citationKey: 'smith_2020',
        title: 'Article Y',
        creators: [{ lastName: 'Smith', firstName: 'Ann' }],
        date: '2020',
        collections: [],
        library: 'user',
      },
    )
    await linkCollection(client, user, project.id)
    const found = zoteroSearchResponseSchema.parse(
      (
        await client
          .get(`/api/v1/projects/${project.id}/zotero/search`)
          .qs({ q: 'smith' })
          .loginAs(user)
      ).body(),
    ).items
    const byKey = Object.fromEntries(found.map((item) => [item.itemKey, item]))
    assert.equal(byKey.XXXX2222?.citationKey, 'smith_2020')
    assert.isTrue(byKey.XXXX2222?.inBibliography)
    // Y n'est pas dans le .bib : la clé proposée est celle qu'il y prendra.
    assert.equal(byKey.YYYY3333?.citationKey, 'smith_2020a')
    assert.isFalse(byKey.YYYY3333?.inBibliography)

    const added = await client
      .post(`/api/v1/projects/${project.id}/zotero/citations`)
      .json({ itemKey: 'YYYY3333' })
      .loginAs(user)
    assert.deepEqual(addZoteroCitationResponseSchema.parse(added.body()), {
      citationKey: 'smith_2020a',
      added: true,
    })
    const text = await bibText(project.id)
    assert.include(text, '@article{smith_2020,\n\ttitle = {Article X}')
    assert.include(text, '@article{smith_2020a,\n\ttitle = {Article Y}')

    // La synchro garde les deux, avec les mêmes clés.
    ;(
      await client
        .post(`/api/v1/projects/${project.id}/zotero/sync`)
        .json({ trigger: 'manual' })
        .loginAs(user)
    ).assertStatus(200)
    assert.equal(await bibText(project.id), text)
    const link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.equal(link.citationKeys.YYYY3333, 'smith_2020a')
    assert.equal(link.citationKeys.XXXX2222, 'smith_2020')
  })

  test('keeps a citation added while a synchronization runs', async ({ client, assert }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await linkCollection(client, user, project.id)
    const deps = { zotero: zotero.client(), realtime }
    // Pendant l'export de la synchro, un membre ajoute une référence hors collection.
    zotero.duringNext('/collections/THES2345/items/top', async () => {
      const added = await addZoteroCitation(deps, user, project.id, 'BBBB3333')
      assert.isTrue(added.added)
    })
    const synced = await syncProjectZotero(deps, user, project.id, 'manual')
    // Le .bib avait déjà l'entrée ajoutée : la synchro l'a gardée, rien d'autre à écrire.
    assert.equal(synced.outcome, 'unchanged')
    const text = await bibText(project.id)
    assert.include(text, 'babbage_passages_1864')
    assert.include(text, 'lovelace_notes_1843')
    const link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.deepEqual(link.pickedItemKeys, ['BBBB3333'])

    // Deux ajouts l'un après l'autre : les deux entrées et les deux éléments restent.
    zotero.items.push({
      key: 'DDDD5555',
      citationKey: 'hopper_compiler_1952',
      title: 'The Education of a Computer',
      creators: [{ lastName: 'Hopper', firstName: 'Grace' }],
      date: '1952',
      collections: [],
      library: 'user',
    })
    await addZoteroCitation(deps, user, project.id, 'DDDD5555')
    await link.refresh()
    assert.deepEqual(link.pickedItemKeys, ['BBBB3333', 'DDDD5555'])
    const after = await bibText(project.id)
    assert.include(after, 'babbage_passages_1864')
    assert.include(after, 'hopper_compiler_1952')
  })

  test('writes nothing when the link changes during a synchronization', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await linkCollection(client, user, project.id)
    const deps = { zotero: zotero.client(), realtime }
    zotero.libraryVersion = 12
    zotero.items.find((item) => item.key === 'BBBB3333')?.collections.push('THES2345')
    const writes = realtime.replaced.length

    // Lien refait vers le groupe pendant l'export : l'ancienne synchro n'écrit rien.
    zotero.duringNext('/collections/THES2345/items/top', async () => {
      await ZoteroLink.query().where('projectId', project.id).update({
        libraryType: 'group',
        libraryId: FAKE_GROUP.id,
        collectionKey: null,
        syncStatus: 'idle',
        syncStartedAt: null,
        lastLibraryVersion: null,
      })
    })
    const superseded = await syncProjectZotero(deps, user, project.id, 'manual')
    assert.equal(superseded.outcome, 'skipped')
    assert.equal(realtime.replaced.length, writes)
    const link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.isNull(link.lastLibraryVersion)
    assert.equal(link.syncStatus, 'idle')

    // Lien supprimé pendant l'export : rien n'est écrit ni annoncé.
    await ZoteroLink.query().where('projectId', project.id).update({
      libraryType: 'user',
      libraryId: FAKE_ZOTERO_USER.id,
      collectionKey: 'THES2345',
    })
    const events = realtime.events.length
    zotero.duringNext('/collections/THES2345/items/top', async () => {
      await ZoteroLink.query().where('projectId', project.id).delete()
    })
    const removed = await syncProjectZotero(deps, user, project.id, 'manual')
    assert.deepEqual(removed, { outcome: 'skipped', link: null })
    assert.equal(realtime.replaced.length, writes)
    assert.equal(realtime.events.length, events)
  })
})

test.group('zotero: scope, rights and concurrency', (group) => {
  useFakes(group)

  test('exports the items of the subcollections of the linked collection', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    // « Thesis » n'a aucun élément direct : tout est dans ses sous-collections.
    zotero.collections.push(
      { key: 'CHAP2345', name: 'Chapitre 1', library: 'user', parentKey: 'THES2345' },
      { key: 'SECT2345', name: 'Section', library: 'user', parentKey: 'CHAP2345' },
    )
    for (const item of zotero.items) {
      if (item.key === 'AAAA2222') item.collections = ['SECT2345']
      if (item.key === 'BBBB3333') item.collections = ['CHAP2345', 'SECT2345']
    }
    await linkCollection(client, user, project.id)
    const text = await bibText(project.id)
    assert.include(text, '@article{lovelace_notes_1843,')
    // Présent dans deux sous-collections : une seule entrée.
    assert.equal(text.split('@article{babbage_passages_1864,').length, 2)
    const link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.deepEqual(link.collectionScope, ['THES2345', 'CHAP2345', 'SECT2345'])

    // Bibliothèque inchangée : une seule requête conditionnelle (304), sous-collections comprises.
    const calls = zotero.requests.length
    const later = await syncProjectZotero(
      { zotero: zotero.client(), realtime },
      user,
      project.id,
      'open',
      DateTime.utc().plus({ minutes: 20 }),
    )
    assert.equal(later.outcome, 'unchanged')
    assert.equal(zotero.requests.length, calls + 1)
  })

  test('offers and links only the libraries the key can read', async ({ client, assert }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    const libraries = async () =>
      zoteroLibrariesResponseSchema
        .parse((await client.get('/api/v1/me/integrations/zotero/libraries').loginAs(user)).body())
        .libraries.map((library) => library.type)

    // Bibliothèque personnelle refusée sur zotero.org, groupes gardés.
    zotero.access = { user: false, groups: 'all' }
    assert.deepEqual(await libraries(), ['group'])
    const refused = await client
      .put(`/api/v1/projects/${project.id}/zotero`)
      .json({
        libraryType: 'user',
        libraryId: FAKE_ZOTERO_USER.id,
        collectionKey: null,
        target: { kind: 'new', name: 'references.bib', folderId: null },
      })
      .loginAs(user)
    refused.assertStatus(403)
    refused.assertBodyContains({ code: 'E_ZOTERO_LIBRARY_FORBIDDEN' })
    assert.isNull(await ZoteroLink.findBy('projectId', project.id))

    // Aucun groupe gardé.
    zotero.access = { user: true, groups: [] }
    assert.deepEqual(await libraries(), ['user'])
    const collections = await client
      .get(`/api/v1/me/integrations/zotero/libraries/group/${FAKE_GROUP.id}/collections`)
      .loginAs(user)
    collections.assertStatus(403)
    collections.assertBodyContains({ code: 'E_ZOTERO_LIBRARY_FORBIDDEN' })
  })

  test('reports a refused library apart from a revoked key', async ({ client, assert }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await linkCollection(client, user, project.id)
    // Droits réduits sur zotero.org après le lien : la clé reste valide.
    zotero.access = { user: false, groups: 'all' }
    const sync = await client
      .post(`/api/v1/projects/${project.id}/zotero/sync`)
      .json({ trigger: 'manual' })
      .loginAs(user)
    sync.assertStatus(403)
    sync.assertBodyContains({ code: 'E_ZOTERO_LIBRARY_FORBIDDEN' })
    const link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.equal(link.lastError, 'E_ZOTERO_LIBRARY_FORBIDDEN')
    assert.isNotNull(link.apiKey)
    const search = await client
      .get(`/api/v1/projects/${project.id}/zotero/search`)
      .qs({ q: 'babbage' })
      .loginAs(user)
    search.assertStatus(403)
    search.assertBodyContains({ code: 'E_ZOTERO_LIBRARY_FORBIDDEN' })
  })

  test('limits the search and picks of other editors to the linked collection', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const editor = await createUser()
    const project = await createProject(owner, 'Thesis')
    await ProjectMember.create({ projectId: project.id, userId: editor.id, role: 'editor' })
    await connect(client, owner)
    await linkCollection(client, owner, project.id)
    const search = async (who: User, q: string) =>
      zoteroSearchResponseSchema
        .parse(
          (
            await client.get(`/api/v1/projects/${project.id}/zotero/search`).qs({ q }).loginAs(who)
          ).body(),
        )
        .items.map((item) => item.itemKey)
    const add = (who: User, itemKey: string) =>
      client.post(`/api/v1/projects/${project.id}/zotero/citations`).json({ itemKey }).loginAs(who)

    // L'autre éditeur ne voit ni n'ajoute rien hors de la collection liée.
    assert.deepEqual(await search(editor, 'lovelace'), ['AAAA2222'])
    assert.deepEqual(await search(editor, 'babbage'), [])
    const refused = await add(editor, 'BBBB3333')
    refused.assertStatus(404)
    refused.assertBodyContains({ code: 'E_ZOTERO_ITEM_NOT_FOUND' })
    assert.notInclude(await bibText(project.id), 'babbage_passages_1864')

    // Le membre qui a lié cherche dans toute sa bibliothèque et peut ajouter hors collection.
    assert.deepEqual(await search(owner, 'babbage'), ['BBBB3333'])
    ;(await add(owner, 'BBBB3333')).assertStatus(200)
    // Une fois ajouté, l'élément est visible de tous les éditeurs.
    assert.deepEqual(await search(editor, 'babbage'), ['BBBB3333'])
    const again = await add(editor, 'BBBB3333')
    again.assertStatus(200)
    assert.isFalse(addZoteroCitationResponseSchema.parse(again.body()).added)
  })

  test('refuses a pick beyond the limit and does not keep items of the collection', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await linkCollection(client, user, project.id)
    const full = Array.from({ length: 500 }, (_, index) => `PICK${String(index).padStart(4, '0')}`)
    await db
      .from('zotero_links')
      .where('project_id', project.id)
      .update({ picked_item_keys: JSON.stringify(full) })
    const before = await bibText(project.id)

    const refused = await client
      .post(`/api/v1/projects/${project.id}/zotero/citations`)
      .json({ itemKey: 'BBBB3333' })
      .loginAs(user)
    refused.assertStatus(422)
    refused.assertBodyContains({ code: 'E_ZOTERO_PICKED_LIMIT' })
    assert.equal(await bibText(project.id), before)

    // Élément de la collection (arrivé depuis la synchro) : ajouté sans compter dans la limite.
    zotero.items.push({
      key: 'EEEE6666',
      citationKey: 'hopper_compiler_1952',
      title: 'The Education of a Computer',
      creators: [{ lastName: 'Hopper', firstName: 'Grace' }],
      date: '1952',
      collections: ['THES2345'],
      library: 'user',
    })
    const added = await client
      .post(`/api/v1/projects/${project.id}/zotero/citations`)
      .json({ itemKey: 'EEEE6666' })
      .loginAs(user)
    added.assertStatus(200)
    const link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.lengthOf(link.pickedItemKeys, 500)
    assert.notInclude(link.pickedItemKeys, 'EEEE6666')
    assert.equal(link.citationKeys.EEEE6666, 'hopper_compiler_1952')
  })

  test('appends an entry without overwriting a concurrent edit; retries are safe', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await linkCollection(client, user, project.id)
    const document = await Document.query()
      .where({ projectId: project.id, name: 'references.bib' })
      .firstOrFail()
    // Un collaborateur tape dans le .bib entre la lecture du texte et l'ajout.
    realtime.beforeNextReplace = async () => {
      const stored = await Document.findOrFail(document.id)
      const state = stored.yjsState ? new Uint8Array(stored.yjsState) : null
      const { state: next } = replaceStateText(state, `% note\n${readDocumentText(state)}`)
      await Document.query()
        .where('id', document.id)
        .update({ yjsState: Buffer.from(next) })
    }
    const added = await client
      .post(`/api/v1/projects/${project.id}/zotero/citations`)
      .json({ itemKey: 'BBBB3333' })
      .loginAs(user)
    added.assertStatus(200)
    assert.isTrue(realtime.replaced.at(-1)?.request.append)
    const text = await bibText(project.id)
    assert.isTrue(text.startsWith('% note\n'))
    assert.include(text, '@article{babbage_passages_1864,')

    // Écriture faite mais réponse perdue : 503, clé et élément retenus, un nouvel essai ne
    // duplique rien.
    zotero.items.push({
      key: 'DDDD5555',
      citationKey: 'hopper_compiler_1952',
      title: 'The Education of a Computer',
      creators: [{ lastName: 'Hopper', firstName: 'Grace' }],
      date: '1952',
      collections: [],
      library: 'user',
    })
    realtime.loseNextAnswer = true
    const uncertain = await client
      .post(`/api/v1/projects/${project.id}/zotero/citations`)
      .json({ itemKey: 'DDDD5555' })
      .loginAs(user)
    uncertain.assertStatus(503)
    uncertain.assertBodyContains({ code: 'E_ZOTERO_REALTIME_UNAVAILABLE' })
    const link = await ZoteroLink.findByOrFail('projectId', project.id)
    assert.equal(link.citationKeys.DDDD5555, 'hopper_compiler_1952')
    assert.include(link.pickedItemKeys, 'DDDD5555')
    const retried = await client
      .post(`/api/v1/projects/${project.id}/zotero/citations`)
      .json({ itemKey: 'DDDD5555' })
      .loginAs(user)
    assert.deepEqual(addZoteroCitationResponseSchema.parse(retried.body()), {
      citationKey: 'hopper_compiler_1952',
      added: false,
    })
    assert.equal((await bibText(project.id)).split('hopper_compiler_1952').length, 2)
  })

  test('exports late picks outside the lock of the link', async ({ client, assert }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await linkCollection(client, user, project.id)
    const deps = { zotero: zotero.client(), realtime }
    const link = await ZoteroLink.findByOrFail('projectId', project.id)
    let lockedMeanwhile: boolean | null = null
    zotero.duringNext('/collections/THES2345/items/top', async () => {
      await addZoteroCitation(deps, user, project.id, 'BBBB3333')
      // Export de l'élément choisi pendant la synchro : la ligne du lien n'est pas verrouillée.
      zotero.duringNext(`/users/${FAKE_ZOTERO_USER.id}/items`, async () => {
        lockedMeanwhile = await db.transaction(async (trx) => {
          try {
            await trx.rawQuery('SELECT id FROM zotero_links WHERE id = ? FOR UPDATE NOWAIT', [
              link.id,
            ])
            return false
          } catch {
            return true
          }
        })
      })
    })
    const synced = await syncProjectZotero(deps, user, project.id, 'manual')
    assert.isFalse(lockedMeanwhile)
    assert.include(['updated', 'unchanged'], synced.outcome)
    assert.include(await bibText(project.id), 'babbage_passages_1864')
  })

  test('keeps citation keys unique across the .bib files of the project', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    await connect(client, user)
    const project = await createProject(user, 'Thesis')
    await client
      .post(`/api/v1/projects/${project.id}/documents`)
      .json({
        name: 'manual.bib',
        folderId: null,
        content: '@misc{babbage_passages_1864, title = {Autre}}\n',
      })
      .loginAs(user)
    await linkCollection(client, user, project.id)
    const found = zoteroSearchResponseSchema.parse(
      (
        await client
          .get(`/api/v1/projects/${project.id}/zotero/search`)
          .qs({ q: 'babbage' })
          .loginAs(user)
      ).body(),
    ).items[0]
    assert.equal(found?.citationKey, 'babbage_passages_1864a')
    const added = await client
      .post(`/api/v1/projects/${project.id}/zotero/citations`)
      .json({ itemKey: 'BBBB3333' })
      .loginAs(user)
    assert.equal(
      addZoteroCitationResponseSchema.parse(added.body()).citationKey,
      'babbage_passages_1864a',
    )
    assert.include(await bibText(project.id), '@article{babbage_passages_1864a,')
  })

  test('serializes two OAuth callbacks of the same account', async ({ client, assert }) => {
    const user = await createUser()
    const start = async (sid: string) => {
      const started = await client
        .post('/api/v1/me/integrations/zotero/connect')
        .header('authorization', bearer(user, sid))
      started.assertStatus(200)
      const token =
        new URL(zoteroConnectResponseSchema.parse(started.body()).authorizeUrl).searchParams.get(
          'oauth_token',
        ) ?? ''
      return { sid, token, verifier: zotero.authorize(token), state: lastCallbackState() }
    }
    const first = await start('sess_a')
    await ZoteroOAuthRequest.query()
      .where('userId', user.id)
      .update({ createdAt: DateTime.utc().minus({ minutes: 1 }).toJSDate() })
    const second = await start('sess_b')
    const responses = await Promise.all(
      [first, second].map((pending) =>
        client
          .get('/api/v1/integrations/zotero/callback')
          .qs({
            oauth_token: pending.token,
            oauth_verifier: pending.verifier,
            state: pending.state,
          })
          .header('authorization', bearer(user, pending.sid)),
      ),
    )
    for (const response of responses) response.assertStatus(200)
    // Une seule clé gardée, l'autre révoquée chez Zotero.
    const account = await ZoteroAccount.findByOrFail('userId', user.id)
    assert.lengthOf(zotero.revokedKeys, 1)
    assert.notEqual(zotero.revokedKeys[0], account.apiKey)
    assert.isTrue(zotero.validKeys.has(account.apiKey ?? ''))
    assert.lengthOf(await ZoteroAccount.query().where('userId', user.id), 1)
  })

  test('limits pending OAuth requests per account', async ({ client, assert }) => {
    const user = await createUser()
    const start = (sid: string) =>
      client
        .post('/api/v1/me/integrations/zotero/connect')
        .header('authorization', bearer(user, sid))
    const age = () =>
      ZoteroOAuthRequest.query()
        .where('userId', user.id)
        .update({ createdAt: DateTime.utc().minus({ minutes: 1 }).toJSDate() })
    const requested = () =>
      zotero.requests.filter((request) => request.url.pathname === '/oauth/request').length

    ;(await start('sess_a')).assertStatus(200)
    // Trop rapproché : refusé sans appeler Zotero.
    const fast = await start('sess_a')
    fast.assertStatus(429)
    fast.assertBodyContains({ code: 'E_ZOTERO_OAUTH_TOO_MANY' })
    assert.equal(requested(), 1)
    // Plus tard, même session : la demande précédente est remplacée.
    await age()
    ;(await start('sess_a')).assertStatus(200)
    assert.lengthOf(await ZoteroOAuthRequest.query().where('userId', user.id), 1)
    // Au plus cinq demandes en cours par compte.
    for (const sid of ['sess_b', 'sess_c', 'sess_d', 'sess_e']) {
      await age()
      ;(await start(sid)).assertStatus(200)
    }
    await age()
    const many = await start('sess_f')
    many.assertStatus(429)
    assert.lengthOf(await ZoteroOAuthRequest.query().where('userId', user.id), 5)
    assert.equal(requested(), 6)
  })
})
