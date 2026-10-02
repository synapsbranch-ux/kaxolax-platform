import { describe, expect, it } from 'vitest'
import { compileProjectBodySchema } from './compile.js'
import { projectEventSchema } from './events.js'
import {
  restoreVersionInputSchema,
  updateVersionInputSchema,
  VERSION_LABEL_MAX_LENGTH,
  versionListQuerySchema,
} from './history.js'

const ID = '0b9f8d3e-5a4c-4b1e-9f2a-3c4d5e6f7a8b'

describe('history contracts', () => {
  it('trims labels and refuses empty or too long ones', () => {
    expect(updateVersionInputSchema.parse({ label: '  Soumission  ' })).toEqual({
      label: 'Soumission',
    })
    expect(updateVersionInputSchema.parse({ label: null })).toEqual({ label: null })
    expect(updateVersionInputSchema.safeParse({ label: '   ' }).success).toBe(false)
    expect(
      updateVersionInputSchema.safeParse({ label: 'x'.repeat(VERSION_LABEL_MAX_LENGTH + 1) })
        .success,
    ).toBe(false)
  })

  it('restores the whole project or one entry', () => {
    expect(restoreVersionInputSchema.parse({ scope: 'project' })).toEqual({ scope: 'project' })
    expect(restoreVersionInputSchema.parse({ scope: 'entry', entryId: ID })).toEqual({
      scope: 'entry',
      entryId: ID,
    })
    expect(restoreVersionInputSchema.safeParse({ scope: 'entry' }).success).toBe(false)
    expect(restoreVersionInputSchema.safeParse({ scope: 'project', extra: 1 }).success).toBe(false)
  })

  it('pages the version list with a bounded limit', () => {
    expect(versionListQuerySchema.parse({})).toEqual({ limit: 50 })
    expect(versionListQuerySchema.parse({ limit: '10', before: ID })).toEqual({
      limit: 10,
      before: ID,
    })
    expect(versionListQuerySchema.safeParse({ limit: '1000' }).success).toBe(false)
  })

  it('carries the compile trigger and the version event', () => {
    expect(compileProjectBodySchema.parse({ trigger: 'auto' })).toEqual({ trigger: 'auto' })
    expect(compileProjectBodySchema.safeParse({ trigger: 'cron' }).success).toBe(false)
    expect(
      projectEventSchema.parse({
        type: 'version.created',
        versionId: ID,
        kind: 'compile',
        actorId: null,
      }).type,
    ).toBe('version.created')
  })
})
