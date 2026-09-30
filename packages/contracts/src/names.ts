import { z } from 'zod'

/**
 * Longueur maximale d'un nom de dossier, document ou fichier, en octets UTF-8.
 * Les systèmes de fichiers Linux (ext4) limitent un nom à 255 octets : compter en
 * caractères laisserait passer des noms que l'agent de compilation ne pourrait pas écrire.
 */
export const MAX_NAME_BYTES = 255

/** Longueur maximale d'un chemin relatif dans un projet, en octets UTF-8. */
export const MAX_PATH_BYTES = 1024

const utf8 = new TextEncoder()

function byteLength(value: string): number {
  return utf8.encode(value).length
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index)
    if (code <= 0x1f || code === 0x7f) return true
  }
  return false
}

/**
 * Un nom d'entité (dossier, document ou fichier) est refusé s'il est vide, s'il contient
 * `..`, `/`, `\` ou un caractère de contrôle, ou s'il dépasse 255 octets.
 */
export function isValidEntityName(name: string): boolean {
  if (name.trim().length === 0 || name === '.') return false
  if (name.includes('..') || name.includes('/') || name.includes('\\')) return false
  if (hasControlCharacter(name)) return false
  return byteLength(name) <= MAX_NAME_BYTES
}

/**
 * Chemin relatif sûr, séparé par `/` (ex. `chapters/intro.tex`) : jamais absolu, sans segment
 * vide, et chaque segment respecte les règles d'un nom d'entité (donc aucun `..`).
 */
export function isSafeRelativePath(path: string): boolean {
  if (path.length === 0 || byteLength(path) > MAX_PATH_BYTES) return false
  return path.split('/').every(isValidEntityName)
}

export const entityNameSchema = z.string().refine(isValidEntityName, { message: 'Invalid name' })

export const relativePathSchema = z
  .string()
  .refine(isSafeRelativePath, { message: 'Unsafe relative path' })
