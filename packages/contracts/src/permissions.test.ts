import { describe, expect, it } from 'vitest'
import {
  assignableRoleSchema,
  canComment,
  canCompile,
  canEdit,
  canLeave,
  canManageAi,
  canManageMembers,
  canManageProject,
  canManageShareLinks,
  canRead,
  canTransferOwnership,
  hasPermission,
  higherRole,
  isRoleAtLeast,
  PROJECT_PERMISSIONS,
  permissionsOf,
} from './permissions.js'
import { projectRoleSchema } from './realtime.js'

describe('project permissions', () => {
  it('follows the role matrix of the sharing specification', () => {
    expect(permissionsOf('owner')).toEqual([
      'read',
      'compile',
      'comment',
      'edit',
      'manageMembers',
      'manageShareLinks',
      'transferOwnership',
      'manageProject',
      'manageAi',
    ])
    expect(permissionsOf('editor')).toEqual(['read', 'compile', 'comment', 'edit', 'leave'])
    expect(permissionsOf('reviewer')).toEqual(['read', 'compile', 'comment', 'leave'])
    expect(permissionsOf('viewer')).toEqual(['read', 'compile', 'leave'])
  })

  it('exposes one helper per permission', () => {
    const table = projectRoleSchema.options.map((role) => [
      role,
      [
        canRead(role),
        canCompile(role),
        canComment(role),
        canEdit(role),
        canManageMembers(role),
        canManageShareLinks(role),
        canTransferOwnership(role),
        canManageProject(role),
        canManageAi(role),
        canLeave(role),
      ],
    ])
    expect(Object.fromEntries(table)).toEqual({
      owner: [true, true, true, true, true, true, true, true, true, false],
      editor: [true, true, true, true, false, false, false, false, false, true],
      reviewer: [true, true, true, false, false, false, false, false, false, true],
      viewer: [true, true, false, false, false, false, false, false, false, true],
    })
  })

  it('agrees between hasPermission and permissionsOf for every pair', () => {
    for (const role of projectRoleSchema.options) {
      for (const permission of PROJECT_PERMISSIONS) {
        expect(hasPermission(role, permission)).toBe(permissionsOf(role).includes(permission))
      }
    }
  })

  it('ranks roles and keeps the higher one', () => {
    expect(isRoleAtLeast('owner', 'editor')).toBe(true)
    expect(isRoleAtLeast('editor', 'editor')).toBe(true)
    expect(isRoleAtLeast('reviewer', 'editor')).toBe(false)
    expect(isRoleAtLeast('viewer', 'reviewer')).toBe(false)
    expect(higherRole('viewer', 'editor')).toBe('editor')
    expect(higherRole('owner', 'editor')).toBe('owner')
    expect(higherRole('reviewer', 'viewer')).toBe('reviewer')
  })

  it('never assigns ownership through an invitation, a link or a role change', () => {
    expect(assignableRoleSchema.options).toEqual(['editor', 'reviewer', 'viewer'])
    expect(assignableRoleSchema.safeParse('owner').success).toBe(false)
  })
})
