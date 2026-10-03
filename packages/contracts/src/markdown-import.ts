import { z } from 'zod'
import { sha256Schema } from './common.js'
import {
  convertCitationsSchema,
  convertDocumentClassSchema,
  convertImageSchema,
  convertMediaTypeSchema,
  convertTopLevelDivisionSchema,
  MAX_MARKDOWN_BYTES,
} from './convert.js'
import { MAX_TEXT_DOCUMENT_BYTES } from './files.js'
import { relativePathSchema } from './names.js'

/**
 * Import de Markdown dans un projet (`POST /projects/:id/convert/markdown`, éditeur et
 * propriétaire) : pandoc convertit dans le sandbox de compilation (voir convert.ts), l'API range
 * le `.tex` et les images extraites, et décrit ce que le préambule du document principal doit
 * charger. L'API ne modifie jamais le texte d'un document existant : le fragment à insérer et les
 * ajouts au préambule sont appliqués par le client, dans l'éditeur partagé (Yjs).
 */

/** Markdown soumis au nettoyage par l'IA, au plus (octets UTF-8) : sortie bornée de Claude. */
export const MAX_CLEANUP_MARKDOWN_BYTES = 100_000

/**
 * `file` : nouveau fichier `.tex` créé dans le projet. `insert` : fragment renvoyé pour être
 * inséré dans le document courant (seules les images extraites sont écrites).
 */
export const markdownImportOutputSchema = z.enum(['file', 'insert'])
export type MarkdownImportOutput = z.infer<typeof markdownImportOutputSchema>

/**
 * `main` : fragment, les packages et définitions nécessaires vont dans le préambule du document
 * principal. `embedded` : document LaTeX complet et autonome, préambule compris (nouveau fichier
 * seulement).
 */
export const markdownImportPreambleSchema = z.enum(['main', 'embedded'])
export type MarkdownImportPreamble = z.infer<typeof markdownImportPreambleSchema>

const encoder = new TextEncoder()
const byteLength = (text: string) => encoder.encode(text).byteLength

const texPathSchema = relativePathSchema.refine((path) => /\.tex$/i.test(path), {
  message: 'Target must be a .tex file',
})

/**
 * Corps de la demande. Source : `markdown` (texte collé ou fichier choisi sur l'ordinateur, ses
 * images relatives se rapportent à la racine du projet) ou `documentId` (fichier `.md` du projet,
 * images relatives à son dossier), exactement un des deux. `targetPath` : fichier à créer
 * (`file`, défaut : nom de la source en `.tex`), ou document où le fragment sera inséré
 * (`insert`, ses images extraites vont à côté). `latex` : texte validé dans l'aperçu (nettoyé par
 * l'IA ou retouché), écrit à la place de la sortie de pandoc ; `sourceSha256` (obligatoire avec
 * `latex` et `documentId`) : empreinte du Markdown de l'aperçu (`sourceSha256` de la réponse), le
 * texte validé est refusé (409 `E_SOURCE_CHANGED`) si le Markdown a changé depuis. `citations` :
 * commandes des citations `[@clé]` (défaut : biblatex si le document principal le charge, sinon
 * natbib). `dryRun` : aperçu, rien n'est écrit.
 */
export const markdownImportBodySchema = z
  .strictObject({
    markdown: z.string().optional(),
    documentId: z.uuid().optional(),
    output: markdownImportOutputSchema.optional(),
    preamble: markdownImportPreambleSchema.optional(),
    targetPath: texPathSchema.optional(),
    documentClass: convertDocumentClassSchema.optional(),
    topLevelDivision: convertTopLevelDivisionSchema.optional(),
    numberSections: z.boolean().optional(),
    citations: convertCitationsSchema.optional(),
    rawLatex: z.boolean().optional(),
    cleanup: z.boolean().optional(),
    latex: z.string().optional(),
    sourceSha256: sha256Schema.optional(),
    dryRun: z.boolean().optional(),
  })
  .superRefine((body, ctx) => {
    if ((body.markdown === undefined) === (body.documentId === undefined)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Give either markdown or documentId',
        path: ['markdown'],
      })
    }
    if (body.markdown !== undefined && byteLength(body.markdown) > MAX_MARKDOWN_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'Markdown is too large', path: ['markdown'] })
    }
    if (body.output === 'insert' && body.preamble === 'embedded') {
      ctx.addIssue({
        code: 'custom',
        message: 'An inserted fragment uses the preamble of the main document',
        path: ['preamble'],
      })
    }
    if (body.latex !== undefined && body.cleanup === true) {
      ctx.addIssue({
        code: 'custom',
        message: 'Validated LaTeX is not cleaned again',
        path: ['cleanup'],
      })
    }
    if (body.latex !== undefined && body.documentId !== undefined && !body.sourceSha256) {
      ctx.addIssue({
        code: 'custom',
        message: 'Validated LaTeX of a project file needs the fingerprint of its Markdown',
        path: ['sourceSha256'],
      })
    }
    if (body.latex !== undefined && byteLength(body.latex) >= MAX_TEXT_DOCUMENT_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'LaTeX is too large', path: ['latex'] })
    }
  })
export type MarkdownImportBody = z.infer<typeof markdownImportBodySchema>

/** Package à charger : nom et options (`\usepackage[options]{name}`). */
export const requiredPackageSchema = z.object({
  name: z.string().min(1),
  options: z.array(z.string()),
})
export type RequiredLatexPackage = z.infer<typeof requiredPackageSchema>

/**
 * Définition à placer dans le préambule (macro, environnement ou compteur que pandoc utilise),
 * écrite pour ne rien redéfinir : `\providecommand`, `\@ifundefined`. `name` : nom défini, qui
 * sert à repérer une définition déjà présente.
 */
export const preambleDefinitionSchema = z.object({
  name: z.string().min(1),
  code: z.string().min(1),
})
export type PreambleDefinition = z.infer<typeof preambleDefinitionSchema>

/**
 * Préambule adapté. `main` : `packages` et `definitions` nécessaires au fragment ; `missing*` :
 * ceux que le document principal (`mainDocumentId`, lu au moment de la demande) ne charge pas
 * encore, à ajouter sans doublon. `embedded` : tout est dans le fichier produit (listes vides).
 */
export const markdownImportPreambleResultSchema = z.object({
  mode: markdownImportPreambleSchema,
  mainDocumentId: z.uuid().nullable(),
  mainDocumentPath: z.string().nullable(),
  packages: z.array(requiredPackageSchema),
  definitions: z.array(preambleDefinitionSchema),
  missingPackages: z.array(requiredPackageSchema),
  missingDefinitions: z.array(preambleDefinitionSchema),
})
export type MarkdownImportPreambleResult = z.infer<typeof markdownImportPreambleResultSchema>

/** Image extraite (`data:`) rangée dans le projet ; `created` : faux si elle y était déjà. */
export const importedMediaSchema = z.object({
  id: z.uuid().nullable(),
  path: relativePathSchema,
  contentType: convertMediaTypeSchema,
  sizeBytes: z.number().int().nonnegative(),
  created: z.boolean(),
})
export type ImportedMedia = z.infer<typeof importedMediaSchema>

/**
 * Nettoyage par l'IA : `applied` faux si la sortie de Claude a été écartée (`warning` dit
 * pourquoi : texte coupé, structure non conforme) ; `pandocLatex` garde alors la sortie de pandoc.
 */
export const markdownCleanupResultSchema = z.object({
  applied: z.boolean(),
  warning: z.string().nullable(),
  /** Coût de l'appel, en crédits IA (centièmes). */
  credits: z.number().nonnegative(),
})
export type MarkdownCleanupResult = z.infer<typeof markdownCleanupResultSchema>

/**
 * Réponse. `latex` : texte écrit (ou à insérer) ; `pandocLatex` : sortie de pandoc avant le
 * nettoyage par l'IA (null sans nettoyage appliqué). `sourceSha256` : empreinte (SHA-256, UTF-8)
 * du Markdown converti, à renvoyer avec le texte validé. `citations` : clés citées. `document` : fichier créé (`file` hors
 * aperçu). `media` : images extraites (rien d'écrit en aperçu, `id` null).
 */
export const markdownImportResponseSchema = z.object({
  dryRun: z.boolean(),
  output: markdownImportOutputSchema,
  targetPath: z.string(),
  latex: z.string(),
  pandocLatex: z.string().nullable(),
  sourceSha256: sha256Schema,
  citations: z.array(z.string()),
  title: z.string().nullable(),
  document: z
    .object({ id: z.uuid(), folderId: z.uuid().nullable(), name: z.string(), path: z.string() })
    .nullable(),
  media: z.array(importedMediaSchema),
  images: z.array(convertImageSchema),
  warnings: z.array(z.string()),
  preamble: markdownImportPreambleResultSchema,
  cleanup: markdownCleanupResultSchema.nullable(),
  durationMs: z.number().int().nonnegative(),
})
export type MarkdownImportResponse = z.infer<typeof markdownImportResponseSchema>

// --- Préambule nécessaire à un fragment de pandoc -------------------------------------------

/** Texte sans commentaires `%` (un `\%` échappé est gardé), positions conservées. */
export function stripLatexComments(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      for (let index = 0; index < line.length; index++) {
        if (line[index] === '\\') {
          index++
          continue
        }
        if (line[index] === '%') return line.slice(0, index) + ' '.repeat(line.length - index)
      }
      return line
    })
    .join('\n')
}

/** Environnements recopiés tels quels par TeX (blocs de code de pandoc sans langue). */
const VERBATIM_BEGIN = /\\begin\s*\{(verbatim\*?|Verbatim\*?)\}/y
/** Réglages de fancyvrb qui peuvent donner `commandchars` à tous les `Verbatim`. */
const FANCYVRB_SETUP =
  /\\(?:fvset|RecustomVerbatimEnvironment|RecustomVerbatimCommand)(?![A-Za-z@])/
const VERB = /\\(?:verb|Verb)\*?([^A-Za-z*\s])/y

/**
 * Code LaTeX analysable : commentaires retirés et contenu des environnements verbatim et des
 * `\verb` vidé (TeX ne l'interprète pas : un `\documentclass` ou un `\begin` documenté dans un
 * bloc de code n'est pas de la structure). Lecture dans l'ordre de TeX : un `%` dans un verbatim
 * ne masque pas son `\end`, un `\begin{verbatim}` commenté n'ouvre rien. Un `Verbatim` avec
 * `commandchars` (le `Highlighting` de pandoc) exécute des commandes : il reste analysé, comme
 * tous les `Verbatim` dès que le texte contient un réglage global de fancyvrb (`\fvset`…).
 */
export function latexCode(text: string): string {
  const fancyvrbSetup = FANCYVRB_SETUP.test(text)
  let code = ''
  let index = 0
  while (index < text.length) {
    const char = text.charAt(index)
    if (char === '%') {
      const end = text.indexOf('\n', index)
      if (end === -1) break
      index = end
      continue
    }
    if (char !== '\\') {
      code += char
      index++
      continue
    }
    VERBATIM_BEGIN.lastIndex = index
    const begin = VERBATIM_BEGIN.exec(text)
    if (begin !== null) {
      const name = begin[1] ?? 'verbatim'
      const after = index + begin[0].length
      const options = /^\[[^\]]*\]/.exec(text.slice(after))?.[0] ?? ''
      const close = `\\end{${name}}`
      const end = text.indexOf(close, after)
      const active =
        options.includes('commandchars') || (fancyvrbSetup && name.startsWith('Verbatim'))
      if (!active && end !== -1) {
        code += `\\begin{${name}}${close}`
        index = end + close.length
        continue
      }
    }
    VERB.lastIndex = index
    const verb = VERB.exec(text)
    if (verb !== null) {
      const delimiter = verb[1] === '{' ? '}' : (verb[1] ?? '')
      const after = index + verb[0].length
      const end = text.indexOf(delimiter, after)
      const line = text.indexOf('\n', after)
      if (end !== -1 && (line === -1 || end < line)) {
        code += '\\verb||'
        index = end + 1
        continue
      }
    }
    code += text.slice(index, index + 2)
    index += 2
  }
  return code
}

/**
 * Commandes d'accès aux fichiers ou au moteur : refusées si le nettoyage par l'IA en ajoute,
 * signalées par l'agent quand des formules ou des métadonnées les recopient sans LaTeX brut.
 */
export const LATEX_SENSITIVE_COMMANDS: readonly string[] = [
  'input',
  'include',
  'InputIfFileExists',
  'openin',
  'openout',
  'read',
  'write',
  'write18',
  'immediate',
  'directlua',
  'luaexec',
  'catcode',
  'ShellEscape',
]

/** Commandes sensibles présentes dans le code LaTeX (hors commentaires et verbatim), triées. */
export function sensitiveLatexCommands(text: string): string[] {
  const code = latexCode(text)
  return LATEX_SENSITIVE_COMMANDS.filter((name) =>
    new RegExp(`\\\\${name}(?![A-Za-z@])`).test(code),
  )
}

const has = (code: string, pattern: RegExp) => pattern.test(code)

/** Définitions de pandoc reprises telles quelles (sans `\newcommand` qui échouerait en double). */
const FIXED_DEFINITIONS: Readonly<Record<string, string>> = {
  tightlist:
    '\\providecommand{\\tightlist}{%\n  \\setlength{\\itemsep}{0pt}\\setlength{\\parskip}{0pt}}',
  pandocbounded: [
    '\\makeatletter',
    '\\@ifundefined{pandoc@box}{\\newsavebox\\pandoc@box}{}',
    '\\providecommand*\\pandocbounded[1]{% image à la taille du texte au plus',
    '  \\sbox\\pandoc@box{#1}%',
    '  \\Gscale@div\\@tempa{\\textheight}{\\dimexpr\\ht\\pandoc@box+\\dp\\pandoc@box\\relax}%',
    '  \\Gscale@div\\@tempb{\\linewidth}{\\wd\\pandoc@box}%',
    '  \\ifdim\\@tempb\\p@<\\@tempa\\p@\\let\\@tempa\\@tempb\\fi',
    '  \\ifdim\\@tempa\\p@<\\p@\\scalebox{\\@tempa}{\\usebox\\pandoc@box}%',
    '  \\else\\usebox{\\pandoc@box}%',
    '  \\fi%',
    '}',
    '\\makeatother',
  ].join('\n'),
  none: '\\makeatletter\\@ifundefined{c@none}{\\newcounter{none}}{}\\makeatother',
  Shaded: '\\makeatletter\\@ifundefined{Shaded}{\\newenvironment{Shaded}{}{}}{}\\makeatother',
  Highlighting:
    '\\makeatletter\\@ifundefined{Highlighting}{\\DefineVerbatimEnvironment{Highlighting}{Verbatim}{commandchars=\\\\\\{\\}}}{}\\makeatother',
  VerbBar: '\\providecommand{\\VerbBar}{|}',
  VERB: '\\providecommand{\\VERB}{\\Verb[commandchars=\\\\\\{\\}]}',
}

/** Définition d'une macro de coloration (`\KeywordTok`) : celle du préambule de pandoc, sinon neutre. */
function tokenDefinition(name: string, pandocPreamble: string | null): string {
  const line = pandocPreamble
    ?.split('\n')
    .find((candidate) => candidate.startsWith(`\\newcommand{\\${name}}[1]{`))
  return line === undefined
    ? `\\providecommand{\\${name}}[1]{#1}`
    : `\\providecommand${line.slice('\\newcommand'.length)}`
}

/**
 * Packages et définitions dont un fragment produit par pandoc a besoin, déduits de ce qu'il
 * utilise (et non du préambule complet de pandoc : polices, encodage et mise en page restent
 * ceux du document hôte). Ordre de chargement stable, hyperref en dernier.
 */
export function pandocRequirements(
  body: string,
  pandocPreamble: string | null = null,
): { packages: RequiredLatexPackage[]; definitions: PreambleDefinition[] } {
  // Le contenu d'un verbatim (code documenté) n'utilise aucun package.
  const code = latexCode(body)
  const packages: RequiredLatexPackage[] = []
  const add = (name: string, options: string[] = []) => {
    if (!packages.some((entry) => entry.name === name)) packages.push({ name, options })
  }
  const math = has(
    code,
    /\\\(|\\\[|(?<!\\)\$|\\begin\{(?:equation|align|gather|multline|split|aligned|cases|[pbvBV]?matrix)\*?\}/,
  )
  if (math) {
    add('amsmath')
    add('amssymb')
  }
  const graphics = has(code, /\\includegraphics(?![a-zA-Z@])|\\pandocbounded(?![a-zA-Z@])/)
  if (graphics) add('graphicx')
  const longtable = has(code, /\\begin\{longtable\}/)
  if (longtable) add('longtable')
  if (has(code, /\\(?:toprule|midrule|bottomrule|cmidrule)(?![a-zA-Z@])/)) add('booktabs')
  if (has(code, /\\arraybackslash(?![a-zA-Z@])|[>@]\{|\\begin\{longtable\}\[\]\{@/)) add('array')
  if (has(code, /\\real\{/)) add('calc')
  const highlighting = has(code, /\\begin\{(?:Shaded|Highlighting)\}|\\[A-Za-z]+Tok\{|\\VERB\|/)
  if (highlighting || has(code, /\\(?:textcolor|colorbox|color)(?![a-zA-Z@])/)) add('xcolor')
  if (highlighting || has(code, /\\Verb(?![a-zA-Z@])/)) add('fancyvrb')
  if (has(code, /\\(?:st|ul|hl)\{/)) add('soul')
  // Citations de pandoc : `--natbib` ou `--biblatex`. Le `\cite` du noyau n'exige rien (et natbib
  // serait incompatible avec un document qui charge biblatex) ; `\citeauthor`, commun aux deux,
  // ne permet pas de choisir.
  if (has(code, /\\(?:[Cc]ite(?:p|t|alp|alt)|citeyearpar|citetext)\*?(?![a-zA-Z@])/)) {
    add('natbib')
  }
  if (
    has(
      code,
      /\\(?:[Aa]utocites?|[Tt]extcites?|[Pp]arencites?|[Ff]ootcites?|[Ss]martcites?|supercites?)\*?(?![a-zA-Z@])/,
    )
  ) {
    add('biblatex')
  }
  if (
    has(
      code,
      /\\(?:href|url|hyperref|hypertarget|hyperlink|texorpdfstring|autoref|nameref|hypersetup)(?![a-zA-Z@])/,
    )
  ) {
    add('hyperref')
  }

  const definitions: PreambleDefinition[] = []
  const define = (name: string, definition?: string) => {
    if (definitions.some((entry) => entry.name === name)) return
    const fixed = definition ?? FIXED_DEFINITIONS[name]
    if (fixed !== undefined) definitions.push({ name, code: fixed })
  }
  if (has(code, /\\tightlist(?![a-zA-Z@])/)) define('tightlist')
  if (has(code, /\\pandocbounded(?![a-zA-Z@])/)) define('pandocbounded')
  if (has(code, /\\def\\LTcaptype\{none\}/)) define('none')
  if (has(code, /\\begin\{Shaded\}/)) define('Shaded')
  if (has(code, /\\begin\{Highlighting\}/)) define('Highlighting')
  if (has(code, /\\VerbBar(?![a-zA-Z@])/)) define('VerbBar')
  if (has(code, /\\VERB(?![a-zA-Z@])/)) define('VERB')
  const tokens = new Set([...code.matchAll(/\\([A-Z][A-Za-z]*Tok)\{/g)].map((match) => match[1]))
  for (const name of [...tokens].sort()) {
    if (name !== undefined) define(name, tokenDefinition(name, pandocPreamble))
  }
  return { packages, definitions }
}

/** Packages chargés par d'autres : `mathtools` charge amsmath, TikZ charge graphicx et xcolor… */
const IMPLIED_PACKAGES: Readonly<Record<string, readonly string[]>> = {
  mathtools: ['amsmath'],
  amsart: ['amsmath'],
  amsbook: ['amsmath'],
  amsproc: ['amsmath'],
  tikz: ['graphicx', 'xcolor'],
  pgf: ['graphicx', 'xcolor'],
  pgfplots: ['graphicx', 'xcolor'],
  tabularx: ['array'],
  tabulary: ['array'],
  bookmark: ['hyperref'],
  beamer: ['hyperref', 'xcolor', 'graphicx', 'amsmath', 'amssymb'],
  'lua-ul': ['soul'],
}

/** Préambule (avant `\begin{document}`), sans commentaires ; null sans `\documentclass`. */
export function preambleCode(text: string): string | null {
  const code = stripLatexComments(text)
  const begin = /\\begin\s*\{document\}/.exec(code)
  const preamble = begin === null ? code : code.slice(0, begin.index)
  return /\\documentclass(?![a-zA-Z@])/.test(preamble) ? preamble : null
}

/**
 * Packages chargés par le préambule d'un document (`\usepackage`, `\RequirePackage`, classe),
 * avec ceux qu'ils chargent eux-mêmes ; null si le document n'a pas de préambule.
 */
export function loadedPackageNames(text: string): Set<string> | null {
  const code = preambleCode(text)
  if (code === null) return null
  const names = new Set<string>()
  const pattern = /\\(?:usepackage|RequirePackage|documentclass)\s*(?:\[[^\]]*\]\s*)?\{([^}]*)\}/g
  for (const match of code.matchAll(pattern)) {
    for (const raw of (match[1] ?? '').split(',')) {
      const name = raw.trim()
      if (name === '') continue
      names.add(name)
      for (const implied of IMPLIED_PACKAGES[name] ?? []) names.add(implied)
    }
  }
  return names
}

/** La définition (macro, environnement, compteur `name`) est déjà dans le préambule. */
export function definesName(preamble: string, name: string): boolean {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`\\\\${escaped}(?![A-Za-z@])|\\{${escaped}\\}`).test(preamble)
}

/**
 * Ce qui manque au document principal : packages absents (ni chargés ni impliqués) et
 * définitions absentes, dans l'ordre demandé. Sans préambule (pas de `\documentclass`) : tout.
 */
export function missingRequirements(
  mainText: string | null,
  required: { packages: RequiredLatexPackage[]; definitions: PreambleDefinition[] },
): { packages: RequiredLatexPackage[]; definitions: PreambleDefinition[] } {
  const loaded = mainText === null ? null : loadedPackageNames(mainText)
  const preamble = mainText === null ? null : preambleCode(mainText)
  return {
    packages: required.packages.filter((entry) => !(loaded?.has(entry.name) ?? false)),
    definitions: required.definitions.filter(
      (entry) => preamble === null || !definesName(preamble, entry.name),
    ),
  }
}
