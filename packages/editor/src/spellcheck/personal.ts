/**
 * Dictionnaire personnel (préférence `spellcheckDictionary` de @kaxolax/contracts) : mêmes bornes
 * que le schéma, pour qu'une modification faite dans l'éditeur soit toujours acceptée par l'API.
 */

/** Mots au plus (`MAX_PERSONAL_DICTIONARY_WORDS` des contrats). */
export const PERSONAL_DICTIONARY_LIMIT = 1000
/** Taille au plus de la liste sérialisée en JSON, en octets UTF-8 (`MAX_PERSONAL_DICTIONARY_BYTES`). */
export const PERSONAL_DICTIONARY_MAX_BYTES = 20 * 1024

/** Mot acceptable : lettres, marques, apostrophes et traits d'union, 1 à 40 caractères. */
export const PERSONAL_WORD = /^[\p{L}\p{M}][\p{L}\p{M}'’-]{0,39}$/u

/** Le mot peut entrer dans le dictionnaire personnel. */
export function isPersonalWord(word: string): boolean {
  return PERSONAL_WORD.test(word)
}

const encoder = new TextEncoder()

/** Taille de la liste sérialisée en JSON, en octets UTF-8 (comme la mesure l'API). */
export function personalDictionaryBytes(words: readonly string[]): number {
  return encoder.encode(JSON.stringify(words)).length
}

/**
 * Sort d'un ajout : `ok`, mot `invalid`, `duplicate` (déjà présent) ou `full` (dictionnaire plein,
 * en nombre de mots ou en octets : l'ajout est refusé, aucun mot ancien ne sort).
 */
export type PersonalWordStatus = 'ok' | 'invalid' | 'duplicate' | 'full'

/** Ce que donnerait l'ajout de `word` (voir `PersonalWordStatus`). */
export function personalWordStatus(words: readonly string[], word: string): PersonalWordStatus {
  const normalized = word.normalize('NFC')
  if (!isPersonalWord(normalized)) return 'invalid'
  if (words.includes(normalized)) return 'duplicate'
  if (words.length >= PERSONAL_DICTIONARY_LIMIT) return 'full'
  if (personalDictionaryBytes([normalized, ...words]) > PERSONAL_DICTIONARY_MAX_BYTES) return 'full'
  return 'ok'
}

/**
 * Ajoute un mot (en tête, sans doublon). Renvoie la liste inchangée si le mot est invalide, déjà
 * présent ou si le dictionnaire est plein (`personalWordStatus` dit pourquoi).
 */
export function addPersonalWord(words: readonly string[], word: string): string[] {
  if (personalWordStatus(words, word) !== 'ok') return [...words]
  return [word.normalize('NFC'), ...words]
}

/** Retire un mot. */
export function removePersonalWord(words: readonly string[], word: string): string[] {
  const normalized = word.normalize('NFC')
  return words.filter((entry) => entry !== normalized)
}
