import type { CompileResult } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import { type BuildUpdate, MAX_BUILD_WAIT_MS, WarmSchedule } from './builds'
import {
  type Clock,
  CompileController,
  type CompileResponse,
  type CompileTrigger,
  LOST_BUILD_MESSAGE,
} from './compile-controller'

const BUILD = '00000000-0000-4000-8000-0000000000b1'
const OTHER = '00000000-0000-4000-8000-0000000000b2'

function resultOf(buildId: string, status: CompileResult['status'] = 'success'): CompileResult {
  return {
    buildId,
    status,
    durationMs: 1000,
    pdfUrl: `https://outputs.example.org/${buildId}.pdf`,
    logUrl: `https://outputs.example.org/${buildId}.log`,
    entries: [],
  }
}

/** Promesse résolue à la main par le test. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined
  let reject: (error: unknown) => void = () => undefined
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve
    reject = onReject
  })
  return { promise, resolve, reject }
}

/** Horloge manuelle : `advance` déclenche les minuteries échues. */
class FakeClock implements Clock {
  current = 0
  private timers = new Map<number, { at: number; callback: () => void }>()
  private next = 1

  now = () => this.current
  setTimeout = (callback: () => void, ms: number) => {
    const id = this.next++
    this.timers.set(id, { at: this.current + ms, callback })
    return id
  }
  clearTimeout = (handle: unknown) => {
    this.timers.delete(handle as number)
  }

  get pending(): number {
    return this.timers.size
  }

  async advance(ms: number) {
    this.current += ms
    for (const [id, timer] of [...this.timers]) {
      if (timer.at > this.current) continue
      this.timers.delete(id)
      timer.callback()
    }
    await flushPromises()
  }
}

async function flushPromises() {
  for (let index = 0; index < 10; index++) await Promise.resolve()
}

function setup() {
  const clock = new FakeClock()
  const compiles: ReturnType<typeof deferred<CompileResponse>>[] = []
  const triggers: CompileTrigger[] = []
  const builds: { buildId: string; reply: ReturnType<typeof deferred<BuildUpdate>> }[] = []
  const stops: ReturnType<typeof deferred<{ stopped: boolean }>>[] = []
  const errors: (string | null)[] = []
  const controller = new CompileController(
    {
      flush: () => Promise.resolve(),
      compile: (trigger) => {
        triggers.push(trigger)
        const reply = deferred<CompileResponse>()
        compiles.push(reply)
        return reply.promise
      },
      build: (buildId) => {
        const reply = deferred<BuildUpdate>()
        builds.push({ buildId, reply })
        return reply.promise
      },
      stop: () => {
        const reply = deferred<{ stopped: boolean }>()
        stops.push(reply)
        return reply.promise
      },
    },
    {
      onChange: () => undefined,
      onError: (message) => errors.push(message),
      describeError: (error) => (error instanceof Error ? error.message : 'error'),
    },
    clock,
  )
  return { clock, controller, compiles, triggers, builds, stops, errors }
}

describe('compile controller, synchronous mode', () => {
  it('shows the result of the request', async () => {
    const { controller, compiles } = setup()
    const done = controller.compile()
    await flushPromises()
    expect(controller.state.phase).toBe('requesting')
    compiles[0]?.resolve({ kind: 'result', result: resultOf(BUILD) })
    await done
    expect(controller.state.phase).toBeNull()
    expect(controller.state.result?.buildId).toBe(BUILD)
  })

  it('keeps only the last response after a double click', async () => {
    const { controller, compiles } = setup()
    const first = controller.compile()
    await flushPromises()
    compiles[0]?.resolve({ kind: 'result', result: resultOf(BUILD) })
    await first
    // Le mode est connu : un second clic pendant une demande la remplace.
    const second = controller.compile()
    await flushPromises()
    const third = controller.compile()
    await flushPromises()
    expect(compiles).toHaveLength(3)
    compiles[2]?.resolve({ kind: 'result', result: resultOf(OTHER) })
    await third
    compiles[1]?.resolve({ kind: 'result', result: resultOf(BUILD, 'failure') })
    await second
    expect(controller.state.result?.buildId).toBe(OTHER)
    expect(controller.state.phase).toBeNull()
  })

  it('reports a request error and stops compiling', async () => {
    const { controller, compiles, errors } = setup()
    const done = controller.compile()
    await flushPromises()
    compiles[0]?.reject(new Error('boom'))
    await done
    expect(controller.state.phase).toBeNull()
    expect(errors).toEqual([null, 'boom'])
  })
})

describe('compile controller, asynchronous mode', () => {
  it('follows events of its build and ignores other builds', async () => {
    const { controller, compiles, builds } = setup()
    const done = controller.compile()
    await flushPromises()
    compiles[0]?.resolve({ kind: 'accepted', buildId: BUILD, status: 'preparing' })
    await done
    expect(controller.state.phase).toBe('preparing')
    controller.onEvent({ buildId: OTHER, status: 'success', result: resultOf(OTHER) })
    expect(controller.state.phase).toBe('preparing')
    controller.onEvent({ buildId: BUILD, status: 'queued', result: null })
    expect(controller.state.phase).toBe('preparing')
    controller.onEvent({ buildId: BUILD, status: 'running', result: null })
    expect(controller.state.phase).toBe('running')
    controller.onEvent({ buildId: BUILD, status: 'failure', result: resultOf(BUILD, 'failure') })
    await flushPromises()
    expect(controller.state.phase).toBeNull()
    expect(controller.state.result?.status).toBe('failure')
    // Événement en retard du même build : sans effet.
    controller.onEvent({ buildId: BUILD, status: 'running', result: null })
    expect(controller.state.phase).toBeNull()
    expect(builds).toHaveLength(0)
  })

  it('uses events received before the 202 response', async () => {
    const { controller, compiles } = setup()
    const done = controller.compile()
    await flushPromises()
    controller.onEvent({ buildId: BUILD, status: 'running', result: null })
    controller.onEvent({ buildId: BUILD, status: 'success', result: resultOf(BUILD) })
    expect(controller.state.phase).toBe('requesting')
    compiles[0]?.resolve({ kind: 'accepted', buildId: BUILD, status: 'queued' })
    await done
    await flushPromises()
    expect(controller.state.phase).toBeNull()
    expect(controller.state.result?.buildId).toBe(BUILD)
    expect(controller.trackedBuildId).toBeNull()
  })

  it('reads an omitted result from the API', async () => {
    const { controller, compiles, builds } = setup()
    const done = controller.compile()
    await flushPromises()
    compiles[0]?.resolve({ kind: 'accepted', buildId: BUILD, status: 'queued' })
    await done
    controller.onEvent({ buildId: BUILD, status: 'success', result: null, resultOmitted: true })
    await flushPromises()
    expect(builds.map((build) => build.buildId)).toEqual([BUILD])
    builds[0]?.reply.resolve({ buildId: BUILD, status: 'success', result: resultOf(BUILD) })
    await flushPromises()
    expect(controller.state.result?.buildId).toBe(BUILD)
    expect(controller.state.phase).toBeNull()
  })

  it('falls back to polling with a growing delay when no event arrives', async () => {
    const { clock, controller, compiles, builds } = setup()
    const done = controller.compile()
    await flushPromises()
    compiles[0]?.resolve({ kind: 'accepted', buildId: BUILD, status: 'queued' })
    await done
    await clock.advance(2_999)
    expect(builds).toHaveLength(0)
    await clock.advance(1)
    expect(builds).toHaveLength(1)
    builds[0]?.reply.resolve({ buildId: BUILD, status: 'running', result: null })
    await flushPromises()
    expect(controller.state.phase).toBe('running')
    // Échec réseau d'un sondage : on réessaie.
    await clock.advance(3_000)
    builds[1]?.reply.reject(new Error('offline'))
    await flushPromises()
    await clock.advance(30_000)
    expect(builds).toHaveLength(3)
    // Après 30 s, le délai passe à 5 s.
    builds[2]?.reply.resolve({ buildId: BUILD, status: 'running', result: null })
    await flushPromises()
    await clock.advance(4_999)
    expect(builds).toHaveLength(3)
    await clock.advance(1)
    expect(builds).toHaveLength(4)
    builds[3]?.reply.resolve({ buildId: BUILD, status: 'success', result: resultOf(BUILD) })
    await flushPromises()
    expect(controller.state.phase).toBeNull()
    expect(controller.state.result?.buildId).toBe(BUILD)
    // État final : plus aucun sondage.
    expect(clock.pending).toBe(0)
  })

  it('stops polling once an event brings the final state', async () => {
    const { clock, controller, compiles, builds } = setup()
    const done = controller.compile()
    await flushPromises()
    compiles[0]?.resolve({ kind: 'accepted', buildId: BUILD, status: 'queued' })
    await done
    controller.onEvent({ buildId: BUILD, status: 'success', result: resultOf(BUILD) })
    await flushPromises()
    expect(clock.pending).toBe(0)
    await clock.advance(60_000)
    expect(builds).toHaveLength(0)
  })

  it('gives up after the maximum wait', async () => {
    const { clock, controller, compiles, builds, errors } = setup()
    const done = controller.compile()
    await flushPromises()
    compiles[0]?.resolve({ kind: 'accepted', buildId: BUILD, status: 'queued' })
    await done
    while (controller.trackedBuildId !== null) {
      await clock.advance(10_000)
      builds.at(-1)?.reply.resolve({ buildId: BUILD, status: 'running', result: null })
      await flushPromises()
      expect(clock.current).toBeLessThanOrEqual(MAX_BUILD_WAIT_MS + 20_000)
    }
    expect(controller.state.phase).toBeNull()
    expect(errors.at(-1)).toBe(LOST_BUILD_MESSAGE)
  })

  it('queues one relaunch on double click instead of a concurrent build', async () => {
    const { controller, compiles } = setup()
    const first = controller.compile()
    await flushPromises()
    // Mode encore inconnu : le second clic attend la première réponse.
    await controller.compile()
    await controller.compile()
    expect(compiles).toHaveLength(1)
    compiles[0]?.resolve({ kind: 'accepted', buildId: BUILD, status: 'queued' })
    await first
    await controller.compile()
    expect(compiles).toHaveLength(1)
    controller.onEvent({ buildId: BUILD, status: 'success', result: resultOf(BUILD) })
    await flushPromises()
    // Une seule relance, avec le contenu actuel.
    expect(compiles).toHaveLength(2)
    expect(controller.state.phase).toBe('requesting')
    compiles[1]?.resolve({ kind: 'accepted', buildId: OTHER, status: 'queued' })
    await flushPromises()
    controller.onEvent({ buildId: OTHER, status: 'success', result: resultOf(OTHER) })
    await flushPromises()
    expect(compiles).toHaveLength(2)
    expect(controller.state.result?.buildId).toBe(OTHER)
  })

  it('relaunches as manual when any queued request was manual (history version)', async () => {
    const { controller, compiles, triggers } = setup()
    const first = controller.compile('auto')
    await flushPromises()
    compiles[0]?.resolve({ kind: 'accepted', buildId: BUILD, status: 'queued' })
    await first
    await controller.compile('manual')
    await controller.compile('auto')
    controller.onEvent({ buildId: BUILD, status: 'success', result: resultOf(BUILD) })
    await flushPromises()
    expect(triggers).toEqual(['auto', 'manual'])
  })

  it('follows a build already running, then compiles again', async () => {
    const { controller, compiles } = setup()
    const done = controller.compile()
    await flushPromises()
    compiles[0]?.resolve({ kind: 'in-progress', buildId: OTHER })
    await done
    expect(controller.trackedBuildId).toBe(OTHER)
    expect(controller.state.phase).toBe('queued')
    controller.onEvent({ buildId: OTHER, status: 'success', result: resultOf(OTHER) })
    await flushPromises()
    expect(compiles).toHaveLength(2)
  })

  it('cancels the tracked build and the pending relaunch', async () => {
    const { clock, controller, compiles, stops } = setup()
    const done = controller.compile()
    await flushPromises()
    compiles[0]?.resolve({ kind: 'accepted', buildId: BUILD, status: 'queued' })
    await done
    await controller.compile()
    const stopping = controller.stop()
    stops[0]?.resolve({ stopped: true })
    await stopping
    await flushPromises()
    expect(controller.state.phase).toBeNull()
    expect(controller.trackedBuildId).toBeNull()
    expect(clock.pending).toBe(0)
    // Événement `cancelled` puis événement tardif : sans effet, pas de relance.
    controller.onEvent({ buildId: BUILD, status: 'cancelled', result: null })
    controller.onEvent({ buildId: BUILD, status: 'running', result: null })
    await flushPromises()
    expect(controller.state.phase).toBeNull()
    expect(compiles).toHaveLength(1)
  })

  it('reads the state at once when the build ended before the stop', async () => {
    const { clock, controller, compiles, stops, builds } = setup()
    const done = controller.compile()
    await flushPromises()
    compiles[0]?.resolve({ kind: 'accepted', buildId: BUILD, status: 'queued' })
    await done
    const stopping = controller.stop()
    stops[0]?.resolve({ stopped: false })
    await stopping
    // Sondage immédiat, sans attendre le délai de 3 s.
    await clock.advance(0)
    expect(builds.map((build) => build.buildId)).toEqual([BUILD])
    builds[0]?.reply.resolve({ buildId: BUILD, status: 'success', result: resultOf(BUILD) })
    await flushPromises()
    expect(controller.state.result?.buildId).toBe(BUILD)
  })

  it('stops a build accepted after the stop was asked', async () => {
    const { controller, compiles, stops } = setup()
    const done = controller.compile()
    await flushPromises()
    const stopping = controller.stop()
    stops[0]?.resolve({ stopped: false })
    await stopping
    compiles[0]?.resolve({ kind: 'accepted', buildId: BUILD, status: 'queued' })
    await done
    await flushPromises()
    expect(stops).toHaveLength(2)
    stops[1]?.resolve({ stopped: true })
    await flushPromises()
    expect(controller.state.phase).toBeNull()
  })

  it('stops the running build when the stop came before the 409, without relaunch', async () => {
    const { controller, compiles, stops } = setup()
    const done = controller.compile()
    await flushPromises()
    const stopping = controller.stop()
    stops[0]?.resolve({ stopped: false })
    await stopping
    compiles[0]?.resolve({ kind: 'in-progress', buildId: OTHER })
    await done
    await flushPromises()
    expect(stops).toHaveLength(2)
    stops[1]?.resolve({ stopped: true })
    await flushPromises()
    expect(controller.state.phase).toBeNull()
    expect(controller.trackedBuildId).toBeNull()
    controller.onEvent({ buildId: OTHER, status: 'cancelled', result: null })
    await flushPromises()
    expect(compiles).toHaveLength(1)
  })

  it('adopts a build started elsewhere and shows its result', async () => {
    const { controller, compiles, builds } = setup()
    // Compilation lancée avant l'ouverture de la page (rechargement, autre onglet, autre membre).
    controller.onEvent({ buildId: OTHER, status: 'running', result: null })
    expect(controller.trackedBuildId).toBe(OTHER)
    expect(controller.state.phase).toBe('running')
    // Un clic pendant ce suivi est relancé à sa fin.
    await controller.compile()
    expect(compiles).toHaveLength(0)
    controller.onEvent({ buildId: OTHER, status: 'success', result: resultOf(OTHER) })
    await flushPromises()
    expect(controller.state.result?.buildId).toBe(OTHER)
    expect(compiles).toHaveLength(1)
    expect(builds).toHaveLength(0)
  })

  it('shows a final event received while nothing is tracked, once', async () => {
    const { controller, builds } = setup()
    controller.onEvent({ buildId: OTHER, status: 'success', result: resultOf(OTHER) })
    await flushPromises()
    expect(controller.state.result?.buildId).toBe(OTHER)
    expect(controller.state.phase).toBeNull()
    expect(controller.trackedBuildId).toBeNull()
    // Résultat retiré de l'événement : relu par l'API.
    controller.onEvent({ buildId: BUILD, status: 'failure', result: null, resultOmitted: true })
    await flushPromises()
    expect(builds.map((build) => build.buildId)).toEqual([BUILD])
    builds[0]?.reply.resolve({
      buildId: BUILD,
      status: 'failure',
      result: resultOf(BUILD, 'failure'),
    })
    await flushPromises()
    expect(controller.state.result?.buildId).toBe(BUILD)
    // Doublon tardif d'une compilation déjà terminée : sans effet.
    controller.onEvent({ buildId: OTHER, status: 'success', result: resultOf(OTHER) })
    controller.onEvent({ buildId: OTHER, status: 'running', result: null })
    await flushPromises()
    expect(controller.state.result?.buildId).toBe(BUILD)
    expect(controller.state.phase).toBeNull()
    // Arrêt sans résultat : rien à afficher.
    controller.onEvent({
      buildId: '00000000-0000-4000-8000-0000000000b3',
      status: 'cancelled',
      result: null,
    })
    await flushPromises()
    expect(controller.trackedBuildId).toBeNull()
    expect(controller.state.result?.buildId).toBe(BUILD)
  })

  it('does nothing after dispose', async () => {
    const { clock, controller, compiles, builds } = setup()
    const done = controller.compile()
    await flushPromises()
    compiles[0]?.resolve({ kind: 'accepted', buildId: BUILD, status: 'queued' })
    await done
    controller.dispose()
    expect(clock.pending).toBe(0)
    controller.onEvent({ buildId: BUILD, status: 'success', result: resultOf(BUILD) })
    await clock.advance(60_000)
    expect(builds).toHaveLength(0)
    expect(controller.state.result).toBeNull()
  })
})

describe('warm schedule', () => {
  it('warms a project at most once per period', () => {
    const schedule = new WarmSchedule(600_000)
    expect(schedule.claim('p1', 0)).toBe(true)
    expect(schedule.claim('p1', 1_000)).toBe(false)
    expect(schedule.claim('p2', 1_000)).toBe(true)
    expect(schedule.claim('p1', 600_000)).toBe(true)
    schedule.markUnsupported('p2')
    expect(schedule.claim('p2', 10_000_000)).toBe(false)
  })

  it('forgets a failed warm-up, but not a newer one', () => {
    const schedule = new WarmSchedule(600_000)
    expect(schedule.claim('p1', 0)).toBe(true)
    schedule.release('p1', 0)
    expect(schedule.claim('p1', 1_000)).toBe(true)
    schedule.release('p1', 0)
    expect(schedule.claim('p1', 2_000)).toBe(false)
  })
})
