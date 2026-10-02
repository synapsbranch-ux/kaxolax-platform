/**
 * Point d'entrée du Web Worker du correcteur (`@kaxolax/editor/spellcheck-worker`) : Hunspell
 * compilé en WebAssembly (hunspell-asm), dictionnaires `.aff`/`.dic` chargés à la demande depuis
 * l'application (servis localement, jamais depuis un CDN). Usage, dans un fichier du worker :
 *
 *     startSpellcheckWorker(self, { dictionaryUrl: (language) => `/dictionaries/${language}` })
 */
import { type HunspellFactory, loadModule } from 'hunspell-asm'
import type { SpellLanguage } from './protocol.js'
import {
  type EngineLoader,
  serveSpellcheck,
  type SpellEngine,
  SpellService,
  type WorkerScope,
} from './service.js'

export * from './protocol.js'
export {
  type EngineLoader,
  serveSpellcheck,
  type SpellEngine,
  SpellService,
  type WorkerScope,
} from './service.js'

let factory: Promise<HunspellFactory> | null = null

/** Moteur Hunspell pour un dictionnaire (contenu des fichiers `.aff` et `.dic`). */
export async function createHunspellEngine(
  aff: Uint8Array,
  dic: Uint8Array,
  name = 'dictionary',
): Promise<SpellEngine> {
  factory ??= loadModule()
  const hunspellFactory = await factory
  const affPath = hunspellFactory.mountBuffer(aff, `${name}.aff`)
  const dicPath = hunspellFactory.mountBuffer(dic, `${name}.dic`)
  const hunspell = hunspellFactory.create(affPath, dicPath)
  return {
    correct: (word) => hunspell.spell(word),
    suggest: (word) => hunspell.suggest(word),
    dispose: () => {
      hunspell.dispose()
      hunspellFactory.unmount(affPath)
      hunspellFactory.unmount(dicPath)
    },
  }
}

export interface SpellWorkerOptions {
  /** URL de base des fichiers d'une langue : `<base>.aff` et `<base>.dic`. */
  dictionaryUrl: (language: SpellLanguage) => string
  /** `fetch` à utiliser (celui du worker par défaut). */
  fetch?: (
    url: string,
  ) => Promise<{ ok: boolean; status: number; arrayBuffer(): Promise<ArrayBuffer> }>
}

/** Chargeur de dictionnaires par `fetch` (fichiers servis par l'application). */
export function fetchDictionaryLoader(options: SpellWorkerOptions): EngineLoader {
  const get = options.fetch ?? ((url: string) => fetch(url))
  const download = async (url: string) => {
    const response = await get(url)
    if (!response.ok) throw new Error(`Dictionary download failed (${String(response.status)})`)
    return new Uint8Array(await response.arrayBuffer())
  }
  return async (language) => {
    const base = options.dictionaryUrl(language)
    const [aff, dic] = await Promise.all([download(`${base}.aff`), download(`${base}.dic`)])
    return createHunspellEngine(aff, dic, language)
  }
}

/** Démarre le service du correcteur dans la portée du worker. */
export function startSpellcheckWorker(
  scope: WorkerScope,
  options: SpellWorkerOptions,
): SpellService {
  const service = new SpellService(fetchDictionaryLoader(options))
  serveSpellcheck(scope, service)
  return service
}
