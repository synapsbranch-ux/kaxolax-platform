import {
  parseSpellRequest,
  type SpellLanguage,
  type SpellRequest,
  type SpellResponse,
} from './protocol.js'

/** Moteur d'orthographe d'une langue (Hunspell compilé en WebAssembly, ou un double de test). */
export interface SpellEngine {
  correct(word: string): boolean
  suggest(word: string): string[]
  dispose?(): void
}

/** Chargement d'un dictionnaire : fichiers `.aff` et `.dic` puis moteur. */
export type EngineLoader = (language: SpellLanguage) => Promise<SpellEngine>

/** Suggestions par défaut. */
const DEFAULT_SUGGESTIONS = 8
/** Résultats mémorisés par langue (au-delà, le cache est vidé). */
const CACHE_LIMIT = 50_000

/**
 * Cœur du Web Worker du correcteur : charge le dictionnaire d'une langue à la première requête
 * (une seule fois, même pour des requêtes simultanées), mémorise les résultats et applique le
 * dictionnaire personnel. Un mot composé (`porte-monnaie`) est correct si le dictionnaire le
 * connaît ou si chacune de ses parties est correcte.
 */
export class SpellService {
  readonly #load: EngineLoader
  readonly #engines = new Map<SpellLanguage, Promise<SpellEngine>>()
  readonly #cache = new Map<SpellLanguage, Map<string, boolean>>()
  #personal = new Set<string>()

  constructor(load: EngineLoader) {
    this.#load = load
  }

  /** Traite un message reçu ; ne lève jamais (erreur renvoyée dans la réponse). */
  async handle(message: unknown): Promise<SpellResponse> {
    const parsed = parseSpellRequest(message)
    if ('error' in parsed) {
      return { type: 'error', id: parsed.id, code: 'E_BAD_REQUEST', message: parsed.error }
    }
    const { request } = parsed
    try {
      return await this.#run(request)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return request.type === 'personal'
        ? { type: 'error', id: request.id, code: 'E_INTERNAL', message }
        : { type: 'error', id: request.id, code: 'E_DICTIONARY_UNAVAILABLE', message }
    }
  }

  async #run(request: SpellRequest): Promise<SpellResponse> {
    switch (request.type) {
      case 'personal':
        this.#personal = new Set(request.words.map((word) => word.normalize('NFC')))
        // Les mots composés mémorisés ont pu dépendre de l'ancien dictionnaire personnel.
        this.#cache.clear()
        return { type: 'ok', id: request.id }
      case 'check': {
        const engine = await this.#engine(request.language)
        const cache = this.#cacheOf(request.language)
        const misspelled = new Set<string>()
        for (const word of request.words) {
          if (!this.#correct(engine, cache, word)) misspelled.add(word)
        }
        return { type: 'checked', id: request.id, misspelled: [...misspelled] }
      }
      case 'suggest': {
        const engine = await this.#engine(request.language)
        const suggestions = engine
          .suggest(request.word.normalize('NFC'))
          .slice(0, request.limit ?? DEFAULT_SUGGESTIONS)
        return { type: 'suggested', id: request.id, suggestions }
      }
    }
  }

  #engine(language: SpellLanguage): Promise<SpellEngine> {
    let engine = this.#engines.get(language)
    if (!engine) {
      engine = this.#load(language)
      // Un échec de chargement n'est pas mémorisé : la requête suivante réessaie.
      engine.catch(() => this.#engines.delete(language))
      this.#engines.set(language, engine)
    }
    return engine
  }

  #cacheOf(language: SpellLanguage): Map<string, boolean> {
    let cache = this.#cache.get(language)
    if (!cache || cache.size > CACHE_LIMIT) {
      cache = new Map()
      this.#cache.set(language, cache)
    }
    return cache
  }

  #correct(engine: SpellEngine, cache: Map<string, boolean>, raw: string): boolean {
    const word = raw.normalize('NFC')
    if (this.#isPersonal(word)) return true
    const known = cache.get(word)
    if (known !== undefined) return known
    const correct =
      engine.correct(word) ||
      (word.includes('-') &&
        word
          .split('-')
          .every((part) => part === '' || engine.correct(part) || this.#isPersonal(part)))
    cache.set(word, correct)
    return correct
  }

  #isPersonal(word: string): boolean {
    if (this.#personal.has(word)) return true
    // Un mot ajouté en minuscules vaut aussi avec une majuscule initiale ou en capitales.
    const lower = word.toLowerCase()
    return lower !== word && this.#personal.has(lower)
  }

  /** Libère les moteurs chargés. */
  async dispose(): Promise<void> {
    const engines = [...this.#engines.values()]
    this.#engines.clear()
    for (const engine of await Promise.allSettled(engines)) {
      if (engine.status === 'fulfilled') engine.value.dispose?.()
    }
  }
}

/** Portée d'un Web Worker (ou double de test). */
export interface WorkerScope {
  postMessage(message: unknown): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
}

/** Branche un `SpellService` sur la portée d'un Web Worker. */
export function serveSpellcheck(scope: WorkerScope, service: SpellService): void {
  scope.addEventListener('message', (event) => {
    void service.handle(event.data).then((response) => {
      scope.postMessage(response)
    })
  })
}
