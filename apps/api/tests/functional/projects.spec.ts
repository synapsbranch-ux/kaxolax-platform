import { readDocumentText } from '@kaxolax/collab'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import Document from '#models/document'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import { createUser } from '#tests/helpers'

test.group('projects', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('creates a project with its owner and a minimal main.tex', async ({ client, assert }) => {
    const user = await createUser()
    const response = await client
      .post('/api/v1/projects')
      .json({ name: 'Thèse & résultats #1' })
      .loginAs(user)
    response.assertStatus(201)
    const body = response.body() as {
      project: { id: string; mainDocumentId: string; role: string; compiler: string }
    }
    assert.equal(body.project.role, 'owner')
    assert.equal(body.project.compiler, 'pdflatex')

    const member = await ProjectMember.query()
      .where({ projectId: body.project.id, userId: user.id })
      .firstOrFail()
    assert.equal(member.role, 'owner')
    const main = await Document.findOrFail(body.project.mainDocumentId)
    assert.equal(main.name, 'main.tex')
    const text = readDocumentText(main.yjsState)
    assert.include(text, '\\documentclass{article}')
    // Le nom est échappé pour LaTeX.
    assert.include(text, '\\title{Thèse \\& résultats \\#1}')
  })

  test('lists active, archived and trashed projects and searches by name', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const create = async (name: string) =>
      (await client.post('/api/v1/projects').json({ name }).loginAs(user)).body().project
        .id as string
    const active = await create('Active paper')
    const archived = await create('Archived notes')
    const trashed = await create('Trashed draft 100%')
    await client.post(`/api/v1/projects/${archived}/archive`).loginAs(user)
    await client.post(`/api/v1/projects/${trashed}/trash`).loginAs(user)

    const ids = async (query: string) =>
      (
        (await client.get(`/api/v1/projects${query}`).loginAs(user)).body().projects as {
          id: string
        }[]
      ).map((p) => p.id)
    assert.deepEqual(await ids(''), [active])
    assert.deepEqual(await ids('?view=archived'), [archived])
    assert.deepEqual(await ids('?view=trashed'), [trashed])
    assert.deepEqual(await ids('?view=trashed&q=100%25'), [trashed])
    assert.deepEqual(await ids('?q=PAPER'), [active])
    assert.deepEqual(await ids('?q=%25'), [])
    const invalid = await client.get('/api/v1/projects?view=everything').loginAs(user)
    invalid.assertStatus(422)
  })

  test('renames, changes the compiler and the main document', async ({ client, assert }) => {
    const user = await createUser()
    const project = (
      await client.post('/api/v1/projects').json({ name: 'Paper' }).loginAs(user)
    ).body().project as { id: string }
    const doc = await client
      .post(`/api/v1/projects/${project.id}/documents`)
      .json({ name: 'other.tex' })
      .loginAs(user)
    const response = await client
      .patch(`/api/v1/projects/${project.id}`)
      .json({ name: 'Renamed', compiler: 'xelatex', mainDocumentId: doc.body().document.id })
      .loginAs(user)
    response.assertStatus(200)
    response.assertBodyContains({
      project: { name: 'Renamed', compiler: 'xelatex', mainDocumentId: doc.body().document.id },
    })

    const invalid = await client
      .patch(`/api/v1/projects/${project.id}`)
      .json({ name: '', compiler: 'tex' })
      .loginAs(user)
    invalid.assertStatus(422)
    const control = await client
      .patch(`/api/v1/projects/${project.id}`)
      .json({ name: 'bad\u0007name' })
      .loginAs(user)
    control.assertStatus(422)

    const other = await createUser()
    const foreign = (
      await client.post('/api/v1/projects').json({ name: 'Foreign' }).loginAs(other)
    ).body().project as { mainDocumentId: string }
    const foreignMain = await client
      .patch(`/api/v1/projects/${project.id}`)
      .json({ mainDocumentId: foreign.mainDocumentId })
      .loginAs(user)
    foreignMain.assertStatus(422)
    assert.equal((await Project.findOrFail(project.id)).mainDocumentId, doc.body().document.id)
  })

  test('changes the spellcheck language with the editor role', async ({ client, assert }) => {
    const owner = await createUser()
    const created = await client.post('/api/v1/projects').json({ name: 'Langue' }).loginAs(owner)
    created.assertBodyContains({ project: { spellcheckLanguage: 'en' } })
    const id = created.body().project.id as string

    const french = await client
      .patch(`/api/v1/projects/${id}`)
      .json({ spellcheckLanguage: 'fr' })
      .loginAs(owner)
    french.assertStatus(200)
    french.assertBodyContains({ project: { spellcheckLanguage: 'fr' } })
    for (const language of ['de', 'FR', '', 42]) {
      const invalid = await client
        .patch(`/api/v1/projects/${id}`)
        .json({ spellcheckLanguage: language })
        .loginAs(owner)
      invalid.assertStatus(422)
    }

    const editor = await createUser()
    await ProjectMember.create({ projectId: id, userId: editor.id, role: 'editor' })
    const byEditor = await client
      .patch(`/api/v1/projects/${id}`)
      .json({ spellcheckLanguage: 'en' })
      .loginAs(editor)
    byEditor.assertStatus(200)
    for (const role of ['reviewer', 'viewer'] as const) {
      const member = await createUser()
      await ProjectMember.create({ projectId: id, userId: member.id, role })
      const refused = await client
        .patch(`/api/v1/projects/${id}`)
        .json({ spellcheckLanguage: 'fr' })
        .loginAs(member)
      refused.assertStatus(403)
    }
    assert.equal((await Project.findOrFail(id)).spellcheckLanguage, 'en')
  })

  test('archives, restores and deletes only from the trash', async ({ client, assert }) => {
    const user = await createUser()
    const id = (
      await client.post('/api/v1/projects').json({ name: 'Lifecycle' }).loginAs(user)
    ).body().project.id as string
    for (const action of ['archive', 'unarchive', 'trash', 'restore']) {
      const response = await client.post(`/api/v1/projects/${id}/${action}`).loginAs(user)
      response.assertStatus(200)
    }
    const notTrashed = await client.delete(`/api/v1/projects/${id}`).loginAs(user)
    notTrashed.assertStatus(409)
    await client.post(`/api/v1/projects/${id}/trash`).loginAs(user)
    const deleted = await client.delete(`/api/v1/projects/${id}`).loginAs(user)
    deleted.assertStatus(204)
    assert.isNull(await Project.find(id))
    assert.lengthOf(await Document.query().where('projectId', id), 0)
    assert.lengthOf(await ProjectMember.query().where('projectId', id), 0)
  })

  test('shows a project with the role of the current user', async ({ client }) => {
    const user = await createUser()
    const created = await client.post('/api/v1/projects').json({ name: 'Seul' }).loginAs(user)
    const id = created.body().project.id as string
    const shown = await client.get(`/api/v1/projects/${id}`).loginAs(user)
    shown.assertStatus(200)
    shown.assertBodyContains({ project: { id, name: 'Seul', role: 'owner', compiler: 'pdflatex' } })
    const stranger = await createUser()
    ;(await client.get(`/api/v1/projects/${id}`).loginAs(stranger)).assertStatus(404)
  })

  test("never exposes another user's project", async ({ client }) => {
    const owner = await createUser()
    const intruder = await createUser()
    const id = (
      await client.post('/api/v1/projects').json({ name: 'Private' }).loginAs(owner)
    ).body().project.id as string
    const attempts = [
      client.get(`/api/v1/projects/${id}/tree`).loginAs(intruder),
      client.patch(`/api/v1/projects/${id}`).json({ name: 'Mine' }).loginAs(intruder),
      client.post(`/api/v1/projects/${id}/archive`).loginAs(intruder),
      client.post(`/api/v1/projects/${id}/trash`).loginAs(intruder),
      client.delete(`/api/v1/projects/${id}`).loginAs(intruder),
      client.post(`/api/v1/projects/${id}/folders`).json({ name: 'x' }).loginAs(intruder),
      client.get('/api/v1/projects/not-a-uuid/tree').loginAs(intruder),
    ]
    for (const attempt of attempts) (await attempt).assertStatus(404)
    const list = await client.get('/api/v1/projects').loginAs(intruder)
    list.assertBodyContains({ projects: [] })
  })

  test('checks the member role recorded in project_members', async ({ client }) => {
    const owner = await createUser()
    const viewer = await createUser()
    const id = (
      await client.post('/api/v1/projects').json({ name: 'Shared' }).loginAs(owner)
    ).body().project.id as string
    await ProjectMember.create({ projectId: id, userId: viewer.id, role: 'viewer' })
    ;(await client.get(`/api/v1/projects/${id}/tree`).loginAs(viewer)).assertStatus(200)
    ;(
      await client.post(`/api/v1/projects/${id}/folders`).json({ name: 'x' }).loginAs(viewer)
    ).assertStatus(403)
    ;(await client.post(`/api/v1/projects/${id}/trash`).loginAs(viewer)).assertStatus(403)
  })

  test('requires a Clerk session token', async ({ client }) => {
    ;(await client.get('/api/v1/projects')).assertStatus(401)
    ;(await client.post('/api/v1/projects').json({ name: 'x' })).assertStatus(401)
  })
})
