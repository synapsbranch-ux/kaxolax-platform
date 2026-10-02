/*
|--------------------------------------------------------------------------
| Moteur de la recherche dans le projet, exécuté dans un worker_threads
|--------------------------------------------------------------------------
| Ce fichier sert aussi de point d'entrée du worker (voir `project_search.ts`) : il ne dépend que
| de modules Node et de @kaxolax/contracts, sans import relatif ni alias, pour se charger tel quel
| dans un worker (TypeScript retiré nativement par Node en développement, .js après le build).
*/
import { runInNewContext } from 'node:vm'
import { isMainThread, parentPort, workerData } from 'node:worker_threads'
import {
  MAX_SEARCH_RESULTS,
  type ProjectSearchMatch,
  type ProjectSearchQuery,
  type ProjectSearchResponse,
  SEARCH_PREVIEW_LENGTH,
} from '@kaxolax/contracts'

/** Temps maximal d'une recherche : une expression régulière catastrophique est interrompue. */
export const SEARCH_TIME_LIMIT_MS = 500

/** Marque passée en `workerData` : le module ne répond aux messages que dans ce rôle. */
export const SEARCH_WORKER_MARK = 'kaxolax:project-search'

export interface SearchableDocument {
  id: string
  path: string
  content: string
}

/** Demande envoyée au worker. */
export interface SearchJob {
  documents: SearchableDocument[]
  query: ProjectSearchQuery
  limit?: number
  timeLimitMs?: number
}

/** Réponse du worker : résultat, ou message d'une erreur inattendue. */
export type SearchJobResult = { response: ProjectSearchResponse } | { error: string }

/** Caractère de mot au sens de « mot entier » : lettre, chiffre ou _ (Unicode). */
const WORD = String.raw`[\p{L}\p{N}_]`

function escapeRegExp(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|/]/g, String.raw`\$&`)
}

/**
 * Expression construite depuis la requête (texte échappé, ou expression de l'utilisateur, flag u).
 * Lève la `SyntaxError` du moteur si l'expression est invalide.
 */
export function buildSearchPattern(query: ProjectSearchQuery): RegExp {
  const source = query.regex ? query.q : escapeRegExp(query.q)
  const bounded = query.wholeWord ? `(?<!${WORD})(?:${source})(?!${WORD})` : source
  return new RegExp(bounded, `gu${query.caseSensitive ? '' : 'i'}`)
}

/** Extrait de ligne centré sur l'occurrence, au plus `SEARCH_PREVIEW_LENGTH` caractères. */
function preview(line: string, column: number, length: number) {
  if (line.length <= SEARCH_PREVIEW_LENGTH) return { preview: line, previewStart: column }
  const context = Math.max(0, Math.floor((SEARCH_PREVIEW_LENGTH - Math.min(length, 80)) / 2))
  const start = Math.max(0, Math.min(column - context, line.length - SEARCH_PREVIEW_LENGTH))
  return {
    preview: line.slice(start, start + SEARCH_PREVIEW_LENGTH),
    previewStart: column - start,
  }
}

/** Parcourt les lignes des documents, jusqu'à `limit` occurrences (non vides). */
function collectMatches(
  documents: SearchableDocument[],
  pattern: RegExp,
  limit: number,
  matches: ProjectSearchMatch[],
): boolean {
  for (const document of documents) {
    const lines = document.content.split(/\r\n|\r|\n/)
    for (const [index, line] of lines.entries()) {
      pattern.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.exec(line)) !== null) {
        const text = match[0]
        if (text.length === 0) {
          // Occurrence vide (`^`, `x*`…) : ignorée, on avance d'un point de code.
          pattern.lastIndex += (line.codePointAt(match.index) ?? 0) > 0xffff ? 2 : 1
          if (pattern.lastIndex > line.length) break
          continue
        }
        if (matches.length >= limit) return true
        matches.push({
          documentId: document.id,
          path: document.path,
          line: index + 1,
          column: match.index,
          length: text.length,
          ...preview(line, match.index, text.length),
        })
      }
    }
  }
  return false
}

/** Délai de `vm` dépassé. L'erreur vient du contexte : pas de `instanceof Error` possible. */
function isTimeout(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    error.code === 'ERR_SCRIPT_EXECUTION_TIMEOUT'
  )
}

/**
 * Recherche synchrone dans le texte des documents, triés par chemin. La boucle tourne dans
 * `vm.runInNewContext` avec un délai : V8 interrompt alors même une expression régulière en
 * retour arrière catastrophique (ReDoS), et les occurrences trouvées avant l'arrêt sont renvoyées
 * avec `timedOut`. Bloque le fil courant jusqu'à `timeLimitMs` : à n'appeler que dans le worker
 * (ou dans un test), jamais sur le fil principal de l'API.
 */
export function searchDocuments(
  documents: SearchableDocument[],
  query: ProjectSearchQuery,
  options: { limit?: number; timeLimitMs?: number } = {},
): ProjectSearchResponse {
  const pattern = buildSearchPattern(query)
  const sorted = documents.toSorted((a, b) => a.path.localeCompare(b.path))
  const matches: ProjectSearchMatch[] = []
  const state = { truncated: false, timedOut: false }
  try {
    runInNewContext(
      'run()',
      {
        run: () => {
          const limit = options.limit ?? MAX_SEARCH_RESULTS
          state.truncated = collectMatches(sorted, pattern, limit, matches)
        },
      },
      { timeout: options.timeLimitMs ?? SEARCH_TIME_LIMIT_MS },
    )
  } catch (error) {
    if (!isTimeout(error)) throw error
    state.timedOut = true
  }
  return { matches, truncated: state.truncated || state.timedOut, timedOut: state.timedOut }
}

/** Rôle de worker : une recherche par message, réponse `SearchJobResult`. */
if (!isMainThread && parentPort !== null) {
  const port = parentPort
  const mark: unknown = workerData
  if (mark === SEARCH_WORKER_MARK) {
    port.on('message', (job: SearchJob) => {
      let result: SearchJobResult
      try {
        result = {
          response: searchDocuments(job.documents, job.query, {
            limit: job.limit,
            timeLimitMs: job.timeLimitMs,
          }),
        }
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) }
      }
      port.postMessage(result)
    })
  }
}
