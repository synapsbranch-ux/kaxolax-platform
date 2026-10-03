import { describe, expect, it } from 'vitest'
import { spellcheckLanguageSchema } from './projects.js'
import {
  DEFAULT_TEAM_MEMBER_ROLE,
  hasWorkspacePermission,
  moveProjectInputSchema,
  teamAccessInputSchema,
  teamProjectRole,
  WORKSPACE_PERMISSIONS,
  workspaceRoleFromClerk,
  workspaceRoleSchema,
  workspaceSchema,
} from './workspaces.js'

describe('workspaces', () => {
  it('accepts a workspace returned by the API', () => {
    const workspace = {
      id: '0b9f8d3e-5a4c-4b1e-9f2a-3c4d5e6f7a8b',
      name: 'Personal workspace',
      type: 'personal',
      ownerId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      role: 'owner',
      aiEnabled: true,
      clerkOrganizationId: null,
      slug: null,
      memberCount: 1,
      createdAt: '2026-10-01T12:00:00.000Z',
    }
    expect(workspaceSchema.parse(workspace)).toEqual(workspace)
    const team = {
      ...workspace,
      type: 'team',
      role: 'member',
      clerkOrganizationId: 'org_2abc',
      slug: 'lab',
      memberCount: 3,
    }
    expect(workspaceSchema.parse(team)).toEqual(team)
    expect(workspaceSchema.safeParse({ ...workspace, role: 'viewer' }).success).toBe(false)
    expect(workspaceSchema.safeParse({ ...workspace, type: 'organisation' }).success).toBe(false)
    expect(workspaceSchema.safeParse({ ...workspace, aiEnabled: undefined }).success).toBe(false)
  })

  it('gives team admins the rights of the owner, members only reading and creating', () => {
    const table = workspaceRoleSchema.options.map((role) => [
      role,
      WORKSPACE_PERMISSIONS.filter((permission) => hasWorkspacePermission(role, permission)),
    ])
    expect(Object.fromEntries(table)).toEqual({
      owner: ['read', 'createProject', 'manageAi', 'manageProjects'],
      admin: ['read', 'createProject', 'manageAi', 'manageProjects'],
      member: ['read', 'createProject'],
    })
  })

  it('maps Clerk organization roles to workspace roles', () => {
    expect(workspaceRoleFromClerk('org:admin')).toBe('admin')
    // Forme courte du claim `o.rol` du jeton de session v2.
    expect(workspaceRoleFromClerk('admin')).toBe('admin')
    expect(workspaceRoleFromClerk('org:member')).toBe('member')
    expect(workspaceRoleFromClerk('org:billing_manager')).toBe('member')
  })

  it('derives the project role of a team member', () => {
    expect(teamProjectRole('admin', 'viewer')).toBe('owner')
    expect(teamProjectRole('member', DEFAULT_TEAM_MEMBER_ROLE)).toBe('editor')
    expect(teamProjectRole('member', 'reviewer')).toBe('reviewer')
  })

  it('validates moves and team access', () => {
    expect(moveProjectInputSchema.safeParse({ workspaceId: 'nope' }).success).toBe(false)
    expect(teamAccessInputSchema.safeParse({ role: 'owner' }).success).toBe(false)
    expect(teamAccessInputSchema.parse({ role: 'viewer' })).toEqual({ role: 'viewer' })
  })

  it('only knows the supported spellcheck languages', () => {
    expect(spellcheckLanguageSchema.options).toEqual(['en', 'fr'])
    expect(spellcheckLanguageSchema.safeParse('de').success).toBe(false)
  })
})
