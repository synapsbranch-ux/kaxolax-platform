import {
  MAX_CHECK_WORDS,
  MAX_WORD_LENGTH,
  parseSpellResponse,
  type SpellLanguage,
  type SpellRequest,
  type SpellResponse,
} from './protocol.js'

/** Web Worker (ou double de test) qui parle le protocole du correcteur. */
export interface SpellWorkerLike {
  postMessage(message: SpellRequest): void
  addEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  removeEventListener(type: 'message', listener: (event: { data: unknown }) => void): void
  terminate?(): void
}

/** Requête sans son identifiant (ajouté par le client). */
type Outgoing = SpellRequest extends infer R
  ? R extends SpellRequest
    ? Omit<R, 'id'>
    : never
  : never

export class SpellcheckError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message)
  }
}

/** Délai maximal d'une réponse du worker (le premier chargement d'un dictionnaire compris). */
const DEFAULT_TIMEOUT_MS = 30_000

/**
 * Client du worker du correcteur, côté page : requêtes numérotées, résultats mémorisés par
 * langue (seuls les mots jamais vus partent au worker), dictionnaire personnel. `subscribe`
 * prévient l'éditeur quand les résultats mémorisés changent (dictionnaire personnel modifié).
 */
export class SpellcheckClient {
  readonly #worker: SpellWorkerLike
  readonly #timeoutMs: number
  #nextId = 1
  readonly #pending = new Map<
    number,
    {
      resolve: (response: SpellResponse) => void
      reject: (error: Error) => void
      timer: ReturnType<typeof setTimeout>
    }
  >()
  readonly #known = new Map<SpellLanguage, Map<string, boolean>>()
  readonly #listeners = new Set<() => void>()
  #personal: string[] = []
  #disposed = false

  readonly #onMessage = (event: { data: unknown }) => {
    const response = parseSpellResponse(event.data)
    if (!response) return
    const pending = this.#pending.get(response.id)
    if (!pending) return
    this.#pending.delete(response.id)
    clearTimeout(pending.timer)
    pending.resolve(response)
  }

  constructor(worker: SpellWorkerLike, options: { timeoutMs?: number } = {}) {
    this.#worker = worker
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    worker.addEventListener('message', this.#onMessage)
  }

  #send(request: Outgoing): Promise<SpellResponse> {
    if (this.#disposed) return Promise.reject(new SpellcheckError('E_DISPOSED', 'Client disposed'))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id)
        reject(new SpellcheckError('E_TIMEOUT', 'Spellcheck worker timed out'))
      }, this.#timeoutMs)
      this.#pending.set(id, { resolve, reject, timer })
      this.#worker.postMessage({ ...request, id })
    })
  }

  /** Résultat mémorisé d'un mot (undefined s'il n'a jamais été vérifié). */
  known(language: SpellLanguage, word: string): boolean | undefined {
    return this.#known.get(language)?.get(word)
  }

  /**
   * Mots incorrects parmi `words`. Les mots déjà vérifiés ne repartent pas au worker ; les mots
   * trop longs sont considérés corrects.
   */
  async check(language: SpellLanguage, words: Iterable<string>): Promise<Set<string>> {
    let known = this.#known.get(language)
    if (!known) {
      known = new Map()
      this.#known.set(language, known)
    }
    const unknown = [...new Set(words)].filter(
      (word) => word.length <= MAX_WORD_LENGTH && !known.has(word),
    )
    for (let start = 0; start < unknown.length; start += MAX_CHECK_WORDS) {
      const batch = unknown.slice(start, start + MAX_CHECK_WORDS)
      const response = await this.#send({ type: 'check', language, words: batch })
      if (response.type === 'error') throw new SpellcheckError(response.code, response.message)
      if (response.type !== 'checked')
        throw new SpellcheckError('E_PROTOCOL', 'Unexpected response')
      const misspelled = new Set(response.misspelled)
      for (const word of batch) known.set(word, !misspelled.has(word))
    }
    const result = new Set<string>()
    for (const word of words) if (known.get(word) === false) result.add(word)
    return result
  }

  /** Suggestions de correction d'un mot. */
  async suggest(language: SpellLanguage, word: string, limit = 8): Promise<string[]> {
    if (word.length > MAX_WORD_LENGTH) return []
    const response = await this.#send({ type: 'suggest', language, word, limit })
    if (response.type === 'error') throw new SpellcheckError(response.code, response.message)
    return response.type === 'suggested' ? response.suggestions : []
  }

  /** Dictionnaire personnel courant. */
  get personalDictionary(): readonly string[] {
    return this.#personal
  }

  /** Remplace le dictionnaire personnel (préférence de l'utilisateur) et revérifie les mots. */
  async setPersonalDictionary(words: readonly string[]): Promise<void> {
    const next = [...new Set(words)].filter((word) => word.length <= MAX_WORD_LENGTH)
    if (
      next.length === this.#personal.length &&
      next.every((word, i) => this.#personal[i] === word)
    ) {
      return
    }
    this.#personal = next
    const response = await this.#send({ type: 'personal', words: next.slice(0, MAX_CHECK_WORDS) })
    if (response.type === 'error') throw new SpellcheckError(response.code, response.message)
    this.#known.clear()
    for (const listener of this.#listeners) listener()
  }

  /** Abonnement aux changements des résultats ; renvoie la fonction de désabonnement. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Rejette les requêtes en cours, se désabonne du worker et l'arrête. */
  dispose(): void {
    this.#disposed = true
    this.#worker.removeEventListener('message', this.#onMessage)
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(new SpellcheckError('E_DISPOSED', 'Client disposed'))
    }
    this.#pending.clear()
    this.#worker.terminate?.()
  }
}
