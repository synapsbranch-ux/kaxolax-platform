import { afterEach, describe, expect, it, vi } from 'vitest'
import { SpellcheckClient, type SpellWorkerLike } from './client.js'
import {
  addPersonalWord,
  PERSONAL_DICTIONARY_LIMIT,
  PERSONAL_DICTIONARY_MAX_BYTES,
  personalDictionaryBytes,
  personalWordStatus,
  removePersonalWord,
} from './personal.js'
import { parseSpellRequest, parseSpellResponse, type SpellLanguage } from './protocol.js'
import { type SpellEngine, SpellService, serveSpellcheck } from './service.js'
import { createHunspellEngine, fetchDictionaryLoader } from './worker.js'

/** Moteur de test : un mot est correct s'il est dans la liste. */
function fakeEngine(known: string[]): SpellEngine {
  const words = new Set(known)
  return {
    correct: (word) => words.has(word),
    suggest: (word) => [...words].filter((candidate) => candidate.startsWith(word.slice(0, 1))),
  }
}

/** Paire worker/page en mémoire : les messages passent par un clone structuré, en asynchrone. */
function memoryWorker(service: SpellService): SpellWorkerLike & { sent: unknown[] } {
  const pageListeners = new Set<(event: { data: unknown }) => void>()
  const workerListeners = new Set<(event: { data: unknown }) => void>()
  const sent: unknown[] = []
  serveSpellcheck(
    {
      postMessage: (message) => {
        queueMicrotask(() => {
          for (const listener of pageListeners) listener({ data: structuredClone(message) })
        })
      },
      addEventListener: (_type, listener) => workerListeners.add(listener),
    },
    service,
  )
  return {
    sent,
    postMessage: (message) => {
      sent.push(message)
      queueMicrotask(() => {
        for (const listener of workerListeners) listener({ data: structuredClone(message) })
      })
    },
    addEventListener: (_type, listener) => pageListeners.add(listener),
    removeEventListener: (_type, listener) => pageListeners.delete(listener),
  }
}

describe('protocol', () => {
  it('validates requests and rejects malformed ones with their id', () => {
    expect(parseSpellRequest({ type: 'check', id: 1, language: 'fr', words: ['a'] })).toEqual({
      request: { type: 'check', id: 1, language: 'fr', words: ['a'] },
    })
    expect(parseSpellRequest({ type: 'check', id: 2, language: 'de', words: [] })).toEqual({
      error: 'Unknown language',
      id: 2,
    })
    expect(parseSpellRequest({ type: 'check', id: 3, language: 'en', words: [42] })).toMatchObject({
      id: 3,
    })
    expect(
      parseSpellRequest({ type: 'check', id: 3, language: 'en', words: ['x'.repeat(65)] }),
    ).toMatchObject({ error: 'Invalid words' })
    expect(
      parseSpellRequest({ type: 'suggest', id: 4, language: 'en', word: 'x', limit: 99 }),
    ).toMatchObject({ error: 'Invalid limit' })
    expect(parseSpellRequest({ type: 'nope', id: 5 })).toMatchObject({ id: 5 })
    expect(parseSpellRequest(null)).toMatchObject({ id: -1 })
    expect(parseSpellRequest({ type: 'personal', id: -3, words: [] })).toMatchObject({ id: -1 })
  })

  it('validates responses', () => {
    expect(parseSpellResponse({ type: 'checked', id: 1, misspelled: ['x'] })).toEqual({
      type: 'checked',
      id: 1,
      misspelled: ['x'],
    })
    expect(parseSpellResponse({ type: 'checked', id: 1, misspelled: [1] })).toBeNull()
    expect(parseSpellResponse({ type: 'error', id: 1, code: 'E_OTHER', message: 'x' })).toBeNull()
    expect(parseSpellResponse({ type: 'ok' })).toBeNull()
  })
})

describe('SpellService', () => {
  it('loads each dictionary once, on demand, even for concurrent requests', async () => {
    const load = vi.fn((language: SpellLanguage) =>
      Promise.resolve(fakeEngine(language === 'fr' ? ['bonjour', 'porte', 'monnaie'] : ['hello'])),
    )
    const service = new SpellService(load)
    const [fr1, fr2] = await Promise.all([
      service.handle({ type: 'check', id: 1, language: 'fr', words: ['bonjour', 'bonjoru'] }),
      service.handle({ type: 'check', id: 2, language: 'fr', words: ['porte-monnaie', 'hello'] }),
    ])
    expect(fr1).toEqual({ type: 'checked', id: 1, misspelled: ['bonjoru'] })
    expect(fr2).toEqual({ type: 'checked', id: 2, misspelled: ['hello'] })
    expect(load).toHaveBeenCalledTimes(1)
    await service.handle({ type: 'check', id: 3, language: 'en', words: ['hello'] })
    expect(load).toHaveBeenCalledTimes(2)
  })

  it('applies the personal dictionary, case-insensitively for lowercase entries', async () => {
    const service = new SpellService(() => Promise.resolve(fakeEngine([])))
    expect(
      await service.handle({ type: 'personal', id: 1, words: ['kaxolax', 'Hocuspocus'] }),
    ).toEqual({ type: 'ok', id: 1 })
    const response = await service.handle({
      type: 'check',
      id: 2,
      language: 'en',
      words: ['kaxolax', 'Kaxolax', 'KAXOLAX', 'Hocuspocus', 'hocuspocus', 'other'],
    })
    expect(response).toEqual({ type: 'checked', id: 2, misspelled: ['hocuspocus', 'other'] })
    await service.handle({ type: 'personal', id: 3, words: [] })
    expect(
      await service.handle({ type: 'check', id: 4, language: 'en', words: ['kaxolax'] }),
    ).toEqual({ type: 'checked', id: 4, misspelled: ['kaxolax'] })
  })

  it('reports bad requests and unavailable dictionaries, and retries a failed load', async () => {
    let fail = true
    const service = new SpellService(() =>
      fail ? Promise.reject(new Error('404')) : Promise.resolve(fakeEngine(['ok'])),
    )
    expect(await service.handle({ type: 'check', id: 1, language: 'xx', words: [] })).toEqual({
      type: 'error',
      id: 1,
      code: 'E_BAD_REQUEST',
      message: 'Unknown language',
    })
    expect(
      await service.handle({ type: 'check', id: 2, language: 'en', words: ['ok'] }),
    ).toMatchObject({ type: 'error', id: 2, code: 'E_DICTIONARY_UNAVAILABLE', message: '404' })
    fail = false
    expect(await service.handle({ type: 'check', id: 3, language: 'en', words: ['ok'] })).toEqual({
      type: 'checked',
      id: 3,
      misspelled: [],
    })
  })
})

describe('SpellcheckClient', () => {
  const clients: SpellcheckClient[] = []
  afterEach(() => {
    for (const client of clients.splice(0)) client.dispose()
  })

  it('checks through the worker protocol and only sends unknown words', async () => {
    const worker = memoryWorker(new SpellService(() => Promise.resolve(fakeEngine(['un', 'deux']))))
    const client = new SpellcheckClient(worker)
    clients.push(client)
    expect(await client.check('fr', ['un', 'trois', 'un'])).toEqual(new Set(['trois']))
    expect(await client.check('fr', ['deux', 'trois', 'un'])).toEqual(new Set(['trois']))
    expect(worker.sent).toEqual([
      { type: 'check', id: 1, language: 'fr', words: ['un', 'trois'] },
      { type: 'check', id: 2, language: 'fr', words: ['deux'] },
    ])
    expect(client.known('fr', 'trois')).toBe(false)
    expect(await client.suggest('fr', 'dxeu')).toEqual(['deux'])
  })

  it('updates the personal dictionary, clears its cache and notifies subscribers', async () => {
    const worker = memoryWorker(new SpellService(() => Promise.resolve(fakeEngine([]))))
    const client = new SpellcheckClient(worker)
    clients.push(client)
    const listener = vi.fn()
    client.subscribe(listener)
    expect(await client.check('en', ['kaxolax'])).toEqual(new Set(['kaxolax']))
    await client.setPersonalDictionary(['kaxolax'])
    expect(listener).toHaveBeenCalledTimes(1)
    expect(client.known('en', 'kaxolax')).toBeUndefined()
    expect(await client.check('en', ['kaxolax'])).toEqual(new Set())
    // Même dictionnaire : aucune requête.
    const sent = worker.sent.length
    await client.setPersonalDictionary(['kaxolax'])
    expect(worker.sent.length).toBe(sent)
  })

  it('rejects on worker errors, timeouts and after dispose', async () => {
    const worker = memoryWorker(new SpellService(() => Promise.reject(new Error('down'))))
    const client = new SpellcheckClient(worker)
    await expect(client.check('en', ['x'])).rejects.toMatchObject({
      code: 'E_DICTIONARY_UNAVAILABLE',
    })
    const silent: SpellWorkerLike = {
      postMessage: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }
    const slow = new SpellcheckClient(silent, { timeoutMs: 10 })
    await expect(slow.check('en', ['x'])).rejects.toMatchObject({ code: 'E_TIMEOUT' })
    const pending = slow.suggest('en', 'x')
    slow.dispose()
    await expect(pending).rejects.toMatchObject({ code: 'E_DISPOSED' })
    client.dispose()
  })
})

describe('personal dictionary helpers', () => {
  it('adds at the head without duplicates, and removes', () => {
    expect(addPersonalWord(['b'], 'a')).toEqual(['a', 'b'])
    expect(addPersonalWord(['a'], 'a')).toEqual(['a'])
    expect(addPersonalWord([], 'not a word')).toEqual([])
    expect(addPersonalWord([], '\\cmd')).toEqual([])
    expect(personalWordStatus(['a'], 'a')).toBe('duplicate')
    expect(personalWordStatus([], 'not a word')).toBe('invalid')
    expect(removePersonalWord(['a', 'b'], 'a')).toEqual(['b'])
  })

  it('refuses a word once the dictionary is full, without dropping the oldest ones', () => {
    const name = (i: number) =>
      [0, 1, 2].map((rank) => String.fromCharCode(97 + (Math.floor(i / 26 ** rank) % 26))).join('')
    const full = Array.from({ length: PERSONAL_DICTIONARY_LIMIT }, (_, i) => `mot${name(i)}`)
    expect(personalWordStatus(full, 'nouveau')).toBe('full')
    expect(addPersonalWord(full, 'nouveau')).toEqual(full)

    // Borne en octets : mots longs à 3 octets par lettre (UTF-8).
    const long = (i: number) => `${'ア'.repeat(37)}${name(i)}`
    const heavy: string[] = []
    while (personalWordStatus(heavy, long(heavy.length)) === 'ok') heavy.unshift(long(heavy.length))
    expect(heavy.length).toBeLessThan(PERSONAL_DICTIONARY_LIMIT)
    expect(personalDictionaryBytes(heavy)).toBeLessThanOrEqual(PERSONAL_DICTIONARY_MAX_BYTES)
    expect(addPersonalWord(heavy, long(heavy.length))).toEqual(heavy)
  })
})

describe('Hunspell engine with the French and English dictionaries', () => {
  const dictionary = async (language: SpellLanguage) => {
    const loaded = language === 'fr' ? await import('dictionary-fr') : await import('dictionary-en')
    return { aff: new Uint8Array(loaded.default.aff), dic: new Uint8Array(loaded.default.dic) }
  }

  it('checks and suggests in French and English through the worker protocol', async () => {
    const files = { fr: await dictionary('fr'), en: await dictionary('en') }
    const loader = fetchDictionaryLoader({
      dictionaryUrl: (language) => `/dictionaries/${language}`,
      fetch: (url) => {
        const [, , language, extension] = /^\/(dictionaries)\/(en|fr)\.(aff|dic)$/.exec(url) ?? []
        const file = files[language as SpellLanguage][extension as 'aff' | 'dic']
        return Promise.resolve({
          ok: true,
          status: 200,
          arrayBuffer: () => Promise.resolve(file.slice().buffer),
        })
      },
    })
    const service = new SpellService(loader)
    const client = new SpellcheckClient(memoryWorker(service))
    const french = await client.check('fr', [
      'théorème',
      'théoreme',
      "l'arbre",
      "aujourd'hui",
      'Bonjour',
      'porte-monnaie',
      'étaient',
      'mangerions',
    ])
    expect(french).toEqual(new Set(['théoreme']))
    expect(await client.suggest('fr', 'théoreme')).toContain('théorème')
    const english = await client.check('en', ['receive', 'recieve', "don't", 'colour', 'Theorem'])
    expect(english).toEqual(new Set(['recieve', 'colour']))
    expect((await client.suggest('en', 'recieve'))[0]).toBe('receive')
    client.dispose()
    await service.dispose()
  }, 20_000)

  it('loads a dictionary from raw files', async () => {
    const { aff, dic } = await dictionary('en')
    const engine = await createHunspellEngine(aff, dic, 'test-en')
    expect(engine.correct('hello')).toBe(true)
    expect(engine.correct('helo')).toBe(false)
    engine.dispose?.()
  })
})
