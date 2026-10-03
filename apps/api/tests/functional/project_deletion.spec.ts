import { randomUUID } from 'node:crypto'
import { compileOutputPrefix } from '@kaxolax/contracts'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import Project from '#models/project'
import type User from '#models/user'
import ObjectStorage, {
  CompileOutputStorage,
  fileKey,
  projectOutputsPrefix,
  projectPrefix,
} from '#services/object_storage'
import { adminFakes, createAdmin, useAdminFakes } from '#tests/admin'
import { createUser } from '#tests/helpers'

const PDF = Buffer.from('%PDF-1.7\n%test\n')
const REQUEST = Buffer.from('{}')

interface StoredObject {
  key: string
  bytes: number
}

async function newProject(client: ApiClient, owner: User): Promise<string> {
  const response = await client.post('/api/v1/projects').json({ name: 'Rapport' }).loginAs(owner)
  response.assertStatus(201)
  return response.body().project.id as string
}

/** Objets S3 d'un projet : un fichier et les sorties de deux compilations (demande, PDF). */
async function storeObjects(projectId: string): Promise<StoredObject[]> {
  const files = new ObjectStorage()
  const outputs = new CompileOutputStorage()
  const file = fileKey(projectId, randomUUID())
  await files.putBuffer(file, PDF, 'application/pdf')
  const stored = [{ key: file, bytes: PDF.length }]
  for (const buildId of [randomUUID(), randomUUID()]) {
    const prefix = compileOutputPrefix(projectId, buildId)
    await outputs.putBuffer(`${prefix}request.json`, REQUEST, 'application/json')
    await outputs.putBuffer(`${prefix}output.pdf`, PDF, 'application/pdf')
    stored.push(
      { key: `${prefix}request.json`, bytes: REQUEST.length },
      { key: `${prefix}output.pdf`, bytes: PDF.length },
    )
  }
  return stored
}

/** Taille actuelle de chaque objet (null : absent), lue dans le bucket qui le contient. */
async function sizes(stored: readonly StoredObject[]): Promise<(number | null)[]> {
  const files = new ObjectStorage()
  const outputs = new CompileOutputStorage()
  return Promise.all(
    stored.map(({ key }) => (key.startsWith('outputs/') ? outputs.size(key) : files.size(key))),
  )
}

test.group('project deletion: stored objects', (group) => {
  useAdminFakes(group)

  test('deleting a project from the trash erases its files and every compile output', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const otherId = await newProject(client, owner)
    const stored = await storeObjects(projectId)
    const otherStored = await storeObjects(otherId)
    assert.deepEqual(
      await sizes(stored),
      stored.map(({ bytes }) => bytes),
    )

    await client.post(`/api/v1/projects/${projectId}/trash`).loginAs(owner)
    ;(await client.delete(`/api/v1/projects/${projectId}`).loginAs(owner)).assertStatus(204)

    assert.isNull(await Project.find(projectId))
    assert.deepEqual(
      await sizes(stored),
      stored.map(() => null),
    )
    // Les objets d'un autre projet restent : seul `outputs/<id>/` du projet supprimé est visé.
    assert.deepEqual(
      await sizes(otherStored),
      otherStored.map(({ bytes }) => bytes),
    )
    await new CompileOutputStorage().deletePrefix(projectOutputsPrefix(otherId))
    await new ObjectStorage().deletePrefix(projectPrefix(otherId))
  })

  test('an admin deletion erases the compile outputs too', async ({ client, assert }) => {
    const { token } = await createAdmin(adminFakes.clerk)
    const owner = await createUser()
    const projectId = await newProject(client, owner)
    const stored = await storeObjects(projectId)

    await client.post(`/api/v1/projects/${projectId}/trash`).loginAs(owner)
    ;(await client.delete(`/api/v1/admin/projects/${projectId}`).bearerToken(token)).assertStatus(
      204,
    )

    assert.deepEqual(
      await sizes(stored),
      stored.map(() => null),
    )
  })
})
