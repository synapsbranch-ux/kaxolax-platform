import type { CompileResult } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import { BuildUpdates, buildOutcome, laterStatus, phaseLabel, phaseOf, pollDelayMs } from './builds'

const BUILD = '00000000-0000-4000-8000-0000000000b1'
const OTHER = '00000000-0000-4000-8000-0000000000b2'
const RESULT: CompileResult = {
  buildId: BUILD,
  status: 'success',
  durationMs: 1200,
  pdfUrl: 'https://outputs.example.org/output.pdf',
  logUrl: 'https://outputs.example.org/output.log',
  entries: [],
}

describe('asynchronous builds', () => {
  it('never moves a build back', () => {
    expect(laterStatus(null, 'queued')).toBe('queued')
    expect(laterStatus('running', 'preparing')).toBe('running')
    expect(laterStatus('preparing', 'running')).toBe('running')
    expect(laterStatus('success', 'running')).toBe('success')
    // Entre deux statuts finaux, le premier reçu reste.
    expect(laterStatus('cancelled', 'error')).toBe('cancelled')
  })

  it('maps statuses to the phases of the status pill', () => {
    expect(phaseOf('queued')).toBe('queued')
    expect(phaseOf('preparing')).toBe('preparing')
    expect(phaseOf('running')).toBe('running')
    expect(phaseOf('failure')).toBeNull()
    expect(phaseLabel('preparing')).toBe('Préparation du compilateur…')
    expect(phaseLabel('queued')).toBe('En attente…')
    expect(phaseLabel('running')).toBe('Compilation…')
  })

  it('keeps the latest state when the 202 response arrives after events', () => {
    const updates = new BuildUpdates()
    updates.record({ buildId: BUILD, status: 'running', result: null })
    // Réponse 202 en retard (`preparing`) : ignorée.
    expect(updates.record({ buildId: BUILD, status: 'preparing', result: null }).status).toBe(
      'running',
    )
    const final = updates.record({ buildId: BUILD, status: 'success', result: RESULT })
    expect(final).toEqual({ buildId: BUILD, status: 'success', result: RESULT })
    // Sondage arrivé après l'événement final : rien ne change.
    expect(updates.record({ buildId: BUILD, status: 'running', result: null })).toEqual(final)
  })

  it('completes an omitted result with the one read from the API', () => {
    const updates = new BuildUpdates()
    const omitted = updates.record({
      buildId: BUILD,
      status: 'failure',
      result: null,
      resultOmitted: true,
    })
    expect(buildOutcome(omitted)).toEqual({ kind: 'fetch' })
    const read = updates.record({ buildId: BUILD, status: 'failure', result: RESULT })
    expect(read.result).toEqual(RESULT)
    expect(buildOutcome(read)).toEqual({ kind: 'result', result: RESULT })
    expect(buildOutcome({ buildId: BUILD, status: 'cancelled', result: null })).toEqual({
      kind: 'cancelled',
    })
  })

  it('forgets the oldest builds beyond its capacity', () => {
    const updates = new BuildUpdates(1)
    updates.record({ buildId: BUILD, status: 'queued', result: null })
    updates.record({ buildId: OTHER, status: 'queued', result: null })
    expect(updates.get(BUILD)).toBeUndefined()
    expect(updates.get(OTHER)?.status).toBe('queued')
  })

  it('polls quickly at first, then less often', () => {
    expect(pollDelayMs(0)).toBe(3_000)
    expect(pollDelayMs(60_000)).toBe(5_000)
    expect(pollDelayMs(300_000)).toBe(10_000)
  })
})
