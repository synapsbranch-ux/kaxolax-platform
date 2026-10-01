import { randomUUID } from 'node:crypto'
import { PERSONAL_WORKSPACE_NAME } from '@kaxolax/contracts'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import User from '#models/user'
import Workspace from '#models/workspace'
import WorkspaceMember from '#models/workspace_member'
import { ensurePersonalWorkspace } from '#services/workspace_service'
import { createUser, newClerkUserId, uniqueEmail } from '#tests/helpers'

async function personalWorkspaceOf(user: User): Promise<Workspace> {
  return Workspace.query().where({ ownerId: user.id, type: 'personal' }).firstOrFail()
}

async function newProject(client: ApiClient, user: User, name: string): Promise<string> {
  const response = await client.post('/api/v1/projects').json({ name }).loginAs(user)
  response.assertStatus(201)
  return response.body().project.id as string
}

test.group('workspaces', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('lists the personal workspace of the user with the owner role', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    await createUser()
    const response = await client.get('/api/v1/workspaces').loginAs(user)
    response.assertStatus(200)
    const workspaces = response.body().workspaces as { id: string }[]
    assert.lengthOf(workspaces, 1)
    response.assertBodyContains({
      workspaces: [
        { name: PERSONAL_WORKSPACE_NAME, type: 'personal', ownerId: user.id, role: 'owner' },
      ],
    })
    assert.equal(workspaces[0]?.id, (await personalWorkspaceOf(user)).id)
    ;(await client.get('/api/v1/workspaces')).assertStatus(401)
  })

  test('GET /workspaces gives a personal workspace to an account that has none', async ({
    client,
    assert,
  }) => {
    // Miroir créé sans upsertClerkUser : ancienne version pendant un déploiement, import SQL.
    const user = await User.create({
      clerkUserId: newClerkUserId(),
      email: uniqueEmail('legacy'),
      fullName: null,
    })
    assert.lengthOf(await Workspace.query().where('ownerId', user.id), 0)
    const ids = async () => {
      const response = await client.get('/api/v1/workspaces').loginAs(user)
      response.assertStatus(200)
      response.assertBodyContains({
        workspaces: [
          { name: PERSONAL_WORKSPACE_NAME, type: 'personal', ownerId: user.id, role: 'owner' },
        ],
      })
      return (response.body().workspaces as { id: string }[]).map((workspace) => workspace.id)
    }

    const listed = await ids()
    const personal = await personalWorkspaceOf(user)
    assert.deepEqual(listed, [personal.id])
    // Appartenance perdue : rétablie elle aussi, sans second workspace.
    await WorkspaceMember.query().where({ workspaceId: personal.id, userId: user.id }).delete()
    assert.deepEqual(await ids(), [personal.id])
    assert.lengthOf(await Workspace.query().where('ownerId', user.id), 1)
    assert.lengthOf(await WorkspaceMember.query().where('userId', user.id), 1)
  })

  test('a project inserted without workspace_id joins the personal workspace of its owner', async ({
    assert,
  }) => {
    // Insertions de l'API de l'étape 1, encore en service pendant un déploiement (compte et
    // projet sans workspace) : le déclencheur de la migration …0014 les rattache.
    const user = await User.create({
      clerkUserId: newClerkUserId(),
      email: uniqueEmail('legacy'),
      fullName: null,
    })
    const insertProject = async (name: string, workspaceId?: string) => {
      const id = randomUUID()
      await db.table('projects').insert({
        id,
        owner_id: user.id,
        name,
        compiler: 'pdflatex',
        ...(workspaceId === undefined ? {} : { workspace_id: workspaceId }),
      })
      return (await Project.findOrFail(id)).workspaceId
    }

    const first = await insertProject('Legacy 1')
    const personal = await personalWorkspaceOf(user)
    assert.equal(first, personal.id)
    assert.equal(await insertProject('Legacy 2'), personal.id)
    assert.lengthOf(await Workspace.query().where('ownerId', user.id), 1)
    const members = await WorkspaceMember.query().where('userId', user.id)
    assert.deepEqual(
      members.map((member) => [member.workspaceId, member.role]),
      [[personal.id, 'owner']],
    )
    // Un workspace_id fourni n'est jamais remplacé.
    const team = await Workspace.create({ name: 'Team', type: 'team', ownerId: user.id })
    assert.equal(await insertProject('Team project', team.id), team.id)
  })

  test('ensurePersonalWorkspace is idempotent', async ({ assert }) => {
    const user = await createUser()
    const first = await ensurePersonalWorkspace(user)
    const second = await ensurePersonalWorkspace(user)
    assert.equal(first.id, second.id)
    assert.lengthOf(await Workspace.query().where('ownerId', user.id), 1)
    const members = await WorkspaceMember.query().where('workspaceId', first.id)
    assert.deepEqual(
      members.map((member) => [member.userId, member.role]),
      [[user.id, 'owner']],
    )
  })

  test('the database refuses a second personal workspace for the same owner', async ({
    assert,
  }) => {
    const user = await createUser()
    await assert.rejects(() =>
      db.transaction((trx) =>
        Workspace.create({ name: 'Another', type: 'personal', ownerId: user.id }, { client: trx }),
      ),
    )
    // Les workspaces d'équipe (étape 3) ne sont pas concernés.
    await Workspace.create({ name: 'Team', type: 'team', ownerId: user.id })
    assert.lengthOf(await Workspace.query().where({ ownerId: user.id, type: 'personal' }), 1)
  })

  test('creates projects in the personal workspace unless another one is given', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const other = await createUser()
    const personal = await personalWorkspaceOf(user)

    const created = await client.post('/api/v1/projects').json({ name: 'Default' }).loginAs(user)
    created.assertStatus(201)
    created.assertBodyContains({ project: { workspaceId: personal.id } })
    const id = created.body().project.id as string
    assert.equal((await Project.findOrFail(id)).workspaceId, personal.id)

    const explicit = await client
      .post('/api/v1/projects')
      .json({ name: 'Explicit', workspaceId: personal.id })
      .loginAs(user)
    explicit.assertStatus(201)
    explicit.assertBodyContains({ project: { workspaceId: personal.id } })

    const foreign = await client
      .post('/api/v1/projects')
      .json({ name: 'Intrusion', workspaceId: (await personalWorkspaceOf(other)).id })
      .loginAs(user)
    foreign.assertStatus(404)
    foreign.assertBodyContains({ code: 'E_WORKSPACE_NOT_FOUND' })
    assert.isNull(await Project.findBy('name', 'Intrusion'))
    const invalid = await client
      .post('/api/v1/projects')
      .json({ name: 'Invalid', workspaceId: 'personal' })
      .loginAs(user)
    invalid.assertStatus(422)
  })

  test("filters projects by workspace and refuses another user's workspace", async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const other = await createUser()
    const mine = await newProject(client, user, 'Mine')
    const shared = await newProject(client, other, 'Shared with me')
    await ProjectMember.create({ projectId: shared, userId: user.id, role: 'editor' })
    const personal = await personalWorkspaceOf(user)
    const foreign = await personalWorkspaceOf(other)

    const ids = async (query: string) => {
      const response = await client.get(`/api/v1/projects${query}`).loginAs(user)
      response.assertStatus(200)
      return (response.body().projects as { id: string }[]).map((project) => project.id)
    }
    // Sans filtre : tous les projets dont il est membre, partagés compris.
    assert.sameMembers(await ids(''), [mine, shared])
    assert.deepEqual(await ids(`?workspaceId=${personal.id}`), [mine])
    assert.deepEqual(await ids(`?workspaceId=${personal.id}&view=archived`), [])

    // Membre d'un projet du workspace, pas du workspace : 404 sans rien révéler.
    const refused = await client.get(`/api/v1/projects?workspaceId=${foreign.id}`).loginAs(user)
    refused.assertStatus(404)
    refused.assertBodyContains({ code: 'E_WORKSPACE_NOT_FOUND' })
    const unknown = await client
      .get('/api/v1/projects?workspaceId=00000000-0000-4000-8000-000000000000')
      .loginAs(user)
    unknown.assertStatus(404)
    ;(await client.get('/api/v1/projects?workspaceId=mine').loginAs(user)).assertStatus(422)
  })
})

test.group('workspaces concurrency', () => {
  test('simultaneous calls create a single personal workspace', async ({ assert, cleanup }) => {
    // Hors transaction globale : chaque appel a sa propre connexion.
    const user = await User.create({
      clerkUserId: newClerkUserId(),
      email: uniqueEmail('race'),
      fullName: null,
    })
    cleanup(async () => {
      await User.query().where('id', user.id).delete()
    })
    const workspaces = await Promise.all(
      Array.from({ length: 5 }, () => ensurePersonalWorkspace(user)),
    )
    assert.lengthOf(new Set(workspaces.map((workspace) => workspace.id)), 1)
    assert.lengthOf(await Workspace.query().where('ownerId', user.id), 1)
    assert.lengthOf(await WorkspaceMember.query().where('userId', user.id), 1)
  })
})
