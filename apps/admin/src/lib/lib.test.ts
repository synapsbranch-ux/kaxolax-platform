import { describe, expect, it } from 'vitest'
import { hasAdminAccess } from './access'
import { formatBytes, formatDuration, isoToLocalInput, localInputToIso } from './format'

describe('hasAdminAccess', () => {
  const admin = { sub: 'user_1', metadata: { role: 'admin' }, fva: [3, 3] }

  it('accepte un admin avec un second facteur vérifié', () => {
    expect(hasAdminAccess(admin)).toBe(true)
    expect(hasAdminAccess({ ...admin, fva: [120, 0] })).toBe(true)
  })

  it('refuse sans rôle admin', () => {
    expect(hasAdminAccess({ ...admin, metadata: {} })).toBe(false)
    expect(hasAdminAccess({ ...admin, metadata: { role: 'Admin' } })).toBe(false)
    expect(hasAdminAccess({ ...admin, metadata: undefined })).toBe(false)
    expect(hasAdminAccess({ ...admin, metadata: [] })).toBe(false)
  })

  it('refuse sans second facteur vérifié dans la session', () => {
    expect(hasAdminAccess({ ...admin, fva: [3, -1] })).toBe(false)
    expect(hasAdminAccess({ ...admin, fva: undefined })).toBe(false)
    expect(hasAdminAccess({ ...admin, fva: [3] })).toBe(false)
    expect(hasAdminAccess({ ...admin, fva: [3, '0'] })).toBe(false)
  })

  it('refuse des claims absents', () => {
    expect(hasAdminAccess(null)).toBe(false)
    expect(hasAdminAccess(undefined)).toBe(false)
  })
})

describe('format', () => {
  it('formate les tailles', () => {
    expect(formatBytes(0)).toBe('0 o')
    expect(formatBytes(1536)).toBe('1,5 Ko')
    expect(formatBytes(500 * 1024 * 1024)).toBe('500 Mo')
  })

  it('formate les durées', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(850)).toBe('850 ms')
    expect(formatDuration(12_400)).toBe('12,4 s')
    expect(formatDuration(185_000)).toBe('3 min 05 s')
  })

  it('convertit les champs datetime-local aller-retour', () => {
    expect(localInputToIso('')).toBeNull()
    expect(localInputToIso('pas une date')).toBeNull()
    const iso = localInputToIso('2026-10-01T09:30')
    expect(iso).not.toBeNull()
    expect(isoToLocalInput(iso)).toBe('2026-10-01T09:30')
  })
})
