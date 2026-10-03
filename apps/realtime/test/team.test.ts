import { randomUUID } from 'node:crypto'
import { memberChangedResponseSchema } from '@kaxolax/contracts'
import type pg from 'pg'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import type { DocumentStore } from '../src/store.js'
import {
  type Client,
  connect,
  eventually,
  INTERNAL_TOKEN,
  openPool,
  openStore,
  type RealtimeServer,
  seedProject,
  startServer,
  tokenFor,
} from './helpers.js'

/**
 * Workspaces d'équipe (tâche 10) : rôle dérivé de l'appartenance à l'équipe (vue
 * `project_access_roles`), retrait de l'équipe appliqué aux connexions ouvertes comme le retrait
 * d'un membre du projet, stockage mutualisé de l'équipe.
 */

let store: DocumentStore
let pool: pg.Pool
let running: { server: RealtimeServer; url: string; httpUrl: string }
const clients: Client[] = []

function track(client: Client): Client {
  clients.push(client)
  return client
}

beforeAll(async () => {
  store = openStore()
  pool = openPool()
  running = await startServer(store)
})

afterEach(() => {
  for (const client of clients.splice(0)) client.destroy()
})

afterAll(async () => {
  await running.server.destroy()
  await store.close()
  await pool.end()
})

/** Projet de test déplacé dans un workspace d'équipe ; le propriétaire en est administrateur. */
async function seedTeamProject() {
  const seed = await seedProject(pool)
  const workspaceId = randomUUID()
  const organizationId = `org_${randomUUID().replaceAll('-', '').slice(0, 24)}`
  await pool.query(
    `INSERT INTO workspaces (id, name, type, owner_id, clerk_organization_id)
     VALUES ($1, 'Lab', 'team', $2, $3)`,
    [workspaceId, seed.owner, organizationId],
  )
  await pool.query('UPDATE projects SET workspace_id = $1 WHERE id = $2', [
    workspaceId,
    seed.projectId,
  ])
  const addTeamMember = async (role: 'admin' | 'member') => {
    const id = await seed.addUser()
    await pool.query(
      'INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, $3)',
      [workspaceId, id, role],
    )
    return id
  }
  await pool.query(
    `INSERT INTO workspace_members (workspace_id, user_id, role) VALUES ($1, $2, 'admin')`,
    [workspaceId, seed.owner],
  )
  return { ...seed, workspaceId, organizationId, addTeamMember }
}

async function memberChanged(projectId: string, userId: string) {
  const response = await fetch(
    `${running.httpUrl}/internal/projects/${projectId}/members/${userId}/changed`,
    { method: 'POST', headers: { 'x-internal-token': INTERNAL_TOKEN } },
  )
  expect(response.status).toBe(200)
  return memberChangedResponseSchema.parse(await response.json())
}

const now = () => Math.floor(Date.now() / 1000)

describe('team workspaces', () => {
  it('derives the role from the team: admins own, members get the team role', async () => {
    const seed = await seedTeamProject()
    const admin = await seed.addTeamMember('admin')
    const member = await seed.addTeamMember('member')
    const outsider = await seed.addUser()
    expect(await store.memberRole(seed.projectId, admin, now())).toBe('owner')
    expect(await store.memberRole(seed.projectId, member, now())).toBe('editor')
    expect(await store.memberRole(seed.projectId, outsider, now())).toBeNull()
    await pool.query(`UPDATE projects SET team_role = 'viewer' WHERE id = $1`, [seed.projectId])
    expect(await store.memberRole(seed.projectId, member, now())).toBe('viewer')
    // Une invitation individuelle plus élevée l'emporte.
    await pool.query(
      `INSERT INTO project_members (project_id, user_id, role) VALUES ($1, $2, 'reviewer')`,
      [seed.projectId, member],
    )
    expect(await store.memberRole(seed.projectId, member, now())).toBe('reviewer')
  })

  it('disconnects a member removed from the team in less than 2 seconds', async () => {
    const seed = await seedTeamProject()
    const member = await seed.addTeamMember('member')
    const token = tokenFor(member, seed.projectId, { role: 'editor' })
    const client = track(connect(running.url, seed.projectId, seed.documentId, token))
    await client.ready
    let closed = false
    client.provider.on('close', () => {
      closed = true
    })

    await pool.query('DELETE FROM workspace_members WHERE workspace_id = $1 AND user_id = $2', [
      seed.workspaceId,
      member,
    ])
    const start = Date.now()
    expect(await memberChanged(seed.projectId, member)).toEqual({ closed: 1, updated: 0 })
    await eventually(() => closed, 2_000)
    expect(Date.now() - start).toBeLessThan(2_000)

    const again = track(connect(running.url, seed.projectId, seed.documentId, token))
    await expect(again.ready).rejects.toThrow('authentication failed')
  })

  it('counts the pooled storage of the team against the plan of the organization', async () => {
    const seed = await seedTeamProject()
    // Autre projet de l'équipe, d'un autre membre : compté dans le stockage mutualisé.
    const member = await seed.addTeamMember('member')
    const other = randomUUID()
    await pool.query(
      `INSERT INTO projects (id, owner_id, workspace_id, name) VALUES ($1, $2, $3, 'Autre')`,
      [other, member, seed.workspaceId],
    )
    await pool.query(
      `INSERT INTO files (id, project_id, name, s3_key, sha256, size_bytes, mime_type)
       VALUES ($1, $2, 'big.bin', $3, $4, 4096, 'application/octet-stream')`,
      [randomUUID(), other, `projects/${other}/big.bin`, 'a'.repeat(64)],
    )
    const free = await store.ownerStorage(seed.projectId)
    expect(free?.plan).toBe('free')
    expect(free?.ownerId).toBe(seed.owner)
    expect(free?.used).toBeGreaterThanOrEqual(4096)

    await pool.query(
      `INSERT INTO subscriptions (clerk_organization_id, clerk_subscription_item_id, plan_slug, status)
       VALUES ($1, $2, 'team', 'active')`,
      [seed.organizationId, `csi_${randomUUID()}`],
    )
    const team = await store.ownerStorage(seed.projectId)
    expect(team?.plan).toBe('team')
    expect(team?.limit).toBe(50 * 1024 * 1024 * 1024)
    expect(team?.used).toBe(free?.used)
  })
})
