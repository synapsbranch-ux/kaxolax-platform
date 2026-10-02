import { createHash } from 'node:crypto'
import {
  MAX_SEARCH_QUERY_LENGTH,
  type ProjectSnapshot,
  projectSearchResponseSchema,
} from '@kaxolax/contracts'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import type User from '#models/user'
import RealtimeClient from '#services/realtime_client'
import { createUser } from '#tests/helpers'

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex')

/** Faux service temps réel : instantané configurable, ou indisponible (null). */
class FakeRealtime extends RealtimeClient {
  snapshots = new Map<string, ProjectSnapshot | null>()

  override async snapshot(projectId: string) {
    return Promise.resolve(this.snapshots.get(projectId) ?? null)
  }

  override async closeDocuments() {
    return Promise.resolve()
  }
}

let realtime: FakeRealtime

async function setupProject(client: ApiClient, user: User) {
  const created = await client.post('/api/v1/projects').json({ name: 'Thèse' }).loginAs(user)
  const projectId = created.body().project.id as string
  const folder = await client
    .post(`/api/v1/projects/${projectId}/folders`)
    .json({ name: 'chapters' })
    .loginAs(user)
  const intro = await client
    .post(`/api/v1/projects/${projectId}/documents`)
    .json({
      name: 'intro.tex',
      folderId: folder.body().folder.id,
      content: 'Intro line\n\\section{Theorem}\nA theorem, theorems and THEOREM.\n',
    })
    .loginAs(user)
  const project = await Project.findOrFail(projectId)
  return {
    projectId,
    introId: intro.body().document.id as string,
    mainId: project.mainDocumentId ?? '',
  }
}

test.group('project search', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    realtime = new FakeRealtime()
    app.container.swap(RealtimeClient, () => realtime)
    return () => {
      app.container.restore(RealtimeClient)
    }
  })

  test('searches the live text of every document', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId, introId, mainId } = await setupProject(client, user)
    // main.tex est en cours d'édition : l'instantané l'emporte sur l'état enregistré.
    const live = '\\documentclass{article}\n\\begin{document}\nsee theorem 1\n\\end{document}\n'
    realtime.snapshots.set(projectId, {
      projectId,
      documents: [{ id: mainId, content: live, sha256: sha256(live) }],
    })

    const response = await client
      .get(`/api/v1/projects/${projectId}/search`)
      .qs({ q: 'theorem' })
      .loginAs(user)
    response.assertStatus(200)
    const body = projectSearchResponseSchema.parse(response.body())
    assert.isFalse(body.truncated)
    assert.deepEqual(
      body.matches.map((match) => [match.path, match.line, match.column, match.length]),
      [
        ['chapters/intro.tex', 2, 9, 7],
        ['chapters/intro.tex', 3, 2, 7],
        ['chapters/intro.tex', 3, 11, 7],
        ['chapters/intro.tex', 3, 24, 7],
        ['main.tex', 3, 4, 7],
      ],
    )
    assert.equal(body.matches[0]?.documentId, introId)
    assert.equal(body.matches[0]?.preview, '\\section{Theorem}')
    assert.equal(body.matches[4]?.documentId, mainId)
  })

  test('honours case, whole word and regular expressions', async ({ client, assert }) => {
    const user = await createUser()
    const { projectId } = await setupProject(client, user)
    const search = async (qs: Record<string, string>) => {
      const response = await client.get(`/api/v1/projects/${projectId}/search`).qs(qs).loginAs(user)
      response.assertStatus(200)
      return projectSearchResponseSchema
        .parse(response.body())
        .matches.filter((match) => match.path === 'chapters/intro.tex')
        .map((match) => `${String(match.line)}:${String(match.column)}`)
    }

    assert.deepEqual(await search({ q: 'THEOREM', caseSensitive: 'true' }), ['3:24'])
    assert.deepEqual(await search({ q: 'theorem', wholeWord: 'true' }), ['2:9', '3:2', '3:24'])
    assert.deepEqual(await search({ q: String.raw`theorem\w+`, regex: 'true' }), ['3:11'])
    // Sans regex, les caractères spéciaux sont cherchés tels quels.
    assert.deepEqual(await search({ q: String.raw`\section{` }), ['2:0'])
    assert.deepEqual(await search({ q: '.', caseSensitive: 'true' }), ['3:31'])
  })

  test('truncates the results and stops a catastrophic regular expression', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const { projectId, mainId } = await setupProject(client, user)
    const many = `${'x '.repeat(600)}\n${'a'.repeat(40)}!\n`
    realtime.snapshots.set(projectId, {
      projectId,
      documents: [{ id: mainId, content: many, sha256: sha256(many) }],
    })
    const url = `/api/v1/projects/${projectId}/search`

    const truncated = projectSearchResponseSchema.parse(
      (await client.get(url).qs({ q: 'x' }).loginAs(user)).body(),
    )
    assert.lengthOf(truncated.matches, 500)
    assert.isTrue(truncated.truncated)
    assert.isFalse(truncated.timedOut)

    const started = Date.now()
    const redos = await client.get(url).qs({ q: '^(a+)+$', regex: 'true' }).loginAs(user)
    redos.assertStatus(200)
    assert.isTrue(redos.body().timedOut)
    assert.isTrue(redos.body().truncated)
    assert.isBelow(Date.now() - started, 5000)
  })

  test('keeps serving requests while a catastrophic search runs', async ({ client, assert }) => {
    const owner = await createUser()
    const { projectId, mainId } = await setupProject(client, owner)
    const viewer = await createUser()
    await ProjectMember.create({ projectId, userId: viewer.id, role: 'viewer' })
    const content = `${'a'.repeat(40)}!\n`
    realtime.snapshots.set(projectId, {
      projectId,
      documents: [{ id: mainId, content, sha256: sha256(content) }],
    })
    const url = `/api/v1/projects/${projectId}/search`
    const finished: string[] = []
    const send = async (name: string, user: User, qs: Record<string, string>) => {
      const response = await client.get(url).qs(qs).loginAs(user)
      finished.push(name)
      return response
    }
    const pause = () => new Promise((resolve) => setTimeout(resolve, 150))
    // Deux workers prêts d'avance : le démarrage d'un worker ne doit pas fausser l'ordre mesuré.
    await Promise.all([
      client.get(url).qs({ q: 'a' }).loginAs(owner),
      client.get(url).qs({ q: 'a' }).loginAs(viewer),
    ])
    finished.length = 0

    // La recherche catastrophique tourne dans un worker : la boucle de l'API reste libre.
    const slow = send('slow', viewer, { q: '^(a+)+$', regex: 'true' })
    await pause()
    const other = await send('other', owner, { q: 'a' })
    other.assertStatus(200)
    const tree = await client.get(`/api/v1/projects/${projectId}/tree`).loginAs(owner)
    tree.assertStatus(200)
    assert.deepEqual(finished, ['other'])
    const slowResponse = await slow
    slowResponse.assertStatus(200)
    assert.isTrue(slowResponse.body().timedOut)

    // Une nouvelle recherche du même utilisateur remplace la précédente.
    const replaced = send('replaced', viewer, { q: '^(a+)+$', regex: 'true' })
    await pause()
    ;(await send('latest', viewer, { q: 'a' })).assertStatus(200)
    const replacedResponse = await replaced
    replacedResponse.assertStatus(409)
    replacedResponse.assertBodyContains({ code: 'E_SEARCH_SUPERSEDED' })
  })

  test('validates the query and checks membership', async ({ client }) => {
    const user = await createUser()
    const { projectId } = await setupProject(client, user)
    const url = `/api/v1/projects/${projectId}/search`

    for (const qs of [
      {},
      { q: '' },
      { q: 'x'.repeat(MAX_SEARCH_QUERY_LENGTH + 1) },
      { q: 'x', regex: 'maybe' },
    ]) {
      ;(await client.get(url).qs(qs).loginAs(user)).assertStatus(422)
    }
    const invalid = await client.get(url).qs({ q: '(unclosed', regex: 'true' }).loginAs(user)
    invalid.assertStatus(422)
    invalid.assertBodyContains({ code: 'E_INVALID_SEARCH_PATTERN' })

    // Lecteur : autorisé ; non-membre : 404.
    const viewer = await createUser()
    await ProjectMember.create({ projectId, userId: viewer.id, role: 'viewer' })
    ;(await client.get(url).qs({ q: 'x' }).loginAs(viewer)).assertStatus(200)
    const stranger = await createUser()
    ;(await client.get(url).qs({ q: 'x' }).loginAs(stranger)).assertStatus(404)
    ;(await client.get(url).qs({ q: 'x' })).assertStatus(401)
  })
})
