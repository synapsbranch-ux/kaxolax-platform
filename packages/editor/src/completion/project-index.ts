import { type ProjectPackage, projectPackages } from '../package-manager.js'
import { type BibEntry, bibtexToText, parseBibtex, shortAuthors } from './bibtex.js'
import { type CommandDefinition, type LabelDefinition, scanTexFile } from './tex-scan.js'

/** Label du projet, avec son fichier. */
export interface ProjectLabel extends LabelDefinition {
  file: string
}

/** Clé de bibliographie du projet. */
export interface ProjectCitation {
  key: string
  type: string
  file: string
  line: number
  /** Texte lisible : auteurs abrégés, année, titre. */
  authors: string
  year: string
  title: string
}

/**
 * Sources de l'autocomplétion, fournies par l'application : labels de tout le projet, clés de
 * tous les .bib, chemins des fichiers, packages chargés, commandes et environnements définis.
 * `version` change à chaque modification : l'autocomplétion garde ses listes tant qu'il est stable.
 */
export interface CompletionSources {
  readonly version: number
  labels(): readonly ProjectLabel[]
  citations(): readonly ProjectCitation[]
  /** Chemins des fichiers du projet depuis la racine (`chapitres/intro.tex`, `figures/a.png`). */
  files(): readonly string[]
  /**
   * Dossier du document principal depuis la racine (`''` à la racine, `these` pour
   * `these/main.tex`) : LaTeX et texcount tournent dans ce dossier, les chemins proposés après
   * `\input{`… sont donc relatifs à lui.
   */
  rootDirectory?(): string
  /** Dossiers de `\graphicspath` (relatifs au dossier du document principal). */
  graphicsPaths?(): readonly string[]
  /** Packages chargés (et `class:nom` pour la classe du document). */
  packages(): readonly string[]
  commands(): readonly CommandDefinition[]
  environments(): readonly string[]
  /** Noms de packages proposés après `\usepackage{` (index TeX Live servi par l'API). */
  packageNames?(): readonly string[]
}

interface TexEntry {
  kind: 'tex'
  labels: ProjectLabel[]
  commands: CommandDefinition[]
  environments: string[]
  packages: string[]
  graphicsPaths: string[]
  /** Texte d'un document racine (avec `\documentclass`), pour `preamblePackages`. */
  root: string | null
}

interface BibFileEntry {
  kind: 'bib'
  citations: ProjectCitation[]
  errors: number
}

/** Extensions analysées comme du LaTeX. */
const TEX_EXTENSIONS = /\.(tex|ltx|sty|cls|tikz)$/i

function citationOf(entry: BibEntry, file: string): ProjectCitation {
  const date = entry.fields.year ?? entry.fields.date ?? ''
  return {
    key: entry.key,
    type: entry.type,
    file,
    line: entry.line,
    authors: shortAuthors(entry.fields.author ?? entry.fields.editor ?? ''),
    year: /\d{4}/.exec(date)?.[0] ?? '',
    title: bibtexToText(entry.fields.title ?? ''),
  }
}

/**
 * Index du projet pour l'autocomplétion, mis à jour à la volée par l'application : `setFile`
 * à chaque modification d'un .tex ou d'un .bib (de préférence après une courte pause de frappe),
 * `setFiles` quand l'arborescence change. Les listes sont recalculées à la demande, une fois par
 * version.
 */
export class ProjectIndex implements CompletionSources {
  #version = 0
  readonly #entries = new Map<string, TexEntry | BibFileEntry>()
  #files: readonly string[] = []
  #rootDirectory = ''
  #packageNames: readonly string[] = []
  readonly #listeners = new Set<() => void>()
  readonly #cache = new Map<string, unknown>()

  get version(): number {
    return this.#version
  }

  /** Analyse (ou réanalyse) un fichier texte ; les autres extensions sont ignorées. */
  setFile(path: string, text: string): void {
    if (/\.bib$/i.test(path)) {
      const { entries, errors } = parseBibtex(text)
      this.#entries.set(path, {
        kind: 'bib',
        citations: entries.map((entry) => citationOf(entry, path)),
        errors: errors.length,
      })
    } else if (TEX_EXTENSIONS.test(path)) {
      const scan = scanTexFile(text)
      this.#entries.set(path, {
        kind: 'tex',
        labels: scan.labels.map((label) => ({ ...label, file: path })),
        commands: scan.commands,
        environments: scan.environments,
        packages: scan.packages,
        graphicsPaths: scan.graphicsPaths,
        root: text.includes('\\documentclass') ? text : null,
      })
    } else return
    this.#changed()
  }

  removeFile(path: string): void {
    if (this.#entries.delete(path)) this.#changed()
  }

  renameFile(from: string, to: string): void {
    const entry = this.#entries.get(from)
    if (!entry) return
    this.#entries.delete(from)
    if (entry.kind === 'bib') {
      entry.citations = entry.citations.map((citation) => ({ ...citation, file: to }))
    } else {
      entry.labels = entry.labels.map((label) => ({ ...label, file: to }))
    }
    this.#entries.set(to, entry)
    this.#changed()
  }

  /** Chemins de tous les fichiers du projet (texte et binaires). */
  setFiles(paths: readonly string[]): void {
    this.#files = [...paths].sort()
    const present = new Set(paths)
    for (const path of [...this.#entries.keys()]) {
      if (!present.has(path)) this.#entries.delete(path)
    }
    this.#changed()
  }

  /** Dossier du document principal (`these` pour `these/main.tex`, `''` à la racine). */
  setRootDirectory(directory: string): void {
    const normalized = directory.replace(/^\/+|\/+$/g, '')
    if (normalized === this.#rootDirectory) return
    this.#rootDirectory = normalized
    this.#changed()
  }

  /** Noms des packages de l'index TeX Live (proposés après `\usepackage{`). */
  setPackageNames(names: readonly string[]): void {
    this.#packageNames = names
    this.#changed()
  }

  /** Abonnement aux modifications ; renvoie la fonction de désabonnement. */
  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  /** Nombre d'erreurs d'analyse d'un .bib (0 si inconnu). */
  bibErrors(path: string): number {
    const entry = this.#entries.get(path)
    return entry?.kind === 'bib' ? entry.errors : 0
  }

  labels(): readonly ProjectLabel[] {
    return this.#memo('labels', () => this.#tex().flatMap((entry) => entry.labels))
  }

  citations(): readonly ProjectCitation[] {
    return this.#memo('citations', () => {
      const seen = new Set<string>()
      const result: ProjectCitation[] = []
      for (const entry of this.#entries.values()) {
        if (entry.kind !== 'bib') continue
        for (const citation of entry.citations) {
          if (seen.has(citation.key)) continue
          seen.add(citation.key)
          result.push(citation)
        }
      }
      return result
    })
  }

  files(): readonly string[] {
    return this.#files
  }

  rootDirectory(): string {
    return this.#rootDirectory
  }

  graphicsPaths(): readonly string[] {
    return this.#memo('graphicsPaths', () => [
      ...new Set(this.#tex().flatMap((entry) => entry.graphicsPaths)),
    ])
  }

  packages(): readonly string[] {
    return this.#memo('packages', () => [
      ...new Set(this.#tex().flatMap((entry) => entry.packages)),
    ])
  }

  commands(): readonly CommandDefinition[] {
    return this.#memo('commands', () => {
      const commands = new Map<string, CommandDefinition>()
      for (const entry of this.#tex()) {
        for (const command of entry.commands) commands.set(command.name, command)
      }
      return [...commands.values()]
    })
  }

  environments(): readonly string[] {
    return this.#memo('environments', () => [
      ...new Set(this.#tex().flatMap((entry) => entry.environments)),
    ])
  }

  packageNames(): readonly string[] {
    return this.#packageNames
  }

  /**
   * Commandes de chargement du préambule d'un document racine (options et lignes comprises) :
   * le gestionnaire de packages les montre quand le fichier ouvert n'a pas de préambule. Null si
   * le document n'est pas (encore) lu ou n'a pas de `\documentclass`.
   */
  preamblePackages(path: string): readonly ProjectPackage[] | null {
    const entry = this.#entries.get(path)
    if (entry?.kind !== 'tex' || entry.root === null) return null
    const root = entry.root
    return this.#memo(`preamble:${path}`, () => projectPackages(root))
  }

  #tex(): TexEntry[] {
    return [...this.#entries.values()].filter((entry): entry is TexEntry => entry.kind === 'tex')
  }

  #memo<T>(key: string, compute: () => T): T {
    if (this.#cache.has(key)) return this.#cache.get(key) as T
    const value = compute()
    this.#cache.set(key, value)
    return value
  }

  #changed(): void {
    this.#version++
    this.#cache.clear()
    for (const listener of this.#listeners) listener()
  }
}
