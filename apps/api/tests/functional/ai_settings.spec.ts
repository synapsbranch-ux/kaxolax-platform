import {
  projectAiSettingsSchema,
  workspaceAiSettingsSchema,
  workspaceSchema,
} from '@kaxolax/contracts'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import ProjectMember from '#models/project_member'
import Workspace from '#models/workspace'
import WorkspaceMember from '#models/workspace_member'
import { createProject } from '#services/project_service'
import { FakeAnthropicApi, useFakeClaude } from '#tests/claude'
import { createUser } from '#tests/helpers'

test.group('ai settings: project and workspace switches', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => useFakeClaude(new FakeAnthropicApi()))

  test('enables the AI by default and lets the project owner switch it', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const project = await createProject(owner, 'Thesis')
    const shown = await client.get(`/api/v1/projects/${project.id}/ai`).loginAs(owner)
    shown.assertStatus(200)
    assert.deepEqual(projectAiSettingsSchema.parse(shown.body()), {
      projectId: project.id,
      projectEnabled: true,
      workspaceEnabled: true,
      configured: true,
      enabled: true,
      canManage: true,
    })
    const details = await client.get(`/api/v1/projects/${project.id}`).loginAs(owner)
    details.assertBodyContains({ project: { aiEnabled: true } })

    const off = await client
      .put(`/api/v1/projects/${project.id}/ai`)
      .json({ enabled: false })
      .loginAs(owner)
    off.assertStatus(200)
    assert.include(off.body(), { projectEnabled: false, enabled: false })
    const listed = await client.get('/api/v1/projects').loginAs(owner)
    listed.assertBodyContains({ projects: [{ id: project.id, aiEnabled: false }] })

    const invalid = await client
      .put(`/api/v1/projects/${project.id}/ai`)
      .json({ enabled: 'no' })
      .loginAs(owner)
    invalid.assertStatus(422)
  })

  test('refuses the switch to the other roles, hides it from strangers', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const editor = await createUser()
    const project = await createProject(owner, 'Shared')
    await ProjectMember.create({ projectId: project.id, userId: editor.id, role: 'editor' })
    const seen = await client.get(`/api/v1/projects/${project.id}/ai`).loginAs(editor)
    seen.assertStatus(200)
    assert.isFalse(projectAiSettingsSchema.parse(seen.body()).canManage)
    const refused = await client
      .put(`/api/v1/projects/${project.id}/ai`)
      .json({ enabled: false })
      .loginAs(editor)
    refused.assertStatus(403)
    refused.assertBodyContains({ code: 'E_PROJECT_FORBIDDEN' })

    const stranger = await createUser()
    ;(await client.get(`/api/v1/projects/${project.id}/ai`).loginAs(stranger)).assertStatus(404)
  })

  test('lets the workspace owner disable the AI for all its projects', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const project = await createProject(owner, 'In workspace')
    const workspaces = await client.get('/api/v1/workspaces').loginAs(owner)
    const [personal] = (workspaces.body() as { workspaces: unknown[] }).workspaces.map((entry) =>
      workspaceSchema.parse(entry),
    )
    assert.isTrue(personal?.aiEnabled)

    const off = await client
      .put(`/api/v1/workspaces/${project.workspaceId}/ai`)
      .json({ enabled: false })
      .loginAs(owner)
    off.assertStatus(200)
    assert.deepEqual(workspaceAiSettingsSchema.parse(off.body()), {
      workspaceId: project.workspaceId,
      enabled: false,
      configured: true,
      canManage: true,
    })
    const settings = await client.get(`/api/v1/projects/${project.id}/ai`).loginAs(owner)
    assert.include(settings.body(), {
      projectEnabled: true,
      workspaceEnabled: false,
      enabled: false,
    })

    // Membre sans droit sur le workspace (rôle `member`, tâche 10) : lecture seule.
    const member = await createUser()
    const team = await Workspace.create({ name: 'Team', type: 'team', ownerId: owner.id })
    await WorkspaceMember.create({ workspaceId: team.id, userId: member.id, role: 'member' })
    const read = await client.get(`/api/v1/workspaces/${team.id}/ai`).loginAs(member)
    read.assertStatus(200)
    assert.isFalse(workspaceAiSettingsSchema.parse(read.body()).canManage)
    const refused = await client
      .put(`/api/v1/workspaces/${team.id}/ai`)
      .json({ enabled: false })
      .loginAs(member)
    refused.assertStatus(403)
    refused.assertBodyContains({ code: 'E_WORKSPACE_FORBIDDEN' })
    ;(
      await client.get(`/api/v1/workspaces/${team.id}/ai`).loginAs(await createUser())
    ).assertStatus(404)
  })

  test('says when the AI is not configured on the server', async ({ client, assert }) => {
    const restore = useFakeClaude(null)
    try {
      const owner = await createUser()
      const project = await createProject(owner, 'No key')
      const response = await client.get(`/api/v1/projects/${project.id}/ai`).loginAs(owner)
      assert.include(response.body(), { configured: false, enabled: false, projectEnabled: true })
    } finally {
      restore()
    }
  })
})
