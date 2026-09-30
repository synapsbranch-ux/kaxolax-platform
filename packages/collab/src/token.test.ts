import { describe, expect, it } from 'vitest'
import { signRealtimeToken, verifyRealtimeToken } from './token.js'

const secret = 's'.repeat(40)
const claims = {
  sub: '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f',
  projectId: '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a',
  role: 'owner' as const,
  exp: 2_000_000_000,
}

describe('realtime token', () => {
  it('round-trips', () => {
    expect(verifyRealtimeToken(signRealtimeToken(claims, secret), secret, 1_000)).toEqual(claims)
  })

  it('rejects an expired token', () => {
    expect(verifyRealtimeToken(signRealtimeToken(claims, secret), secret, 2_000_000_000)).toBeNull()
  })

  it('rejects a token signed with another secret or tampered with', () => {
    const token = signRealtimeToken(claims, secret)
    expect(verifyRealtimeToken(token, 'x'.repeat(40), 1_000)).toBeNull()
    const [version, , signature] = token.split('.')
    const forged = Buffer.from(
      JSON.stringify({ ...claims, role: 'owner', projectId: claims.sub }),
    ).toString('base64url')
    expect(
      verifyRealtimeToken(`${version ?? ''}.${forged}.${signature ?? ''}`, secret, 1_000),
    ).toBeNull()
  })

  it.each(['', 'garbage', 'v1.a.b.c', 'v2.a.b'])('rejects %j', (token) => {
    expect(verifyRealtimeToken(token, secret, 1_000)).toBeNull()
  })
})
