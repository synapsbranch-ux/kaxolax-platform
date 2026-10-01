import { describe, expect, it } from 'vitest'
import { spellcheckLanguageSchema } from './projects.js'
import { workspaceSchema } from './workspaces.js'

describe('workspaces', () => {
  it('accepts a workspace returned by the API', () => {
    const workspace = {
      id: '0b9f8d3e-5a4c-4b1e-9f2a-3c4d5e6f7a8b',
      name: 'Personal workspace',
      type: 'personal',
      ownerId: '1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f',
      role: 'owner',
      createdAt: '2026-10-01T12:00:00.000Z',
    }
    expect(workspaceSchema.parse(workspace)).toEqual(workspace)
    expect(workspaceSchema.safeParse({ ...workspace, role: 'viewer' }).success).toBe(false)
    expect(workspaceSchema.safeParse({ ...workspace, type: 'organisation' }).success).toBe(false)
  })

  it('only knows the supported spellcheck languages', () => {
    expect(spellcheckLanguageSchema.options).toEqual(['en', 'fr'])
    expect(spellcheckLanguageSchema.safeParse('de').success).toBe(false)
  })
})
