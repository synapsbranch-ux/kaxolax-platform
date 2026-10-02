import { loadedPackages } from '../packages.js'
import { environments, maskCode } from '../writing/mask.js'

/** `\label{…}` d'un fichier .tex. */
export interface LabelDefinition {
  name: string
  /** Ligne (1 = première) et position de `\label`. */
  line: number
  from: number
  /** Environnement qui contient le label (`equation`, `figure`…), ou section sinon. */
  context?: string
}

/** Commande définie par `\newcommand`, `\DeclareMathOperator`, `\def`… */
export interface CommandDefinition {
  name: string
  /** Nombre d'arguments obligatoires. */
  arity: number
}

/** Ce que l'autocomplétion retient d'un fichier .tex. */
export interface TexFileScan {
  labels: LabelDefinition[]
  commands: CommandDefinition[]
  environments: string[]
  /** Packages chargés dans le préambule (fichier principal), et classe `class:nom`. */
  packages: string[]
  /** Dossiers déclarés par `\graphicspath{{figures/}{img/}}`, tels qu'écrits. */
  graphicsPaths: string[]
}

const LABEL = /\\label\s*\{([^{}]+)\}/g
const NEW_COMMAND =
  /\\(?:re)?(?:newcommand|providecommand|DeclareRobustCommand)\*?\s*\{?\s*\\([a-zA-Z@]+)\s*\}?(?:\s*\[(\d)\])?/g
const MATH_OPERATOR = /\\DeclareMathOperator\*?\s*\{?\s*\\([a-zA-Z@]+)/g
const DEF = /\\(?:g|e|x)?def\s*\\([a-zA-Z@]+)((?:#\d)*)/g
const DOCUMENT_COMMAND =
  /\\(?:New|Renew|Provide|Declare)DocumentCommand\s*\{?\s*\\([a-zA-Z@]+)\s*\}?\s*\{([^{}]*)\}/g
const NEW_ENVIRONMENT =
  /\\(?:(?:re)?newenvironment|NewDocumentEnvironment|newtheorem\*?|declaretheorem)\s*(?:\[[^\]]*\]\s*)?\{([^{}\\]+)\}/g
const SECTION = /\\(part|chapter|section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{/g
const GRAPHICS_PATH = /\\graphicspath\s*\{((?:\s*\{[^{}]*\})*)\s*\}/g
const DOCUMENT_CLASS = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/

/** Analyse un fichier .tex : labels, commandes et environnements définis, packages chargés. */
export function scanTexFile(text: string): TexFileScan {
  const { code } = maskCode(text)
  const lines: number[] = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines.push(i + 1)
  const lineOf = (offset: number) => {
    let low = 0
    let high = lines.length - 1
    while (low < high) {
      const middle = (low + high + 1) >> 1
      if ((lines[middle] ?? 0) <= offset) low = middle
      else high = middle - 1
    }
    return low + 1
  }

  const labels: LabelDefinition[] = []
  const labelMatches = [...code.matchAll(LABEL)]
  if (labelMatches.length > 0) {
    const ranges = environments(code).filter((range) => range.name !== 'document')
    const sections = [...code.matchAll(SECTION)].map((match) => ({
      at: match.index,
      name: match[1] ?? 'section',
    }))
    for (const match of labelMatches) {
      const name = match[1]?.trim()
      if (name === undefined || name === '') continue
      const at = match.index
      let context: string | undefined
      for (const range of ranges) {
        if (range.from < at && range.to > at) context = range.name
      }
      context ??= sections.findLast((section) => section.at < at)?.name
      labels.push({ name, line: lineOf(at), from: at, ...(context ? { context } : {}) })
    }
  }

  const commands = new Map<string, number>()
  for (const match of code.matchAll(NEW_COMMAND)) {
    if (match[1] !== undefined) commands.set(match[1], Number(match[2] ?? 0))
  }
  for (const match of code.matchAll(MATH_OPERATOR)) {
    if (match[1] !== undefined) commands.set(match[1], 0)
  }
  for (const match of code.matchAll(DEF)) {
    if (match[1] !== undefined) commands.set(match[1], (match[2] ?? '').length / 2)
  }
  for (const match of code.matchAll(DOCUMENT_COMMAND)) {
    if (match[1] !== undefined) {
      commands.set(match[1], (match[2] ?? '').replace(/[^mrRvb]/g, '').length)
    }
  }
  const definedEnvironments = new Set<string>()
  for (const match of code.matchAll(NEW_ENVIRONMENT)) {
    const name = match[1]?.trim()
    if (name) definedEnvironments.add(name)
  }

  const packages = loadedPackages(text).flatMap((loaded) => loaded.names)
  const documentClass = DOCUMENT_CLASS.exec(code)?.[1]?.trim()
  if (documentClass) packages.push(`class:${documentClass}`)

  const graphicsPaths: string[] = []
  for (const match of code.matchAll(GRAPHICS_PATH)) {
    for (const dir of (match[1] ?? '').matchAll(/\{([^{}]*)\}/g)) {
      const value = dir[1]?.trim()
      if (value) graphicsPaths.push(value)
    }
  }

  return {
    labels,
    commands: [...commands].map(([name, arity]) => ({ name, arity })),
    environments: [...definedEnvironments],
    packages,
    graphicsPaths,
  }
}
