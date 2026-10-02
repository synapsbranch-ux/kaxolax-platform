import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
  type CompletionSource,
  snippet,
  snippetCompletion,
} from '@codemirror/autocomplete'
import type { EditorState, Extension } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { loadedPackages } from '../packages.js'
import { SYMBOLS } from '../writing/symbols.js'
import {
  BASE_COMMANDS,
  BASE_ENVIRONMENTS,
  type CommandSpec,
  type EnvironmentSpec,
  expandPackages,
  KNOWN_PACKAGES,
  PACKAGE_COMPLETIONS,
} from './latex-data.js'
import type { CompletionSources } from './project-index.js'

export interface LatexCompletionOptions {
  /** Index du projet (labels, clés, fichiers, packages) ; sans lui, commandes de base seulement. */
  sources?: CompletionSources | (() => CompletionSources | null)
  /** Chemin du fichier édité (exclu des propositions de `\input`). */
  currentFile?: () => string | null
}

/** Argument en cours de saisie : commande, début de l'argument, texte déjà tapé. */
interface ArgumentContext {
  command: string
  /** Début de l'élément en cours (après la dernière virgule pour une liste). */
  from: number
  /** Texte de l'élément en cours. */
  text: string
}

const REF_COMMANDS = new Set([
  'ref',
  'eqref',
  'pageref',
  'autoref',
  'Autoref',
  'cref',
  'Cref',
  'cpageref',
  'Cpageref',
  'labelcref',
  'nameref',
  'Nameref',
  'vref',
  'Vref',
  'vpageref',
  'subref',
  'crefrange',
  'Crefrange',
  'hyperref',
])

/** Commandes qui prennent une liste séparée par des virgules. */
const LIST_COMMANDS =
  /cite|^(?:cref|Cref|labelcref|cpageref|Cpageref|includeonly|usepackage|RequirePackage|bibliography)$/

/** Extensions de fichier proposées selon la commande. */
const FILE_KINDS: Record<string, { extensions: RegExp; strip: boolean }> = {
  input: { extensions: /\.(tex|ltx)$/i, strip: true },
  include: { extensions: /\.tex$/i, strip: true },
  includeonly: { extensions: /\.tex$/i, strip: true },
  subfile: { extensions: /\.tex$/i, strip: false },
  import: { extensions: /\.tex$/i, strip: false },
  includegraphics: { extensions: /\.(png|jpe?g|pdf|eps)$/i, strip: false },
  includesvg: { extensions: /\.svg$/i, strip: true },
  includepdf: { extensions: /\.pdf$/i, strip: false },
  bibliography: { extensions: /\.bib$/i, strip: true },
  addbibresource: { extensions: /\.bib$/i, strip: false },
  addglobalbib: { extensions: /\.bib$/i, strip: false },
  lstinputlisting: { extensions: /\.[a-z0-9]+$/i, strip: false },
  inputminted: { extensions: /\.[a-z0-9]+$/i, strip: false },
  verbatiminput: { extensions: /\.[a-z0-9]+$/i, strip: false },
}

/** Normalise un chemin relatif (`a/./b/../c` → `a/c`) ; null s'il sort de la racine du projet. */
function normalizePath(path: string): string | null {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

/**
 * Chemin d'un fichier (depuis la racine du projet) vu du dossier `directory` (`''` = racine) :
 * `figures/a.png` vu de `these` donne `../figures/a.png`.
 */
export function relativePath(path: string, directory: string): string {
  if (directory === '') return path
  const base = directory.split('/')
  const parts = path.split('/')
  let common = 0
  while (common < base.length && common < parts.length - 1 && base[common] === parts[common]) {
    common++
  }
  return [...base.slice(common).map(() => '..'), ...parts.slice(common)].join('/')
}

/**
 * Propositions de chemins après `\input{`, `\includegraphics{`… : relatifs au dossier du
 * document principal (LaTeX et texcount y tournent), ceux qui en sortent (`../`) en dernier ;
 * pour `\includegraphics`, aussi relatifs aux dossiers de `\graphicspath`, en premier.
 */
function fileCompletions(
  files: readonly string[],
  rootDirectory: string,
  strip: boolean,
  graphicsPaths: readonly string[],
): Completion[] {
  const directories: string[] = []
  for (const declared of graphicsPaths) {
    const resolved = normalizePath(`${rootDirectory}/${declared}`)
    if (resolved !== null && resolved !== rootDirectory) directories.push(resolved)
  }
  const seen = new Set<string>()
  const result: Completion[] = []
  const add = (path: string, relative: string, boost: number) => {
    const label = strip ? relative.replace(/\.[^./]+$/, '') : relative
    if (seen.has(label)) return
    seen.add(label)
    result.push(
      strip
        ? { label, detail: path.slice(path.lastIndexOf('.')), type: 'file', boost }
        : { label, type: 'file', boost },
    )
  }
  for (const directory of directories) {
    for (const path of files) {
      if (path.startsWith(`${directory}/`)) add(path, path.slice(directory.length + 1), 1)
    }
  }
  const outside: [string, string][] = []
  for (const path of files) {
    const relative = relativePath(path, rootDirectory)
    if (relative.startsWith('../')) outside.push([path, relative])
    else add(path, relative, 0)
  }
  for (const [path, relative] of outside) add(path, relative, -1)
  return result
}

const DOCUMENT_CLASSES = [
  'article',
  'report',
  'book',
  'letter',
  'beamer',
  'memoir',
  'standalone',
  'scrartcl',
  'scrreprt',
  'scrbook',
  'scrlttr2',
  'amsart',
  'amsbook',
  'moderncv',
  'extarticle',
  'IEEEtran',
  'llncs',
  'revtex4-2',
]

const ARGUMENT = /\\([a-zA-Z@]+)\*?((?:\s*\[[^\]]*\]|\s*<[^>]*>|\s*\{[^{}]*\})*?)\s*\{([^{}]*)$/

/** Argument entre accolades en cours de saisie, s'il y en a un sur la ligne. */
export function argumentContext(state: EditorState, pos: number): ArgumentContext | null {
  const line = state.doc.lineAt(pos)
  const start = Math.max(line.from, pos - 400)
  const text = state.sliceDoc(start, pos)
  const match = ARGUMENT.exec(text)
  if (!match?.[1]) return null
  const command = match[1]
  // `\crefrange{a}{b` ou `\href{url}{texte` : seul le premier argument obligatoire est complété,
  // sauf pour les commandes à deux références.
  const previous = match[2] ?? ''
  if (previous.includes('{') && command !== 'crefrange' && command !== 'Crefrange') return null
  const argument = match[3] ?? ''
  let offset = 0
  if (LIST_COMMANDS.test(command)) offset = argument.lastIndexOf(',') + 1
  while (offset < argument.length && /\s/.test(argument.charAt(offset))) offset++
  return {
    command,
    from: pos - argument.length + offset,
    text: argument.slice(offset),
  }
}

/** Environnement ouvert le plus proche avant `pos` (pour compléter `\end{`). */
function openEnvironment(state: EditorState, pos: number): string | null {
  const text = state.sliceDoc(Math.max(0, pos - 20_000), pos)
  const stack: string[] = []
  for (const match of text.matchAll(/(?<!\\)%.*$|\\(begin|end)\s*\{([^{}]*)\}/gm)) {
    if (match[1] === undefined || match[2] === undefined) continue
    if (match[1] === 'begin') stack.push(match[2])
    else {
      const index = stack.lastIndexOf(match[2])
      if (index !== -1) stack.length = index
    }
  }
  return stack.at(-1) ?? null
}

function commandCompletion(spec: CommandSpec, boost = 0): Completion {
  const label = `\\${spec.name}`
  const info = { label, type: spec.math === true ? 'constant' : 'function', boost }
  const detailed = spec.detail === undefined ? info : { ...info, detail: spec.detail }
  return spec.args === '' ? detailed : snippetCompletion(`${label}${spec.args}`, detailed)
}

function environmentCompletion(spec: EnvironmentSpec, boost = 0): Completion {
  return {
    label: spec.name,
    type: 'type',
    boost,
    ...(spec.detail === undefined ? {} : { detail: spec.detail }),
    apply: (view: EditorView, completion: Completion, from: number, to: number) => {
      const after = view.state.sliceDoc(to, to + 1)
      // Nom d'un environnement existant : seul le nom change.
      if (after === '}') {
        view.dispatch({
          changes: { from, to, insert: spec.name },
          selection: { anchor: from + spec.name.length + 1 },
          userEvent: 'input.complete',
        })
        return
      }
      const template = `${spec.name}}${spec.args}\n\t${spec.body}\n\\end{${spec.name}}`
      snippet(template)(view, completion, from, to)
    },
  }
}

/** Listes calculées une fois par version des sources et par ensemble de packages. */
class CompletionCache {
  #key = ''
  #commands: Completion[] = []
  #environments: Completion[] = []
  #citeVersion = -1
  #citations: Completion[] = []
  #labelVersion = -1
  #labels: Completion[] = []
  #packageVersion = -1
  #packageNames: Completion[] = []

  commandsAndEnvironments(
    sources: CompletionSources | null,
    packages: readonly string[],
  ): { commands: Completion[]; environments: Completion[] } {
    const loaded = expandPackages(packages)
    const key = `${String(sources?.version ?? -1)}|${[...loaded].sort().join(',')}`
    if (key === this.#key) return { commands: this.#commands, environments: this.#environments }
    const commands = new Map<string, Completion>()
    const environments = new Map<string, Completion>()
    for (const spec of BASE_COMMANDS) commands.set(spec.name, commandCompletion(spec))
    for (const spec of BASE_ENVIRONMENTS) environments.set(spec.name, environmentCompletion(spec))
    for (const symbol of SYMBOLS) {
      const name = /^\\([a-zA-Z]+)$/.exec(symbol.command)?.[1]
      if (name === undefined || commands.has(name)) continue
      if (!symbol.packages.every((pkg) => loaded.has(pkg) || pkg === 'amsfonts')) continue
      commands.set(name, {
        label: symbol.command,
        detail: `${symbol.glyph} ${symbol.name.fr}`,
        type: symbol.mode === 'math' ? 'constant' : 'text',
        boost: -1,
      })
    }
    for (const name of loaded) {
      const completions = PACKAGE_COMPLETIONS[name]
      if (!completions) continue
      const source = name.startsWith('class:') ? name.slice(6) : name
      for (const spec of completions.commands) {
        commands.set(spec.name, commandCompletion({ ...spec, detail: spec.detail ?? source }, 1))
      }
      for (const spec of completions.environments) {
        environments.set(
          spec.name,
          environmentCompletion({ ...spec, detail: spec.detail ?? source }, 1),
        )
      }
    }
    for (const definition of sources?.commands() ?? []) {
      const args = Array.from(
        { length: definition.arity },
        (_, index) => `{\${${String(index + 1)}}}`,
      ).join('')
      commands.set(
        definition.name,
        commandCompletion({ name: definition.name, args, detail: 'projet' }, 2),
      )
    }
    for (const name of sources?.environments() ?? []) {
      environments.set(
        name,
        environmentCompletion({ name, args: '', body: '${}', detail: 'projet' }, 2),
      )
    }
    this.#key = key
    this.#commands = [...commands.values()]
    this.#environments = [...environments.values()]
    return { commands: this.#commands, environments: this.#environments }
  }

  citations(sources: CompletionSources): Completion[] {
    if (sources.version === this.#citeVersion) return this.#citations
    this.#citeVersion = sources.version
    this.#citations = sources.citations().map((citation) => {
      const detail = [citation.authors, citation.year].filter((part) => part !== '').join(' ')
      return {
        label: citation.key,
        type: 'text',
        ...(detail === '' ? {} : { detail }),
        ...(citation.title === '' ? {} : { info: citation.title }),
      }
    })
    return this.#citations
  }

  labels(sources: CompletionSources): Completion[] {
    if (sources.version === this.#labelVersion) return this.#labels
    this.#labelVersion = sources.version
    const seen = new Set<string>()
    this.#labels = []
    for (const label of sources.labels()) {
      if (seen.has(label.name)) continue
      seen.add(label.name)
      this.#labels.push({
        label: label.name,
        type: 'variable',
        detail: `${label.context ? `${label.context} · ` : ''}${label.file}:${String(label.line)}`,
      })
    }
    return this.#labels
  }

  packageNames(sources: CompletionSources | null): Completion[] {
    const version = sources?.version ?? -1
    if (version === this.#packageVersion && this.#packageNames.length > 0) {
      return this.#packageNames
    }
    this.#packageVersion = version
    const names = new Set([...KNOWN_PACKAGES, ...(sources?.packageNames?.() ?? [])])
    this.#packageNames = [...names].map((name) => ({ label: name, type: 'namespace' }))
    return this.#packageNames
  }
}

const KEY_CHARS = /^[^\s,{}]*$/

/**
 * Source d'autocomplétion LaTeX : commandes (de base, des packages chargés, définies dans le
 * projet), environnements après `\begin{` et `\end{`, labels après `\ref{` (et variantes), clés
 * des .bib après `\cite{` (et variantes natbib et biblatex), chemins après `\input{`,
 * `\include{`, `\includegraphics{`, `\bibliography{`…, packages après `\usepackage{`.
 */
export function latexCompletionSource(options: LatexCompletionOptions = {}): CompletionSource {
  const cache = new CompletionCache()
  const sourcesOf = (): CompletionSources | null =>
    typeof options.sources === 'function' ? options.sources() : (options.sources ?? null)

  return (context: CompletionContext): CompletionResult | null => {
    const { state, pos } = context
    const sources = sourcesOf()
    const argument = argumentContext(state, pos)
    if (argument) {
      const { command, from } = argument
      if (/cite/i.test(command) || command === 'nocite') {
        if (!sources) return null
        return { from, options: cache.citations(sources), validFor: KEY_CHARS }
      }
      if (REF_COMMANDS.has(command)) {
        if (!sources) return null
        return { from, options: cache.labels(sources), validFor: KEY_CHARS }
      }
      if (command === 'begin' || command === 'end') {
        const packages = [...(sources?.packages() ?? []), ...documentPackages(state)]
        const { environments } = cache.commandsAndEnvironments(sources, packages)
        if (command === 'begin') return { from, options: environments, validFor: KEY_CHARS }
        const open = openEnvironment(state, from)
        const options = environments.map((completion) => ({
          label: completion.label,
          type: 'type',
          boost: completion.label === open ? 99 : 0,
          apply: state.sliceDoc(pos, pos + 1) === '}' ? completion.label : `${completion.label}}`,
        }))
        if (open !== null && !options.some((option) => option.label === open)) {
          options.push({ label: open, type: 'type', boost: 99, apply: `${open}}` })
        }
        return { from, options, validFor: KEY_CHARS }
      }
      if (command === 'usepackage' || command === 'RequirePackage') {
        return { from, options: cache.packageNames(sources), validFor: KEY_CHARS }
      }
      if (command === 'documentclass') {
        return {
          from,
          options: DOCUMENT_CLASSES.map((name) => ({ label: name, type: 'class' })),
          validFor: KEY_CHARS,
        }
      }
      const kind = FILE_KINDS[command]
      if (kind) {
        const current = options.currentFile?.() ?? null
        const files = (sources?.files() ?? []).filter(
          (path) => path !== current && kind.extensions.test(path),
        )
        const graphicsPaths =
          command === 'includegraphics' ? (sources?.graphicsPaths?.() ?? []) : []
        return {
          from,
          options: fileCompletions(
            files,
            sources?.rootDirectory?.() ?? '',
            kind.strip,
            graphicsPaths,
          ),
          validFor: /^[^{}\s,]*$/,
        }
      }
      return null
    }

    const word = context.matchBefore(/\\[a-zA-Z@]*\*?/)
    if (!word || (word.from === word.to && !context.explicit)) return null
    // `\\` (saut de ligne) n'ouvre pas de complétion.
    if (word.from > 0 && state.sliceDoc(word.from - 1, word.from) === '\\') return null
    const packages = [...(sources?.packages() ?? []), ...documentPackages(state)]
    const { commands } = cache.commandsAndEnvironments(sources, packages)
    return { from: word.from, options: commands, validFor: /^\\[a-zA-Z@]*\*?$/ }
  }
}

/** Packages chargés par le document édité (et sa classe), sans attendre l'index du projet. */
function documentPackages(state: EditorState): string[] {
  const head = state.sliceDoc(0, Math.min(state.doc.length, 20_000))
  if (!head.includes('\\documentclass')) return []
  const names = loadedPackages(head).flatMap((loaded) => loaded.names)
  const documentClass = /\\documentclass\s*(?:\[[^\]]*\])?\s*\{([^{}]+)\}/.exec(head)?.[1]?.trim()
  if (documentClass) names.push(`class:${documentClass}`)
  return names
}

/** Autocomplétion LaTeX (voir `latexCompletionSource`), activée pendant la frappe. */
export function latexAutocomplete(options: LatexCompletionOptions = {}): Extension {
  return autocompletion({
    override: [latexCompletionSource(options)],
    activateOnTyping: true,
    maxRenderedOptions: 100,
  })
}
