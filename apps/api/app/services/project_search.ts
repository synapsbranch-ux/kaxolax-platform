import { extname } from 'node:path'
import { Worker } from 'node:worker_threads'
import type { ProjectSearchQuery, ProjectSearchResponse } from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import {
  buildSearchPattern,
  SEARCH_TIME_LIMIT_MS,
  SEARCH_WORKER_MARK,
  type SearchableDocument,
  type SearchJob,
  type SearchJobResult,
} from '#services/project_search_engine'

export { SEARCH_TIME_LIMIT_MS, type SearchableDocument } from '#services/project_search_engine'

/** Recherches exécutées en même temps dans un processus de l'API (une par worker). */
export const MAX_CONCURRENT_SEARCHES = 4

/**
 * Marge accordée au worker au-delà du délai de la recherche (démarrage, copie des documents)
 * avant de l'arrêter de force.
 */
const WORKER_GRACE_MS = 5_000

/** Expression régulière refusée par le moteur JavaScript (syntaxe invalide). */
export class InvalidSearchPatternException extends Exception {
  static override status = 422
  static override code = 'E_INVALID_SEARCH_PATTERN'
  static override message = 'The regular expression is not valid'
}

/** Recherche abandonnée : une recherche plus récente du même utilisateur l'a remplacée. */
export class SearchSupersededException extends Exception {
  static override status = 409
  static override code = 'E_SEARCH_SUPERSEDED'
  static override message = 'A newer search replaced this one'
}

/** Toutes les places de recherche du processus sont prises. */
export class TooManySearchesException extends Exception {
  static override status = 429
  static override code = 'E_TOO_MANY_SEARCHES'
  static override message = 'Too many searches are running, try again in a moment'
}

/** Expression de la requête ; une syntaxe invalide donne `InvalidSearchPatternException` (422). */
export function searchPattern(query: ProjectSearchQuery): RegExp {
  try {
    return buildSearchPattern(query)
  } catch (error) {
    throw new InvalidSearchPatternException(undefined, { cause: error })
  }
}

/** Le moteur, chargé comme point d'entrée du worker (.ts en développement, .js après le build). */
const ENGINE_URL = new URL(
  `./project_search_engine${extname(new URL(import.meta.url).pathname)}`,
  import.meta.url,
)

type Outcome =
  | { kind: 'done'; result: SearchJobResult }
  | { kind: 'failed'; error: Error }
  | { kind: 'aborted' }
  | { kind: 'expired' }

/**
 * Recherches du projet hors du fil principal : chaque recherche tourne dans un worker_threads
 * (réserve de `max` workers réutilisés), si bien qu'une expression catastrophique n'occupe que
 * son worker, jamais la boucle d'événements de l'API. Un utilisateur n'a qu'une recherche à la
 * fois : la suivante annule la précédente (frappe au clavier) et arrête son worker. Au-delà de
 * `max` recherches en cours dans le processus, la demande est refusée (429).
 */
export class ProjectSearches {
  readonly #max: number
  readonly #idle: Worker[] = []
  #busy = 0
  /** Recherche en cours de chaque utilisateur (annulée par la suivante). */
  readonly #running = new Map<string, AbortController>()

  constructor(options: { maxConcurrent?: number } = {}) {
    this.#max = options.maxConcurrent ?? MAX_CONCURRENT_SEARCHES
  }

  /**
   * Ouvre la recherche de `userId` en annulant la précédente. `load` fournit les documents ; la
   * recherche est abandonnée (409) si une autre la remplace entre-temps.
   */
  async search(
    userId: string,
    query: ProjectSearchQuery,
    load: () => Promise<SearchableDocument[]>,
    options: { limit?: number; timeLimitMs?: number } = {},
  ): Promise<ProjectSearchResponse> {
    searchPattern(query)
    this.#running.get(userId)?.abort()
    const controller = new AbortController()
    this.#running.set(userId, controller)
    try {
      const documents = await load()
      if (controller.signal.aborted) throw new SearchSupersededException()
      return await this.#run({ documents, query, ...options }, controller.signal)
    } finally {
      if (this.#running.get(userId) === controller) this.#running.delete(userId)
    }
  }

  /** Arrête les workers inoccupés (fin des tests, arrêt du processus). */
  async close(): Promise<void> {
    await Promise.all(this.#idle.splice(0).map((worker) => worker.terminate()))
  }

  async #run(job: SearchJob, signal: AbortSignal): Promise<ProjectSearchResponse> {
    if (this.#busy >= this.#max) throw new TooManySearchesException()
    this.#busy += 1
    const worker = this.#idle.pop() ?? this.#spawn()
    try {
      const outcome = await this.#exchange(worker, job, signal)
      if (outcome.kind === 'done') this.#idle.push(worker)
      else void worker.terminate()

      switch (outcome.kind) {
        case 'aborted':
          throw new SearchSupersededException()
        case 'expired':
          return { matches: [], truncated: true, timedOut: true }
        case 'failed':
          throw outcome.error
        case 'done':
          if ('error' in outcome.result) throw new Error(outcome.result.error)
          return outcome.result.response
      }
    } finally {
      this.#busy -= 1
    }
  }

  #spawn(): Worker {
    const worker = new Worker(ENGINE_URL, { workerData: SEARCH_WORKER_MARK })
    // Un worker inoccupé ne retient pas le processus (arrêt de l'API, fin des tests).
    worker.unref()
    return worker
  }

  /** Envoie la recherche et attend la réponse, l'annulation ou le délai de secours. */
  #exchange(worker: Worker, job: SearchJob, signal: AbortSignal): Promise<Outcome> {
    return new Promise<Outcome>((resolve) => {
      const finish = (outcome: Outcome) => {
        clearTimeout(timer)
        signal.removeEventListener('abort', onAbort)
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
        resolve(outcome)
      }
      const onMessage = (result: SearchJobResult) => {
        finish({ kind: 'done', result })
      }
      const onError = (error: Error) => {
        finish({ kind: 'failed', error })
      }
      const onExit = () => {
        finish({ kind: 'failed', error: new Error('The search worker stopped') })
      }
      const onAbort = () => {
        finish({ kind: 'aborted' })
      }
      // Secours : le délai de `vm` dans le worker devrait toujours suffire.
      const timer = setTimeout(
        () => {
          finish({ kind: 'expired' })
        },
        (job.timeLimitMs ?? SEARCH_TIME_LIMIT_MS) + WORKER_GRACE_MS,
      )
      if (signal.aborted) {
        finish({ kind: 'aborted' })
        return
      }
      signal.addEventListener('abort', onAbort)
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onExit)
      worker.postMessage(job)
    })
  }
}

/** Recherches du processus de l'API (limites par processus). */
export const projectSearches = new ProjectSearches()
