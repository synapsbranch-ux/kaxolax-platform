import { MAX_TEXT_DOCUMENT_BYTES } from '@kaxolax/contracts'
import { readDocumentText } from '@kaxolax/collab'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import Document from '#models/document'
import Project from '#models/project'
import User from '#models/user'
import { createUser } from '#tests/helpers'
import type { ApiClient } from '@japa/api-client'

async function newProject(client: ApiClient, user: User): Promise<string> {
  const response = await client.post('/api/v1/projects').json({ name: 'Tree' }).loginAs(user)
  return response.body().project.id as string
}

test.group('project tree', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('creates folders and documents and computes their paths', async ({ client, assert }) => {
    const user = await createUser()
    const id = await newProject(client, user)
    const chapters = await client
      .post(`/api/v1/projects/${id}/folders`)
      .json({ name: 'chapters' })
      .loginAs(user)
    chapters.assertStatus(201)
    const chaptersId = chapters.body().folder.id as string
    const nested = await client
      .post(`/api/v1/projects/${id}/folders`)
      .json({ name: 'appendix', parentId: chaptersId })
      .loginAs(user)
    const intro = await client
      .post(`/api/v1/projects/${id}/documents`)
      .json({ name: 'intro.tex', folderId: chaptersId, content: '\\section{Intro}' })
      .loginAs(user)
    intro.assertStatus(201)

    const tree = await client.get(`/api/v1/projects/${id}/tree`).loginAs(user)
    tree.assertStatus(200)
    const body = tree.body() as {
      mainDocumentId: string
      folders: { path: string }[]
      documents: { id: string; path: string }[]
    }
    assert.sameMembers(
      body.folders.map((folder) => folder.path),
      ['chapters', 'chapters/appendix'],
    )
    assert.sameMembers(
      body.documents.map((document) => document.path),
      ['main.tex', 'chapters/intro.tex'],
    )
    assert.isString(body.mainDocumentId)
    assert.equal(nested.body().folder.parentId, chaptersId)
    const stored = await Document.findOrFail(intro.body().document.id)
    assert.equal(readDocumentText(stored.yjsState), '\\section{Intro}')
  })

  test('keeps names unique in a folder across folders, documents and files', async ({ client }) => {
    const user = await createUser()
    const id = await newProject(client, user)
    const folder = await client
      .post(`/api/v1/projects/${id}/folders`)
      .json({ name: 'notes.tex' })
      .loginAs(user)
    folder.assertStatus(201)
    const sameName = await client
      .post(`/api/v1/projects/${id}/documents`)
      .json({ name: 'notes.tex' })
      .loginAs(user)
    sameName.assertStatus(409)
    sameName.assertBodyContains({ code: 'E_NAME_TAKEN' })
    const mainAgain = await client
      .post(`/api/v1/projects/${id}/documents`)
      .json({ name: 'main.tex' })
      .loginAs(user)
    mainAgain.assertStatus(409)
    // Le même nom est permis dans un autre dossier.
    const elsewhere = await client
      .post(`/api/v1/projects/${id}/documents`)
      .json({ name: 'main.tex', folderId: folder.body().folder.id })
      .loginAs(user)
    elsewhere.assertStatus(201)
  })

  test('refuses invalid names', async ({ client }) => {
    const user = await createUser()
    const id = await newProject(client, user)
    for (const name of [
      '',
      '..',
      'a..b',
      'a/b',
      'a\\b',
      'bad\u0000name',
      'tab\tname',
      'é'.repeat(128),
    ]) {
      const response = await client
        .post(`/api/v1/projects/${id}/folders`)
        .json({ name })
        .loginAs(user)
      response.assertStatus(422)
    }
    const noExtension = await client
      .post(`/api/v1/projects/${id}/documents`)
      .json({ name: 'picture.png' })
      .loginAs(user)
    noExtension.assertStatus(422)
  })

  test('refuses a text document of 2 MB or more', async ({ client }) => {
    const user = await createUser()
    const id = await newProject(client, user)
    const response = await client
      .post(`/api/v1/projects/${id}/documents`)
      .json({ name: 'big.tex', content: 'é'.repeat(MAX_TEXT_DOCUMENT_BYTES / 2) })
      .loginAs(user)
    response.assertStatus(422)
  })

  test('renames and moves entities, and refuses folder cycles', async ({ client, assert }) => {
    const user = await createUser()
    const id = await newProject(client, user)
    const a = (
      await client.post(`/api/v1/projects/${id}/folders`).json({ name: 'a' }).loginAs(user)
    ).body().folder.id as string
    const b = (
      await client
        .post(`/api/v1/projects/${id}/folders`)
        .json({ name: 'b', parentId: a })
        .loginAs(user)
    ).body().folder.id as string
    const doc = (
      await client.post(`/api/v1/projects/${id}/documents`).json({ name: 'x.tex' }).loginAs(user)
    ).body().document.id as string

    const moved = await client
      .patch(`/api/v1/projects/${id}/entities/document/${doc}`)
      .json({ name: 'y.tex', folderId: b })
      .loginAs(user)
    moved.assertStatus(200)
    const tree = (await client.get(`/api/v1/projects/${id}/tree`).loginAs(user)).body() as {
      documents: { path: string }[]
    }
    assert.include(
      tree.documents.map((document) => document.path),
      'a/b/y.tex',
    )

    const back = await client
      .patch(`/api/v1/projects/${id}/entities/document/${doc}`)
      .json({ folderId: null })
      .loginAs(user)
    back.assertStatus(200)

    const cycle = await client
      .patch(`/api/v1/projects/${id}/entities/folder/${a}`)
      .json({ folderId: b })
      .loginAs(user)
    cycle.assertStatus(422)
    const self = await client
      .patch(`/api/v1/projects/${id}/entities/folder/${a}`)
      .json({ folderId: a })
      .loginAs(user)
    self.assertStatus(422)
    const missing = await client
      .patch(`/api/v1/projects/${id}/entities/folder/${b}`)
      .json({ folderId: '00000000-0000-4000-8000-000000000000' })
      .loginAs(user)
    missing.assertStatus(404)
    const clash = await client
      .patch(`/api/v1/projects/${id}/entities/document/${doc}`)
      .json({ name: 'main.tex' })
      .loginAs(user)
    clash.assertStatus(409)
    const badType = await client
      .patch(`/api/v1/projects/${id}/entities/widget/${doc}`)
      .json({ name: 'z.tex' })
      .loginAs(user)
    badType.assertStatus(422)
  })

  test('deletes a folder with its content and clears a deleted main document', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const id = await newProject(client, user)
    const folder = (
      await client.post(`/api/v1/projects/${id}/folders`).json({ name: 'chapters' }).loginAs(user)
    ).body().folder.id as string
    const sub = (
      await client
        .post(`/api/v1/projects/${id}/folders`)
        .json({ name: 'sub', parentId: folder })
        .loginAs(user)
    ).body().folder.id as string
    await client
      .post(`/api/v1/projects/${id}/documents`)
      .json({ name: 'deep.tex', folderId: sub })
      .loginAs(user)

    const deleted = await client
      .delete(`/api/v1/projects/${id}/entities/folder/${folder}`)
      .loginAs(user)
    deleted.assertStatus(204)
    const tree = (await client.get(`/api/v1/projects/${id}/tree`).loginAs(user)).body() as {
      folders: unknown[]
      documents: { name: string }[]
      mainDocumentId: string
    }
    assert.lengthOf(tree.folders, 0)
    assert.deepEqual(
      tree.documents.map((document) => document.name),
      ['main.tex'],
    )

    const main = await client
      .delete(`/api/v1/projects/${id}/entities/document/${tree.mainDocumentId}`)
      .loginAs(user)
    main.assertStatus(204)
    assert.isNull((await Project.findOrFail(id)).mainDocumentId)
  })

  test('refuses entities from another project', async ({ client }) => {
    const user = await createUser()
    const mine = await newProject(client, user)
    const other = await newProject(client, user)
    const foreignFolder = (
      await client.post(`/api/v1/projects/${other}/folders`).json({ name: 'f' }).loginAs(user)
    ).body().folder.id as string
    const rename = await client
      .patch(`/api/v1/projects/${mine}/entities/folder/${foreignFolder}`)
      .json({ name: 'g' })
      .loginAs(user)
    rename.assertStatus(404)
    const remove = await client
      .delete(`/api/v1/projects/${mine}/entities/folder/${foreignFolder}`)
      .loginAs(user)
    remove.assertStatus(404)
    const into = await client
      .post(`/api/v1/projects/${mine}/documents`)
      .json({ name: 'a.tex', folderId: foreignFolder })
      .loginAs(user)
    into.assertStatus(404)
  })
})

test.group('project tree concurrency', () => {
  test('two simultaneous creations of the same name never both succeed', async ({
    client,
    assert,
    cleanup,
  }) => {
    const user = await createUser()
    cleanup(async () => {
      await User.query().where('id', user.id).delete()
    })
    const id = await newProject(client, user)
    const statuses = await Promise.all(
      Array.from({ length: 5 }, () =>
        client.post(`/api/v1/projects/${id}/documents`).json({ name: 'race.tex' }).loginAs(user),
      ),
    ).then((responses) => responses.map((response) => response.status()))
    assert.equal(statuses.filter((status) => status === 201).length, 1)
    assert.equal(statuses.filter((status) => status === 409).length, 4)
  })
})
