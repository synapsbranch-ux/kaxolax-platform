import type { Text } from '@codemirror/state'
import {
  codeOf,
  groupEnd,
  indentationOf,
  skipSpaces,
  splitList,
  VERBATIM_ENVIRONMENTS,
} from './scan.js'

/** Préambule d'un document : de `\documentclass` à `\begin{document}`. */
export interface Preamble {
  /** Début et fin de la commande `\documentclass[…]{…}`. */
  classFrom: number
  classTo: number
  /** Début de `\begin{document}`, ou fin du texte s'il n'y en a pas encore. */
  end: number
}

/** Package chargé par `\usepackage` ou `\RequirePackage` dans le préambule. */
export interface LoadedPackage {
  command: 'usepackage' | 'RequirePackage'
  /** Packages de la commande (`\usepackage{a,b}` en charge deux). */
  names: string[]
  options: string[]
  /** Début et fin de la commande. */
  from: number
  to: number
  /** Position des crochets d'options (`[` et après `]`), absents sans options. */
  optionsFrom?: number
  optionsTo?: number
}

/** Ce que l'ajout d'un package demande au document. */
export type PackagePlan =
  /** Nouvelle ligne `\usepackage` ; `nameOffset` : position du nom dans le texte inséré. */
  | { status: 'insert'; change: { from: number; insert: string }; nameOffset: number }
  /** Options ajoutées à la commande existante. */
  | { status: 'update'; change: { from: number; insert: string }; package: LoadedPackage }
  /** Déjà chargé avec toutes les options demandées : rien à faire. */
  | { status: 'present'; package: LoadedPackage }
  /** Chargé dans une liste (`\usepackage[x]{a,b}`) sans les options demandées : à régler à la main. */
  | { status: 'conflict'; package: LoadedPackage; missingOptions: string[] }
  /** Pas de `\documentclass` : fichier inclus, le package va dans le fichier principal. */
  | { status: 'no-preamble' }

/** Packages à charger en dernier : un nouveau package s'insère avant eux. */
const LOAD_LAST = new Set(['hyperref', 'cleveref', 'autonum', 'bookmark'])

const VERBATIM_BEGIN = new RegExp(
  `\\\\begin\\{(${VERBATIM_ENVIRONMENTS.map((name) => name.replace('*', '\\*')).join('|')})\\}`,
)

/**
 * Code du préambule, à positions identiques au texte : commentaires et environnements verbatim
 * remplacés par des espaces, arrêt à la ligne de `\begin{document}`.
 */
function preambleCode(text: string): { code: string; begin: number | null } {
  let code = ''
  let offset = 0
  let verbatimEnd: string | null = null
  while (offset <= text.length) {
    const newline = text.indexOf('\n', offset)
    const lineEnd = newline === -1 ? text.length : newline
    const line = text.slice(offset, lineEnd)
    let masked: string
    if (verbatimEnd !== null) {
      const end = line.indexOf(verbatimEnd)
      if (end === -1) masked = ' '.repeat(line.length)
      else {
        masked = ' '.repeat(end + verbatimEnd.length) + codeOf(line.slice(end + verbatimEnd.length))
        verbatimEnd = null
      }
    } else {
      masked = codeOf(line)
      const verbatim = VERBATIM_BEGIN.exec(masked)
      if (verbatim?.[1] !== undefined) {
        const after = verbatim.index + verbatim[0].length
        verbatimEnd = `\\end{${verbatim[1]}}`
        const end = line.indexOf(verbatimEnd, after)
        if (end === -1) masked = masked.slice(0, after)
        else verbatimEnd = null
      }
    }
    masked = masked.padEnd(line.length, ' ')
    const begin = /\\begin\s*\{document\}/.exec(masked)
    if (begin) return { code: code + masked, begin: offset + begin.index }
    code += masked + (newline === -1 ? '' : '\n')
    if (newline === -1) break
    offset = newline + 1
  }
  return { code, begin: null }
}

/** Fin de la commande qui commence à `from` et prend `[optionnel]{obligatoire}`. */
function commandArguments(
  code: string,
  from: number,
  name: string,
): { optional?: [number, number]; required?: [number, number]; to: number } {
  let i = skipSpaces(code, from + name.length + 1)
  let optional: [number, number] | undefined
  if (code[i] === '[') {
    const end = groupEnd(code, i)
    if (end < 0) return { to: from + name.length + 1 }
    optional = [i, end]
    i = skipSpaces(code, end)
  }
  if (code[i] !== '{') return { ...(optional ? { optional } : {}), to: optional?.[1] ?? i }
  const end = groupEnd(code, i)
  if (end < 0) return { ...(optional ? { optional } : {}), to: optional?.[1] ?? i }
  return { ...(optional ? { optional } : {}), required: [i, end], to: end }
}

interface Analysis {
  text: string
  code: string
  preamble: Preamble | null
}

function analyse(doc: Text | string): Analysis {
  const text = typeof doc === 'string' ? doc : doc.toString()
  const { code, begin } = preambleCode(text)
  const documentclass = /\\documentclass(?![a-zA-Z@])/.exec(code)
  if (!documentclass) return { text, code, preamble: null }
  const classFrom = documentclass.index
  const { to } = commandArguments(code, classFrom, 'documentclass')
  return { text, code, preamble: { classFrom, classTo: to, end: begin ?? text.length } }
}

function packagesOf({ text, code, preamble }: Analysis): LoadedPackage[] {
  if (!preamble) return []
  const packages: LoadedPackage[] = []
  const pattern = /\\(usepackage|RequirePackage)(?![a-zA-Z@])/g
  pattern.lastIndex = preamble.classTo
  const preambleCode = code.slice(0, preamble.end)
  for (let match = pattern.exec(preambleCode); match !== null; match = pattern.exec(preambleCode)) {
    const command = match[1] as LoadedPackage['command']
    const args = commandArguments(preambleCode, match.index, command)
    pattern.lastIndex = Math.max(args.to, match.index + match[0].length)
    if (!args.required) continue
    const names = splitList(text.slice(args.required[0] + 1, args.required[1] - 1))
    if (names.length === 0) continue
    packages.push({
      command,
      names,
      options: args.optional
        ? splitList(text.slice(args.optional[0] + 1, args.optional[1] - 1))
        : [],
      from: match.index,
      to: args.to,
      ...(args.optional ? { optionsFrom: args.optional[0], optionsTo: args.optional[1] } : {}),
    })
  }
  return packages
}

/** Préambule du document, ou null s'il n'a pas de `\documentclass` (fichier inclus). */
export function findPreamble(doc: Text | string): Preamble | null {
  return analyse(doc).preamble
}

/** Packages chargés dans le préambule, dans l'ordre. */
export function loadedPackages(doc: Text | string): LoadedPackage[] {
  return packagesOf(analyse(doc))
}

/** Texte d'une commande `\usepackage[options]{name}`. */
export function usepackageCommand(name: string, options: readonly string[] = []): string {
  return `\\usepackage${options.length > 0 ? `[${options.join(',')}]` : ''}{${name}}`
}

/**
 * Ce qu'il faut changer pour charger `name` avec `options` : nouvelle ligne après le dernier
 * package (avant hyperref et les packages à charger après lui), ou à défaut après
 * `\documentclass` ; options ajoutées à une commande existante ; ou rien si le package est déjà
 * là. Avec `name` vide, insère `\usepackage{}` (nom à saisir).
 */
export function planPackage(
  doc: Text | string,
  name: string,
  options: readonly string[] = [],
): PackagePlan {
  const analysis = analyse(doc)
  const { text, preamble } = analysis
  if (!preamble) return { status: 'no-preamble' }
  const packages = packagesOf(analysis)

  if (name !== '') {
    const existing = packages.find((loaded) => loaded.names.includes(name))
    if (existing) {
      const missingOptions = options.filter((option) => !existing.options.includes(option))
      if (missingOptions.length === 0) return { status: 'present', package: existing }
      if (existing.names.length > 1)
        return { status: 'conflict', package: existing, missingOptions }
      const change =
        existing.optionsTo === undefined
          ? {
              from: existing.from + existing.command.length + 1,
              insert: `[${missingOptions.join(',')}]`,
            }
          : {
              from: existing.optionsTo - 1,
              insert: `${existing.options.length > 0 ? ',' : ''}${missingOptions.join(',')}`,
            }
      return { status: 'update', change, package: existing }
    }
  }

  const command = usepackageCommand(name, options)
  const nameOffset = command.length - 1 - name.length
  const lineStartOf = (position: number) => text.lastIndexOf('\n', position - 1) + 1
  const lineEndOf = (position: number) => {
    const newline = text.indexOf('\n', position)
    return Math.min(newline === -1 ? text.length : newline, preamble.end)
  }

  const last = LOAD_LAST.has(name)
    ? undefined
    : packages.find((loaded) => loaded.names.some((loadedName) => LOAD_LAST.has(loadedName)))
  if (last) {
    const from = lineStartOf(last.from)
    const indent = indentationOf(text.slice(from, last.from))
    return {
      status: 'insert',
      change: { from, insert: `${indent}${command}\n` },
      nameOffset: indent.length + nameOffset,
    }
  }
  const previous = packages.at(-1)
  const anchor = previous?.to ?? preamble.classTo
  const from = lineEndOf(anchor)
  const indent = previous
    ? indentationOf(text.slice(lineStartOf(previous.from), previous.from))
    : ''
  return {
    status: 'insert',
    change: { from, insert: `\n${indent}${command}` },
    nameOffset: 1 + indent.length + nameOffset,
  }
}
