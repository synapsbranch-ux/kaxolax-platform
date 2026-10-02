/**
 * Machine d'état de la compilation du projet, sans React (testée unitairement, `use-compile.ts`
 * l'enveloppe). Deux modes, reconnus à la réponse de `POST /projects/:id/compile` :
 * - synchrone (`gateway`) : la réponse porte le résultat ; un nouveau clic relance une demande
 *   qui remplace la précédente (le serveur arrête l'ancienne, seule la dernière réponse compte) ;
 * - asynchrone (`cloudflare`) : 202 `{ buildId, status }`, puis l'état avance par les événements
 *   `compile.updated` (`onEvent`), avec un sondage de repli tant qu'aucun état final n'arrive.
 *   Une demande pendant une compilation suivie ne l'interrompt pas : elle est relancée à sa fin.
 *   Sans compilation suivie ni demande en vol, un événement d'une autre compilation (autre onglet,
 *   autre membre, compilation lancée avant l'ouverture de la page) est adopté : suivie si elle est
 *   en cours, résultat affiché si elle vient de se terminer.
 */
import type { CompileResult } from '@kaxolax/contracts'
import {
  type BuildUpdate,
  BuildUpdates,
  buildOutcome,
  type CompilePhase,
  MAX_BUILD_WAIT_MS,
  phaseOf,
  pollDelayMs,
} from './builds'

/** Réponse de la demande de compilation, ramenée à ce qui compte pour la machine d'état. */
export type CompileResponse =
  | { kind: 'result'; result: CompileResult }
  | { kind: 'accepted'; buildId: string; status: 'queued' | 'preparing' }
  /** 409 `E_COMPILE_IN_PROGRESS` : compilation déjà en cours (autre onglet, autre membre). */
  | { kind: 'in-progress'; buildId: string }

/** Appels réseau (et attente des dernières frappes), injectés pour les tests. */
export interface CompileClient {
  flush: () => Promise<void>
  compile: () => Promise<CompileResponse>
  build: (buildId: string) => Promise<BuildUpdate>
  stop: () => Promise<{ stopped: boolean }>
}

export interface CompileSnapshot {
  /** Étape en cours (null hors compilation). */
  phase: CompilePhase | null
  /** Dernier résultat reçu par cette page (null : aucun). */
  result: CompileResult | null
  /** Date de réception de `result`. */
  receivedAt: number
}

export interface CompileCallbacks {
  onChange: (snapshot: CompileSnapshot) => void
  /** Message d'erreur à afficher, ou null pour effacer le précédent. */
  onError: (message: string | null) => void
  /** Texte d'une erreur réseau ou d'API. */
  describeError: (error: unknown) => string
}

export interface Clock {
  now: () => number
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

const SYSTEM_CLOCK: Clock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => {
    clearTimeout(handle as ReturnType<typeof setTimeout>)
  },
}

export const LOST_BUILD_MESSAGE = 'La compilation ne répond plus. Relancez-la.'
export const MISSING_RESULT_MESSAGE = 'La compilation a échoué sans résultat.'

export class CompileController {
  private snapshot: CompileSnapshot = { phase: null, result: null, receivedAt: 0 }
  private mode: 'unknown' | 'sync' | 'async' = 'unknown'
  /** Numéro de la dernière demande envoyée (mode synchrone : seule la dernière compte). */
  private request = 0
  private inFlight = false
  private tracked: { buildId: string; since: number } | null = null
  /** Nouvelle demande reçue pendant une compilation asynchrone : relancée à sa fin. */
  private again = false
  /** Arrêt demandé avant que la réponse 202 ne donne le `buildId`. */
  private stopPending = false
  private readonly updates = new BuildUpdates()
  private pollTimer: unknown = null
  private disposed = false

  constructor(
    private readonly client: CompileClient,
    private readonly callbacks: CompileCallbacks,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {}

  get state(): CompileSnapshot {
    return this.snapshot
  }

  /** Compilation suivie (mode asynchrone), pour les tests et le débogage. */
  get trackedBuildId(): string | null {
    return this.tracked?.buildId ?? null
  }

  /** Lance une compilation (voir l'en-tête du fichier pour le double clic). */
  async compile(): Promise<void> {
    if (this.isDisposed()) return
    // Compilation asynchrone en cours, ou première réponse attendue alors que le mode n'est pas
    // synchrone : on ne lance pas une seconde compilation concurrente, on relance à la fin.
    if (this.tracked !== null || (this.inFlight && this.mode !== 'sync')) {
      this.again = true
      return
    }
    const current = ++this.request
    this.inFlight = true
    this.stopPending = false
    this.setPhase('requesting')
    this.callbacks.onError(null)
    let response: CompileResponse
    try {
      await this.client.flush()
      response = await this.client.compile()
    } catch (caught) {
      if (this.isDisposed() || current !== this.request) return
      this.inFlight = false
      this.again = false
      this.callbacks.onError(this.callbacks.describeError(caught))
      this.setPhase(null)
      return
    }
    if (this.isDisposed()) return
    if (response.kind === 'result') {
      this.mode = 'sync'
      if (current !== this.request) return
      this.inFlight = false
      this.publish({ phase: null, result: response.result, receivedAt: this.clock.now() })
      this.relaunchIfAsked()
      return
    }
    this.mode = 'async'
    this.inFlight = false
    if (response.kind === 'in-progress') {
      // On suit la compilation en cours, puis on relance avec le contenu actuel, sauf si l'arrêt
      // a été demandé pendant l'attente de la réponse : on arrête alors celle en cours.
      const stopAsked = this.isStopPending()
      this.stopPending = false
      if (!stopAsked) this.again = true
      this.track({ buildId: response.buildId, status: 'queued', result: null })
      if (stopAsked) void this.stop()
      return
    }
    this.track({ buildId: response.buildId, status: response.status, result: null })
    if (this.isStopPending()) {
      this.stopPending = false
      void this.stop()
    }
  }

  /**
   * Événement `compile.updated` reçu. Pendant un suivi ou une demande en vol, ceux d'une autre
   * compilation sont seulement mémorisés ; sinon ils sont adoptés (voir l'en-tête du fichier).
   */
  onEvent(update: BuildUpdate): void {
    if (this.isDisposed()) return
    this.apply(update)
  }

  /** Arrête la compilation en cours et annule la relance demandée. */
  async stop(): Promise<void> {
    if (this.isDisposed()) return
    this.again = false
    const tracked = this.tracked
    if (tracked === null && this.inFlight && this.mode !== 'sync') this.stopPending = true
    try {
      const { stopped } = await this.client.stop()
      if (this.isDisposed() || tracked === null || this.tracked?.buildId !== tracked.buildId) return
      // Arrêt confirmé : l'événement `cancelled` peut tarder, l'état local n'attend pas. Sinon la
      // compilation venait de finir : on relit tout de suite son état.
      if (stopped) this.apply({ buildId: tracked.buildId, status: 'cancelled', result: null })
      else this.schedulePoll(0)
    } catch (caught) {
      if (!this.isDisposed()) this.callbacks.onError(this.callbacks.describeError(caught))
    }
  }

  // Lus après un `await` : une méthode évite le rétrécissement de type d'avant l'attente.
  private isDisposed(): boolean {
    return this.disposed
  }

  private isStopPending(): boolean {
    return this.stopPending
  }

  private isInFlight(): boolean {
    return this.inFlight
  }

  /** Page quittée : plus aucun appel ni minuterie. */
  dispose(): void {
    this.disposed = true
    this.clearPoll()
  }

  private track(update: BuildUpdate): void {
    this.tracked = { buildId: update.buildId, since: this.clock.now() }
    this.schedulePoll()
    // L'état de la réponse cède devant un événement plus avancé déjà reçu (`BuildUpdates`).
    this.apply(update)
  }

  private apply(update: BuildUpdate): void {
    const known = this.updates.get(update.buildId)
    const merged = this.updates.record(update)
    const phase = phaseOf(merged.status)
    if (this.tracked?.buildId !== merged.buildId) {
      if (this.tracked !== null || this.inFlight || this.mode === 'sync') return
      // Compilation déjà vue terminée (doublon, événement en retard) : rien à reprendre.
      if (known !== undefined && phaseOf(known.status) === null) return
      if (phase !== null) {
        this.track(merged)
      } else if (merged.status !== 'cancelled') {
        this.tracked = { buildId: merged.buildId, since: this.clock.now() }
        void this.finish(merged)
      }
      return
    }
    if (phase === null) void this.finish(merged)
    else this.setPhase(phase)
  }

  /** Compilation suivie terminée : résultat affiché (relu par l'API s'il manque), puis relance. */
  private async finish(update: BuildUpdate): Promise<void> {
    this.tracked = null
    this.clearPoll()
    const outcome = buildOutcome(update)
    let result: CompileResult | null = outcome.kind === 'result' ? outcome.result : null
    if (outcome.kind === 'fetch') {
      try {
        result = (await this.client.build(update.buildId)).result
        if (result === null && !this.disposed) this.callbacks.onError(MISSING_RESULT_MESSAGE)
      } catch (caught) {
        if (!this.isDisposed()) this.callbacks.onError(this.callbacks.describeError(caught))
      }
    }
    if (this.isDisposed()) return
    // Une nouvelle demande a pu partir pendant la relecture : elle garde son étape.
    const busy = this.trackedBuildId !== null || this.isInFlight()
    this.publish({
      phase: busy ? this.snapshot.phase : null,
      ...(result === null
        ? { result: this.snapshot.result, receivedAt: this.snapshot.receivedAt }
        : { result, receivedAt: this.clock.now() }),
    })
    if (!busy) this.relaunchIfAsked()
  }

  private relaunchIfAsked(): void {
    if (!this.again) return
    this.again = false
    void this.compile()
  }

  /** Sondage de repli : délai croissant, arrêt sur état final ou après `MAX_BUILD_WAIT_MS`. */
  private schedulePoll(delay?: number): void {
    this.clearPoll()
    const tracked = this.tracked
    if (tracked === null) return
    const elapsed = this.clock.now() - tracked.since
    if (elapsed > MAX_BUILD_WAIT_MS) {
      this.tracked = null
      this.again = false
      this.setPhase(null)
      this.callbacks.onError(LOST_BUILD_MESSAGE)
      return
    }
    this.pollTimer = this.clock.setTimeout(
      () => {
        this.pollTimer = null
        const stillTracked = () => !this.isDisposed() && this.tracked?.buildId === tracked.buildId
        this.client.build(tracked.buildId).then(
          (state) => {
            if (!stillTracked()) return
            this.apply(state)
            if (stillTracked()) this.schedulePoll()
          },
          () => {
            if (stillTracked()) this.schedulePoll()
          },
        )
      },
      delay ?? pollDelayMs(elapsed),
    )
  }

  private clearPoll(): void {
    if (this.pollTimer === null) return
    this.clock.clearTimeout(this.pollTimer)
    this.pollTimer = null
  }

  private setPhase(phase: CompilePhase | null): void {
    if (this.snapshot.phase === phase) return
    this.publish({ ...this.snapshot, phase })
  }

  private publish(snapshot: CompileSnapshot): void {
    this.snapshot = snapshot
    this.callbacks.onChange(snapshot)
  }
}
