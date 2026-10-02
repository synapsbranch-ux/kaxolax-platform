/**
 * Compilation asynchrone (mode `cloudflare` de l'API) : calculs sans interface du suivi d'une
 * compilation, testés unitairement. La demande renvoie 202 `{ buildId, status }`, puis l'état
 * avance par les événements `compile.updated` du document meta du projet, avec un repli par
 * sondage (`GET /projects/:id/builds/:buildId`). Événements et réponse peuvent arriver dans le
 * désordre : un état n'est jamais ramené en arrière.
 */
import { type BuildStatus, type CompileResult, type CompileUpdatedEvent } from '@kaxolax/contracts'

/** Étape affichée par la pastille pendant une compilation. */
export type CompilePhase = 'requesting' | 'queued' | 'preparing' | 'running'

const RANK: Record<BuildStatus, number> = {
  queued: 0,
  preparing: 1,
  running: 2,
  success: 3,
  failure: 3,
  timeout: 3,
  error: 3,
  cancelled: 3,
}

/** Le plus avancé des deux statuts (le premier reçu l'emporte entre deux statuts finaux). */
export function laterStatus(current: BuildStatus | null, next: BuildStatus): BuildStatus {
  if (current === null) return next
  return RANK[next] > RANK[current] ? next : current
}

/** Étape d'une compilation en cours ; null une fois terminée. */
export function phaseOf(status: BuildStatus): CompilePhase | null {
  switch (status) {
    case 'queued':
    case 'preparing':
    case 'running':
      return status
    default:
      return null
  }
}

/** Libellé de la pastille pendant une compilation. */
export function phaseLabel(phase: CompilePhase): string {
  switch (phase) {
    case 'preparing':
      return 'Préparation du compilateur…'
    case 'queued':
      return 'En attente…'
    default:
      return 'Compilation…'
  }
}

/** État connu d'une compilation : statut le plus avancé reçu, et résultat s'il est terminé. */
export type BuildUpdate = Pick<
  CompileUpdatedEvent,
  'buildId' | 'status' | 'result' | 'resultOmitted'
>

/**
 * Derniers états reçus, par compilation (mémoire bornée) : un événement peut précéder la réponse
 * 202 qui donne le `buildId` attendu.
 */
export class BuildUpdates {
  private readonly updates = new Map<string, BuildUpdate>()

  constructor(private readonly max = 20) {}

  /** Enregistre un état reçu et renvoie l'état fusionné (jamais en arrière). */
  record(update: BuildUpdate): BuildUpdate {
    const known = this.updates.get(update.buildId)
    let merged: BuildUpdate = update
    if (known !== undefined && RANK[update.status] <= RANK[known.status]) {
      // Statut déjà atteint ou dépassé : on garde l'état connu, complété du résultat reçu.
      merged =
        known.status === update.status
          ? {
              ...known,
              result: known.result ?? update.result,
              ...(known.resultOmitted === true || update.resultOmitted === true
                ? { resultOmitted: true }
                : {}),
            }
          : known
    }
    this.updates.delete(update.buildId)
    this.updates.set(update.buildId, merged)
    while (this.updates.size > this.max) {
      const oldest = this.updates.keys().next().value
      if (oldest === undefined) break
      this.updates.delete(oldest)
    }
    return merged
  }

  get(buildId: string): BuildUpdate | undefined {
    return this.updates.get(buildId)
  }
}

/** Suite à donner à une compilation terminée. */
export type BuildOutcome =
  | { kind: 'result'; result: CompileResult }
  /** Résultat absent de l'événement (trop gros, ou perdu) : le relire par l'API. */
  | { kind: 'fetch' }
  | { kind: 'cancelled' }

export function buildOutcome(update: BuildUpdate): BuildOutcome {
  if (update.result !== null) return { kind: 'result', result: update.result }
  return update.status === 'cancelled' ? { kind: 'cancelled' } : { kind: 'fetch' }
}

/**
 * Délai avant le prochain sondage d'une compilation suivie depuis `elapsedMs` : rapide au début
 * (compilation courte, événement perdu), plus espacé ensuite. Les événements restent la voie
 * normale.
 */
export function pollDelayMs(elapsedMs: number): number {
  if (elapsedMs < 30_000) return 3_000
  if (elapsedMs < 120_000) return 5_000
  return 10_000
}

/** Au-delà, le suivi s'arrête avec une erreur (l'API clôt de toute façon les compilations perdues). */
export const MAX_BUILD_WAIT_MS = 15 * 60_000

/** Période minimale entre deux réveils anticipés du compilateur d'un projet (sa mise en sommeil
 * intervient ~15 min après la dernière activité). */
export const WARM_PERIOD_MS = 10 * 60_000

/**
 * Réveils anticipés (`POST /projects/:id/compiler/warm`) : au plus un par projet et par période,
 * y compris quand l'éditeur est rouvert.
 */
export class WarmSchedule {
  private readonly warmedAt = new Map<string, number>()
  private readonly unsupported = new Set<string>()

  constructor(private readonly periodMs = WARM_PERIOD_MS) {}

  /** Vrai si un réveil est dû ; il est alors compté comme fait à `now`. */
  claim(projectId: string, now: number): boolean {
    if (this.unsupported.has(projectId)) return false
    const last = this.warmedAt.get(projectId)
    if (last !== undefined && now - last < this.periodMs) return false
    this.warmedAt.set(projectId, now)
    return true
  }

  /**
   * Réveil en échec (réseau, 5xx) : il n'est plus compté, le prochain affichage de l'éditeur
   * réessaie. Sans effet si un autre réveil a été compté depuis `claimedAt`.
   */
  release(projectId: string, claimedAt: number): void {
    if (this.warmedAt.get(projectId) === claimedAt) this.warmedAt.delete(projectId)
  }

  /** API en mode synchrone (`unsupported`) : plus aucun réveil pour ce projet dans cette page. */
  markUnsupported(projectId: string): void {
    this.unsupported.add(projectId)
  }
}
