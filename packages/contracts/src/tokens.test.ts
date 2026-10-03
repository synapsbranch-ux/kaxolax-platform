import { describe, expect, it } from 'vitest'
import {
  createPersonalAccessTokenInputSchema,
  PERSONAL_ACCESS_TOKEN_MAX_DAYS,
  personalAccessTokenSecretSchema,
  tokenScopeAllows,
} from './tokens.js'

const projectId = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'

describe('personal access token contracts', () => {
  it('applies the defaults: all projects, 90 days', () => {
    expect(createPersonalAccessTokenInputSchema.parse({ name: ' MCP ', scopes: ['read'] })).toEqual(
      { name: 'MCP', scopes: ['read'], projectIds: null, expiresInDays: 90 },
    )
  })

  it('refuses invalid tokens', () => {
    const input = { name: 'MCP', scopes: ['read'], projectIds: [projectId], expiresInDays: 30 }
    expect(createPersonalAccessTokenInputSchema.safeParse(input).success).toBe(true)
    for (const invalid of [
      { ...input, name: '  ' },
      { ...input, scopes: [] },
      { ...input, scopes: ['read', 'read'] },
      { ...input, scopes: ['admin'] },
      { ...input, projectIds: [] },
      { ...input, projectIds: [projectId, projectId] },
      { ...input, projectIds: ['not-a-uuid'] },
      { ...input, expiresInDays: 0 },
      { ...input, expiresInDays: PERSONAL_ACCESS_TOKEN_MAX_DAYS + 1 },
      { ...input, userId: projectId },
    ]) {
      expect(createPersonalAccessTokenInputSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('lets write cover read, never the reverse', () => {
    expect(tokenScopeAllows(['write'], 'read')).toBe(true)
    expect(tokenScopeAllows(['read'], 'read')).toBe(true)
    expect(tokenScopeAllows(['read'], 'write')).toBe(false)
  })

  it('recognises the secret format', () => {
    const secret = `kxp_${'a'.repeat(12)}_${'B'.repeat(43)}`
    expect(personalAccessTokenSecretSchema.safeParse(secret).success).toBe(true)
    for (const invalid of [
      secret.slice(0, -1),
      secret.replace('kxp_', 'kxs_'),
      `kxp_${'a'.repeat(11)}-_${'B'.repeat(43)}`,
    ]) {
      expect(personalAccessTokenSecretSchema.safeParse(invalid).success).toBe(false)
    }
  })
})
