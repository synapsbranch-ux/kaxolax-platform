import { createHash } from 'node:crypto'
import { lstat, readdir } from 'node:fs/promises'
import { join, posix } from 'node:path'
import {
  type ConvertCitations,
  type ConvertDocumentClass,
  type ConvertedMedia,
  type ConvertFailureReason,
  type ConvertImage,
  type ConvertMediaType,
  type ConvertRequest,
  type ConvertResult,
  type ConvertTopLevelDivision,
  isSafeRelativePath,
  MAX_CONVERT_EMBEDDED_BYTES,
  MAX_CONVERT_EMBEDDED_IMAGES,
  MAX_CITATION_KEY_LENGTH,
  MAX_CONVERT_LATEX_BYTES,
  MAX_CONVERT_REPORTED_CITATIONS,
  sensitiveLatexCommands,
} from '@kaxolax/contracts'
import { z } from 'zod'
import { readRegularFile, regularFileSize } from './regular-file.js'
import { type SandboxResult } from './sandbox.js'

/** Répertoire de données de pandoc dans l'image TeX Live (lecture seule, voir kaxolax-texlive-images). */
export const PANDOC_DATA_DIR = '/usr/share/kaxolax/pandoc'
/** Seul filtre jamais passé à pandoc : celui de l'image. */
export const PANDOC_FILTER = `${PANDOC_DATA_DIR}/kaxolax-convert.lua`
/** Tas de pandoc plafonné : une bombe YAML échoue au lieu d'épuiser la mémoire du sandbox. */
export const PANDOC_HEAP_LIMIT = '-M512m'

/** Noms constants du répertoire de conversion (jamais issus de la demande). */
export const CONVERT_FILES = {
  input: 'input.md',
  output: 'output.tex',
  options: 'kaxolax-convert.json',
  report: 'kaxolax-report.json',
  media: 'media',
} as const

/**
 * Lecteurs pandoc : le LaTeX et le HTML bruts du texte (`\input`, blocs `{=latex}`, balises)
 * sont échappés, sauf demande explicite. Ce n'est pas une garantie d'absence de LaTeX actif :
 * pandoc recopie tel quel le contenu des formules (`$…$`, `$$…$$`), y compris dans les
 * métadonnées YAML (`header-includes`, titre). Seul le sandbox de compilation (lecture limitée
 * au projet, shell escape et réseau coupés) borne ce que ce LaTeX peut faire ; l'agent signale
 * les commandes sensibles ainsi recopiées (`sensitiveCommandsWarning`).
 */
const READER_STRICT = 'markdown-raw_tex-raw_attribute-raw_html'
const READER_RAW = 'markdown'

/** Avertissements de pandoc gardés au plus. */
const MAX_WARNINGS = 50
/** Fin de la sortie d'erreur de pandoc renvoyée à l'appelant en cas d'échec. */
const MAX_ERROR_CHARS = 2_000

/** Extensions des images extraites par le filtre et leur type. */
const MEDIA_TYPES: Record<string, ConvertMediaType> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  pdf: 'application/pdf',
}
const MEDIA_NAME = /^[0-9a-f]{40}\.(png|jpg|pdf)$/
/** Extensions qu'essaie `\includegraphics` quand le chemin n'en a pas. */
const GRAPHICS_EXTENSIONS = ['.pdf', '.png', '.jpg', '.jpeg', '.eps']

export interface ResolvedConvertOptions {
  mode: 'document' | 'fragment'
  documentClass: ConvertDocumentClass
  topLevelDivision: ConvertTopLevelDivision
  numberSections: boolean
  citations: ConvertCitations
  rawLatex: boolean
}

/**
 * Options complètes. Un fragment est toujours converti avec `--number-sections` (titres
 * `\section`, jamais `\section*`) ; le réglage `\setcounter{secnumdepth}{…}` que pandoc met dans
 * le préambule est retiré par `splitLatex` : la numérotation suit celle du document hôte.
 */
export function resolveConvertOptions(request: ConvertRequest): ResolvedConvertOptions {
  const options = request.options ?? {}
  const mode = options.mode ?? 'document'
  return {
    mode,
    documentClass: options.documentClass ?? 'article',
    topLevelDivision: options.topLevelDivision ?? 'default',
    numberSections: mode === 'fragment' || (options.numberSections ?? false),
    citations: options.citations ?? 'natbib',
    rawLatex: options.rawLatex ?? false,
  }
}

/**
 * Commande pandoc : constante, à des valeurs de listes fermées près (classe, découpage). Aucun
 * chemin ni texte de la demande n'y entre : le Markdown est lu dans `input.md`, les chemins
 * passent par le fichier d'options du filtre. `--sandbox` interdit aux lecteurs et rédacteurs
 * toute lecture de fichier ou d'URL ; `--data-dir` (image, lecture seule) écarte les modèles,
 * défauts et filtres d'un répertoire personnel ; le seul filtre est celui de l'image (il refuse
 * aussi les clés de citation qui injecteraient du LaTeX). Les citations `[@clé]` deviennent des
 * commandes natbib ou biblatex (`--natbib`, `--biblatex`), jamais du texte : la bibliographie est
 * celle du projet. Même commande que `tests/run_cases.py` de kaxolax-texlive-images.
 */
export function convertCommand(options: ResolvedConvertOptions): string[] {
  return [
    'pandoc',
    '+RTS',
    PANDOC_HEAP_LIMIT,
    '-RTS',
    '--sandbox',
    `--data-dir=${PANDOC_DATA_DIR}`,
    `--lua-filter=${PANDOC_FILTER}`,
    `--from=${options.rawLatex ? READER_RAW : READER_STRICT}`,
    '--to=latex',
    '--standalone',
    '--wrap=preserve',
    `--variable=documentclass:${options.documentClass}`,
    ...(options.topLevelDivision === 'default'
      ? []
      : [`--top-level-division=${options.topLevelDivision}`]),
    ...(options.numberSections ? ['--number-sections'] : []),
    `--${options.citations}`,
    `--output=${CONVERT_FILES.output}`,
    CONVERT_FILES.input,
  ]
}

/** Options du filtre Lua (`kaxolax-convert.json`), chemins du projet compris. */
export interface FilterOptions {
  sourceDir: string
  graphicsDir: string
  mediaDir: string
  maxEmbedded: number
  marker: string
  fragment: boolean
}

function directoryOf(path: string): string {
  const directory = posix.dirname(path)
  return directory === '.' ? '' : directory
}

export function filterOptions(
  request: ConvertRequest,
  options: ResolvedConvertOptions,
  marker: string,
): FilterOptions {
  const targetDir = directoryOf(request.targetPath)
  return {
    sourceDir: directoryOf(request.sourcePath),
    graphicsDir: request.graphicsDir ?? targetDir,
    mediaDir: request.mediaDir ?? (targetDir === '' ? 'media' : `${targetDir}/media`),
    maxEmbedded: MAX_CONVERT_EMBEDDED_IMAGES,
    marker,
    fragment: options.mode === 'fragment',
  }
}

/** Conversion refusée ou échouée : HTTP 422 `convert_failed` côté agent. */
export class ConvertError extends Error {
  constructor(
    readonly reason: ConvertFailureReason,
    message: string,
  ) {
    super(message)
    this.name = 'ConvertError'
  }
}

/** Échec d'après le résultat du sandbox ; null si pandoc s'est terminé normalement. */
export function convertFailure(result: SandboxResult, timeoutMs: number): ConvertError | null {
  if (result.outcome === 'timeout') {
    return new ConvertError(
      'timeout',
      `Conversion timed out after ${String(Math.round(timeoutMs / 1000))} s`,
    )
  }
  if (result.outcome === 'killed') {
    return new ConvertError('output_too_large', 'Conversion output exceeds the size limit')
  }
  if (result.outcome === 'stopped') return new ConvertError('failed', 'Conversion was stopped')
  if (result.oomKilled || result.output.includes('Heap exhausted')) {
    return new ConvertError('out_of_memory', 'Conversion ran out of memory')
  }
  if (result.exitCode !== 0) {
    const tail = result.output.trim().slice(-MAX_ERROR_CHARS)
    return new ConvertError('failed', tail === '' ? 'pandoc failed' : tail)
  }
  return null
}

/** Avertissements `[WARNING]` de pandoc (lignes de suite comprises), dans l'ordre. */
export function parsePandocWarnings(output: string): string[] {
  const warnings: string[] = []
  let current: string[] | null = null
  for (const line of output.split('\n')) {
    if (line.startsWith('[WARNING] ')) {
      if (current) warnings.push(current.join('\n'))
      current = [line.slice('[WARNING] '.length).trimEnd()]
    } else if (current && /^\s/.test(line) && line.trim() !== '') {
      current.push(line.trim())
    } else if (current) {
      warnings.push(current.join('\n'))
      current = null
    }
  }
  if (current) warnings.push(current.join('\n'))
  return warnings.slice(0, MAX_WARNINGS)
}

/**
 * Avertissement si la sortie, sans LaTeX brut demandé, contient des commandes d'accès aux
 * fichiers ou au moteur (hors verbatim) : elles viennent des formules ou des métadonnées.
 */
export function sensitiveCommandsWarning(
  latex: string,
  preamble: string | null,
  options: ResolvedConvertOptions,
): string | null {
  if (options.rawLatex) return null
  const found = sensitiveLatexCommands(`${preamble ?? ''}\n${latex}`)
  if (found.length === 0) return null
  return `Formulas or metadata contain LaTeX commands copied as is: ${found
    .map((name) => `\\${name}`)
    .join(', ')} (file and shell access stay blocked when compiling)`
}

// Liste vide encodée en objet JSON vide par certaines versions de pandoc.
const emptyList = z.strictObject({}).transform((): never[] => [])
const keyList = z
  .array(z.string().max(MAX_CITATION_KEY_LENGTH))
  .max(MAX_CONVERT_REPORTED_CITATIONS)
  .or(emptyList)
  .default([])

/** Rapport écrit par le filtre Lua (lu comme une donnée non fiable). */
const reportSchema = z.object({
  title: z.string().nullable(),
  images: z
    .array(
      z.object({
        source: z.string().max(4_096),
        kind: z.enum(['project', 'embedded', 'remote', 'rejected']),
        path: z.string().optional(),
        reason: z
          .enum(['absolute_path', 'outside_project', 'unsupported_type', 'too_many_embedded'])
          .optional(),
      }),
    )
    .or(emptyList),
  citations: keyList,
  rejectedCitations: keyList,
})
type FilterReport = z.infer<typeof reportSchema>

export function parseReport(text: string): FilterReport {
  try {
    return reportSchema.parse(JSON.parse(text))
  } catch {
    throw new ConvertError('failed', 'Conversion report is invalid')
  }
}

/** Le fichier existe-t-il dans le projet (avec les extensions que tente `\includegraphics`) ? */
function mediaExists(path: string, media: Set<string>): boolean {
  if (media.has(path)) return true
  if (posix.extname(path) !== '') return false
  return GRAPHICS_EXTENSIONS.some((extension) => media.has(`${path}${extension}`))
}

/** Images du rapport, avec la présence des images du projet et les avertissements associés. */
export function describeImages(
  report: FilterReport,
  media: string[] | undefined,
): { images: ConvertImage[]; warnings: string[] } {
  const known = media === undefined ? null : new Set(media)
  const warnings: string[] = []
  const images = report.images.map((image): ConvertImage => {
    const path = image.path !== undefined && isSafeRelativePath(image.path) ? image.path : null
    const found =
      image.kind === 'project' && known !== null ? path !== null && mediaExists(path, known) : null
    if (image.kind === 'project' && found === false) {
      warnings.push(`Image not found in the project: ${path ?? image.source}`)
    } else if (image.kind === 'remote') {
      warnings.push(`Remote image replaced by a link: ${image.source}`)
    } else if (image.kind === 'rejected') {
      warnings.push(`Image ignored (${image.reason ?? 'rejected'}): ${image.source}`)
    }
    return {
      source: image.source,
      kind: image.kind,
      path,
      reason: image.reason ?? null,
      found,
    }
  })
  return { images, warnings }
}

const BEGIN_DOCUMENT = '\\begin{document}'

/** Lignes du modèle de pandoc qui chargent natbib ou biblatex (`--natbib`, `--biblatex`). */
const CITATION_SETUP = [
  /^\\usepackage(?:\[[^\]\n]*\])?\{(?:natbib|biblatex)\}\n/gm,
  /^\\bibliographystyle\{[^}\n]*\}\n/gm,
  /^\\printbibliography(?:\[[^\]\n]*\])?\n/gm,
]

/**
 * Sans citation ni bibliographie dans les métadonnées, retire hors du corps (préambule et fin du
 * document de pandoc) ce que `--natbib`/`--biblatex` ajoutent : un document sans citation reste
 * tel qu'avant (ni natbib inutile, ni bibliographie vide de biblatex). Le corps n'est pas touché.
 */
export function dropUnusedCitationSetup(tex: string, marker: string, cited: boolean): string {
  if (cited || /\\(?:bibliography|addbibresource)\{/.test(tex)) return tex
  const begin = tex.indexOf(`%KAXOLAX-BODY-BEGIN-${marker}\n`)
  const end = tex.indexOf(`%KAXOLAX-BODY-END-${marker}\n`, begin)
  if (begin === -1 || end === -1) return tex
  const clean = (part: string) =>
    CITATION_SETUP.reduce((text, pattern) => text.replace(pattern, ''), part)
  return clean(tex.slice(0, begin)) + tex.slice(begin, end) + clean(tex.slice(end))
}

/**
 * Sépare la sortie de pandoc (toujours un document complet) avec les marqueurs aléatoires posés
 * par le filtre autour du corps. Document : la sortie sans les marqueurs. Fragment : le corps,
 * et le préambule sans `\documentclass`, sans `\author{}`/`\date{}` vides (le filtre a retiré
 * titre, auteurs et date) ni `\setcounter{secnumdepth}` (qui changerait la numérotation de tout
 * le document hôte). Le Markdown ne peut pas imiter un marqueur : il ne connaît pas le jeton.
 */
export function splitLatex(
  tex: string,
  marker: string,
  mode: 'document' | 'fragment',
): { latex: string; preamble: string | null } {
  const begin = `%KAXOLAX-BODY-BEGIN-${marker}\n`
  const end = `%KAXOLAX-BODY-END-${marker}\n`
  const beginAt = tex.indexOf(begin)
  const endAt = tex.indexOf(end, beginAt)
  if (beginAt === -1 || endAt === -1) {
    throw new ConvertError('failed', 'Conversion output is incomplete')
  }
  if (mode === 'document') {
    return {
      latex:
        tex.slice(0, beginAt) +
        tex.slice(beginAt + begin.length, endAt) +
        tex.slice(endAt + end.length),
      preamble: null,
    }
  }
  const body = `${tex.slice(beginAt + begin.length, endAt).trim()}\n`
  const documentAt = tex.lastIndexOf(BEGIN_DOCUMENT, beginAt)
  if (documentAt === -1) throw new ConvertError('failed', 'Conversion output is incomplete')
  const preamble = tex
    .slice(0, documentAt)
    .replace(/\\documentclass(?:\[[^\]]*\])?\{[^}]*\}\n?/, '')
    .replace(/^\\(?:author|date)\{\}\n/gm, '')
    .replace(/^\\setcounter\{secnumdepth\}\{[^}\n]*\}\n/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { latex: body, preamble: preamble === '' ? '' : `${preamble}\n` }
}

/**
 * Images extraites par le filtre (`media/<sha1>.<ext>`), lues sans suivre de lien : le
 * répertoire et chaque fichier doivent être réguliers. Plafonds du nombre et de la taille.
 */
export async function readExtractedMedia(
  directory: string,
  mediaDir: string,
): Promise<ConvertedMedia[]> {
  const root = join(directory, CONVERT_FILES.media)
  const info = await lstat(root).catch(() => null)
  if (info === null) return []
  if (!info.isDirectory()) throw new ConvertError('failed', 'Media directory is invalid')
  const names = (await readdir(root)).filter((name) => MEDIA_NAME.test(name)).sort()
  if (names.length > MAX_CONVERT_EMBEDDED_IMAGES) {
    throw new ConvertError('output_too_large', 'Too many embedded images')
  }
  const media: ConvertedMedia[] = []
  let total = 0
  for (const name of names) {
    const path = join(root, name)
    const size = await regularFileSize(path)
    if (size === null) continue
    total += size
    if (total > MAX_CONVERT_EMBEDDED_BYTES) {
      throw new ConvertError('output_too_large', 'Embedded images exceed the size limit')
    }
    const content = await readRegularFile(path)
    if (content === null) continue
    const extension = name.slice(name.lastIndexOf('.') + 1)
    media.push({
      path: `${mediaDir}/${name}`,
      contentType: MEDIA_TYPES[extension] ?? 'image/png',
      sizeBytes: content.byteLength,
      sha256: createHash('sha256').update(content).digest('hex'),
      contentBase64: content.toString('base64'),
    })
  }
  return media
}

/**
 * Lit les sorties d'une conversion terminée (aucun processus du sandbox ne tourne plus) et
 * construit la réponse. Toutes les lectures se font sans suivre de lien symbolique.
 */
export async function readConversion(
  directory: string,
  request: ConvertRequest,
  options: ResolvedConvertOptions,
  filter: FilterOptions,
  output: string,
): Promise<Omit<ConvertResult, 'durationMs'>> {
  const texPath = join(directory, CONVERT_FILES.output)
  const size = await regularFileSize(texPath)
  if (size === null) throw new ConvertError('failed', 'pandoc produced no output')
  // Le préambule de pandoc s'ajoute au corps : marge de 64 Kio au-delà du plafond.
  if (size > MAX_CONVERT_LATEX_BYTES + 64 * 1024) {
    throw new ConvertError('output_too_large', 'Converted LaTeX exceeds the size limit')
  }
  const tex = (await readRegularFile(texPath))?.toString('utf8') ?? ''
  const reportText = await readRegularFile(join(directory, CONVERT_FILES.report))
  if (reportText === null) throw new ConvertError('failed', 'Conversion report is missing')
  const report = parseReport(reportText.toString('utf8'))
  const { latex, preamble } = splitLatex(
    dropUnusedCitationSetup(tex, filter.marker, report.citations.length > 0),
    filter.marker,
    options.mode,
  )
  if (Buffer.byteLength(latex) > MAX_CONVERT_LATEX_BYTES) {
    throw new ConvertError('output_too_large', 'Converted LaTeX exceeds the size limit')
  }
  const media = await readExtractedMedia(directory, filter.mediaDir)
  const { images, warnings } = describeImages(report, request.media)
  const sensitive = sensitiveCommandsWarning(latex, preamble, options)
  const rejected =
    report.rejectedCitations.length === 0
      ? []
      : [
          `Citations kept as text (unsupported key): ${report.rejectedCitations
            .slice(0, 20)
            .join(', ')}`,
        ]
  return {
    latex,
    preamble,
    title: report.title,
    media,
    images,
    citations: report.citations,
    warnings: [
      ...(sensitive === null ? [] : [sensitive]),
      ...parsePandocWarnings(output),
      ...rejected,
      ...warnings,
    ].slice(0, MAX_WARNINGS),
  }
}
