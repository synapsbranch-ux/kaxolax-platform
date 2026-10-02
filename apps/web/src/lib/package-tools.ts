import type { LogEntry, PackageSuggestion } from '@kaxolax/contracts'
import type { PackageManagerPayload } from '@kaxolax/editor'
import { ApiError, errorMessage } from './api'

/** Package ou classe introuvable d'une erreur « File `xyz.sty' not found ». */
export interface MissingPackage {
  /** Nom écrit dans le document (`graphix`), sans extension. */
  name: string
  kind: 'package' | 'class'
  /** Fichier introuvable tel que le log le donne (`graphix.sty`). */
  file: string
}

/**
 * Package (`.sty`) ou classe (`.cls`) introuvable d'une entrée du log ; null pour un autre
 * fichier (`\input{chapitre}`) ou une autre erreur.
 */
export function missingPackageOf(entry: LogEntry): MissingPackage | null {
  const file = entry.missingFile
  if (entry.level !== 'error' || file === undefined) return null
  const match = /^(?:.*\/)?([^/]+)\.(sty|cls)$/i.exec(file)
  if (!match?.[1] || !match[2]) return null
  return { name: match[1], kind: match[2].toLowerCase() === 'cls' ? 'class' : 'package', file }
}

/** Remplacement dans le texte d'un document (positions du texte d'origine). */
export interface TextChange {
  from: number
  to: number
  insert: string
  /** Ligne de la commande modifiée (1 = première). */
  line: number
}

/** Position du `%` qui commence un commentaire sur la ligne de `offset` (avant lui), ou -1. */
function commentStart(text: string, offset: number): number {
  const lineStart = text.lastIndexOf('\n', offset - 1) + 1
  for (let i = lineStart; i < offset; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '%') return i
  }
  return -1
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++
  return line
}

/** Noms d'une liste `{a, b,% commentaire\n c}` avec leur position dans le texte. */
function listItems(text: string, from: number, to: number): { name: string; from: number }[] {
  const items: { name: string; from: number }[] = []
  let start = -1
  for (let i = from; i <= to; i++) {
    const char = i < to ? text[i] : ','
    if (char === '%') {
      // Commentaire jusqu'à la fin de la ligne : il termine l'élément en cours.
      if (start !== -1) items.push({ name: text.slice(start, i).trim(), from: start })
      start = -1
      const end = text.indexOf('\n', i)
      i = end === -1 || end > to ? to : end
      continue
    }
    if (char === ',' || char === '\n' || char === ' ' || char === '\t' || char === '\r') {
      if (start !== -1) items.push({ name: text.slice(start, i), from: start })
      start = -1
    } else if (start === -1) start = i
  }
  return items.filter((item) => item.name !== '')
}

const PACKAGE_COMMAND =
  /\\(?:usepackage|RequirePackage)(?![a-zA-Z@])\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g
const CLASS_COMMAND = /\\(?:documentclass|LoadClass)(?![a-zA-Z@])\s*(?:\[[^\]]*\]\s*)?\{([^{}]*)\}/g

/**
 * Remplace `wrong` par `right` dans un `\usepackage` / `\RequirePackage` (ou, pour une classe,
 * `\documentclass` / `\LoadClass`) : seul le nom change, options, liste et mise en forme sont
 * gardées. Les commandes en commentaire sont ignorées. Si plusieurs commandes chargent ce nom,
 * celle de la ligne `line` (celle du log) est préférée, sinon la première. Null si le nom n'est
 * chargé nulle part.
 */
export function planRenamePackage(
  text: string,
  kind: MissingPackage['kind'],
  wrong: string,
  right: string,
  line: number | null = null,
): TextChange | null {
  const pattern = new RegExp(kind === 'class' ? CLASS_COMMAND : PACKAGE_COMMAND)
  const candidates: TextChange[] = []
  for (const match of text.matchAll(pattern)) {
    const argument = match[1]
    if (argument === undefined || commentStart(text, match.index) !== -1) continue
    const argumentTo = match.index + match[0].length - 1
    const argumentFrom = argumentTo - argument.length
    for (const item of listItems(text, argumentFrom, argumentTo)) {
      if (item.name !== wrong) continue
      candidates.push({
        from: item.from,
        to: item.from + wrong.length,
        insert: right,
        line: lineAt(text, match.index),
      })
    }
  }
  if (candidates.length === 0) return null
  if (line !== null) {
    // Commande qui commence sur la ligne du log, sinon la dernière qui commence avant elle
    // (liste sur plusieurs lignes).
    const before = candidates.filter((candidate) => candidate.line <= line)
    const exact = candidates.find((candidate) => candidate.line === line)
    return exact ?? before.at(-1) ?? candidates[0] ?? null
  }
  return candidates[0] ?? null
}

/**
 * Options saisies (`margin=2cm, a4paper, style={a,b}`) : liste nettoyée (les virgules entre
 * accolades restent dans l'option), ou null si elles contiennent des caractères qui sortiraient
 * des crochets (`[`, `]`, `\`, `%`, accolades déséquilibrées).
 */
export function parsePackageOptions(input: string): string[] | null {
  if (/[[\]\\%]/.test(input)) return null
  const options: string[] = []
  let depth = 0
  let current = ''
  for (const char of input) {
    if (char === '{') depth++
    else if (char === '}' && --depth < 0) return null
    if (char === ',' && depth === 0) {
      options.push(current)
      current = ''
    } else current += char
  }
  if (depth !== 0) return null
  options.push(current)
  return options.map((option) => option.trim()).filter((option) => option !== '')
}

/** Libellé court d'une suggestion : `graphicx (package graphics)` si les noms diffèrent. */
export function suggestionLabel(suggestion: PackageSuggestion): string {
  return suggestion.package === suggestion.name
    ? suggestion.name
    : `${suggestion.name} (package ${suggestion.package})`
}

/** Nom de package valide pour `\usepackage{…}` (lettres, chiffres, `-`, `_`, `.`, `/`). */
export function isPackageName(name: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/.test(name)
}

/** Contexte transmis par l'action `packages.manager` (vérifié avant affichage). */
export function isPackageManagerPayload(value: unknown): value is PackageManagerPayload {
  if (typeof value !== 'object' || value === null) return false
  const payload = value as Partial<PackageManagerPayload>
  return (
    payload.kind === 'packages' &&
    Array.isArray(payload.packages) &&
    typeof payload.hasPreamble === 'boolean' &&
    typeof payload.readOnly === 'boolean'
  )
}

/** Message d'une erreur de l'index des packages pour l'interface. */
export function texliveErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'E_PACKAGE_INDEX_UNAVAILABLE' || error.status === 503)
      return 'L’index des packages TeX Live est indisponible pour le moment. Réessayez plus tard.'
    if (error.status === 404) return 'Package introuvable dans TeX Live.'
  }
  return `Index des packages inaccessible (${errorMessage(error)}).`
}

/** Résultat d'un ajout (`addPackage`) en message pour l'interface. */
export function addPackageMessage(
  name: string,
  status: 'insert' | 'update' | 'present' | 'conflict' | 'no-preamble',
): { message: string; level: 'info' | 'warning' } {
  switch (status) {
    case 'insert':
      return { message: `\\usepackage{${name}} ajouté au préambule.`, level: 'info' }
    case 'update':
      return { message: `Options ajoutées à \\usepackage{${name}}.`, level: 'info' }
    case 'present':
      return { message: `${name} est déjà chargé avec ces options.`, level: 'info' }
    case 'conflict':
      return {
        message: `${name} est chargé avec d’autres packages dans un même \\usepackage : réglez ses options à la main.`,
        level: 'warning',
      }
    case 'no-preamble':
      return {
        message: 'Ce fichier n’a pas de préambule : ajoutez le package dans le document principal.',
        level: 'warning',
      }
  }
}
