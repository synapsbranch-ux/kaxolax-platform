/**
 * Protocole entre l'éditeur et le Web Worker du correcteur. Chaque requête porte un `id` repris
 * par sa réponse. Les messages reçus sont validés (`parseSpellRequest`, `parseSpellResponse`) :
 * un message mal formé est rejeté sans exception.
 */

/** Langues des dictionnaires (colonne `projects.spellcheck_language`). */
export const SPELL_LANGUAGES = ['en', 'fr'] as const
export type SpellLanguage = (typeof SPELL_LANGUAGES)[number]

/** Mots au plus par requête `check`. */
export const MAX_CHECK_WORDS = 5000
/** Longueur maximale d'un mot vérifié (au-delà : ignoré, jamais signalé). */
export const MAX_WORD_LENGTH = 64

export type SpellRequest =
  /** Mots inconnus parmi `words` (mots déjà normalisés, sans doublon de préférence). */
  | { type: 'check'; id: number; language: SpellLanguage; words: string[] }
  /** Suggestions pour un mot (au plus `limit`, 8 par défaut). */
  | { type: 'suggest'; id: number; language: SpellLanguage; word: string; limit?: number }
  /** Remplace le dictionnaire personnel (toutes langues). */
  | { type: 'personal'; id: number; words: string[] }

export type SpellErrorCode = 'E_BAD_REQUEST' | 'E_DICTIONARY_UNAVAILABLE' | 'E_INTERNAL'

export type SpellResponse =
  | { type: 'checked'; id: number; misspelled: string[] }
  | { type: 'suggested'; id: number; suggestions: string[] }
  | { type: 'ok'; id: number }
  | { type: 'error'; id: number; code: SpellErrorCode; message: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

export function isSpellLanguage(value: unknown): value is SpellLanguage {
  return typeof value === 'string' && (SPELL_LANGUAGES as readonly string[]).includes(value)
}

function isWord(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_WORD_LENGTH
}

function isWordList(value: unknown, max: number): value is string[] {
  return Array.isArray(value) && value.length <= max && value.every(isWord)
}

/** Requête validée, ou `{ error }` (avec l'`id` s'il est lisible) pour un message invalide. */
export function parseSpellRequest(
  value: unknown,
): { request: SpellRequest } | { error: string; id: number } {
  if (!isRecord(value)) return { error: 'Message must be an object', id: -1 }
  const id = isId(value.id) ? value.id : -1
  if (id === -1) return { error: 'Invalid id', id }
  switch (value.type) {
    case 'check':
      if (!isSpellLanguage(value.language)) return { error: 'Unknown language', id }
      if (!isWordList(value.words, MAX_CHECK_WORDS)) return { error: 'Invalid words', id }
      return { request: { type: 'check', id, language: value.language, words: value.words } }
    case 'suggest': {
      if (!isSpellLanguage(value.language)) return { error: 'Unknown language', id }
      if (!isWord(value.word)) return { error: 'Invalid word', id }
      const limit = value.limit
      if (limit !== undefined && !(isId(limit) && limit >= 1 && limit <= 20)) {
        return { error: 'Invalid limit', id }
      }
      return {
        request: {
          type: 'suggest',
          id,
          language: value.language,
          word: value.word,
          ...(limit === undefined ? {} : { limit }),
        },
      }
    }
    case 'personal':
      if (!isWordList(value.words, MAX_CHECK_WORDS)) return { error: 'Invalid words', id }
      return { request: { type: 'personal', id, words: value.words } }
    default:
      return { error: 'Unknown message type', id }
  }
}

/** Réponse validée, ou null pour un message qui n'en est pas une. */
export function parseSpellResponse(value: unknown): SpellResponse | null {
  if (!isRecord(value) || !isId(value.id)) return null
  const id = value.id
  switch (value.type) {
    case 'checked':
      return Array.isArray(value.misspelled) &&
        value.misspelled.every((word) => typeof word === 'string')
        ? { type: 'checked', id, misspelled: value.misspelled }
        : null
    case 'suggested':
      return Array.isArray(value.suggestions) &&
        value.suggestions.every((word) => typeof word === 'string')
        ? { type: 'suggested', id, suggestions: value.suggestions }
        : null
    case 'ok':
      return { type: 'ok', id }
    case 'error':
      return typeof value.message === 'string' &&
        (value.code === 'E_BAD_REQUEST' ||
          value.code === 'E_DICTIONARY_UNAVAILABLE' ||
          value.code === 'E_INTERNAL')
        ? { type: 'error', id, code: value.code, message: value.message }
        : null
    default:
      return null
  }
}
