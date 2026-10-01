import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import ChatRead from '#models/chat_read'
import ProjectMember from '#models/project_member'
import ProjectVersion from '#models/project_version'
import VersionFile from '#models/version_file'
import Workspace from '#models/workspace'
import WorkspaceMember from '#models/workspace_member'
import { createProject } from '#services/project_service'
import { createUser } from '#tests/helpers'

/**
 * Tables d'association à clé de substitution `id` : `save()` et `delete()` sur une instance ne
 * touchent que sa ligne, jamais les lignes voisines du même utilisateur ou du même fichier.
 */
test.group('association rows', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('project members: one row changes, the same user in another project does not', async ({
    assert,
  }) => {
    const owner = await createUser()
    const user = await createUser()
    const first = await createProject(owner, 'First')
    const second = await createProject(owner, 'Second')
    const member = await ProjectMember.create({
      projectId: first.id,
      userId: user.id,
      role: 'viewer',
    })
    await ProjectMember.create({ projectId: second.id, userId: user.id, role: 'viewer' })
    const roles = async () =>
      Object.fromEntries(
        (await ProjectMember.query().where('userId', user.id)).map((row) => [
          row.projectId,
          row.role,
        ]),
      )

    member.role = 'editor'
    await member.save()
    assert.deepEqual(await roles(), { [first.id]: 'editor', [second.id]: 'viewer' })
    await member.delete()
    assert.deepEqual(await roles(), { [second.id]: 'viewer' })
    assert.lengthOf(await ProjectMember.query().where('userId', owner.id), 2)
    // Le couple (projet, utilisateur) reste unique.
    await assert.rejects(() =>
      db.transaction((trx) =>
        ProjectMember.create(
          { projectId: second.id, userId: user.id, role: 'editor' },
          { client: trx },
        ),
      ),
    )
  })

  test('workspace members: one row changes, the personal workspace does not', async ({
    assert,
  }) => {
    const owner = await createUser()
    const user = await createUser()
    const team = await Workspace.create({ name: 'Team', type: 'team', ownerId: owner.id })
    const member = await WorkspaceMember.create({
      workspaceId: team.id,
      userId: user.id,
      role: 'member',
    })

    member.role = 'admin'
    await member.save()
    const rows = await WorkspaceMember.query().where('userId', user.id).orderBy('role')
    assert.deepEqual(
      rows.map((row) => [row.workspaceId === team.id, row.role]),
      [
        [true, 'admin'],
        [false, 'owner'],
      ],
    )
    await member.delete()
    const personal = await Workspace.query()
      .where({ ownerId: user.id, type: 'personal' })
      .firstOrFail()
    const left = await WorkspaceMember.query().where('userId', user.id)
    assert.deepEqual(
      left.map((row) => [row.workspaceId, row.role]),
      [[personal.id, 'owner']],
    )
    // Le couple (workspace, utilisateur) reste unique.
    await assert.rejects(() =>
      db.transaction((trx) =>
        WorkspaceMember.create(
          { workspaceId: personal.id, userId: user.id, role: 'member' },
          { client: trx },
        ),
      ),
    )
  })

  test('chat reads: marking one project as read leaves the others unread', async ({ assert }) => {
    const user = await createUser()
    const first = await createProject(user, 'First')
    const second = await createProject(user, 'Second')
    const before = DateTime.fromISO('2026-01-01T00:00:00Z')
    const read = await ChatRead.create({ projectId: first.id, userId: user.id, lastReadAt: before })
    await ChatRead.create({ projectId: second.id, userId: user.id, lastReadAt: before })

    read.lastReadAt = DateTime.fromISO('2026-06-01T00:00:00Z')
    await read.save()
    const reads = await ChatRead.query().where('userId', user.id)
    const lastRead = (projectId: string) =>
      reads.find((row) => row.projectId === projectId)?.lastReadAt.toMillis()
    assert.equal(lastRead(first.id), read.lastReadAt.toMillis())
    assert.equal(lastRead(second.id), before.toMillis())
    await read.delete()
    assert.lengthOf(await ChatRead.query().where('userId', user.id), 1)
  })

  test('version files: purging one version keeps the binary referenced by another', async ({
    assert,
  }) => {
    const user = await createUser()
    const project = await createProject(user, 'History')
    const version = (label: string | null) =>
      ProjectVersion.create({ projectId: project.id, kind: 'auto', s3Prefix: 'versions/', label })
    const expired = await version(null)
    const labelled = await version('Submitted')
    const fileId = '00000000-0000-4000-8000-000000000001'
    const sha256 = 'a'.repeat(64)
    const reference = await VersionFile.create({ versionId: expired.id, fileId, sha256 })
    await VersionFile.create({ versionId: labelled.id, fileId, sha256 })

    await reference.delete()
    const remaining = await VersionFile.query().where('sha256', sha256)
    assert.deepEqual(
      remaining.map((row) => row.versionId),
      [labelled.id],
    )
  })
})
