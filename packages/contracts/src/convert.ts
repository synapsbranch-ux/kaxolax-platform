import { z } from 'zod'
import { sha256Schema } from './common.js'
import { relativePathSchema } from './names.js'

/**
 * Conversion Markdown → LaTeX : pandoc dans le sandbox de compilation (jamais dans l'API).
 * Demande API → gateway (ou Worker) → agent, `POST /projects/:projectId/convert`, réponse
 * synchrone. Rien n'est écrit dans le projet : l'API range le `.tex` et les images extraites.
 */

/** Délai par défaut de pandoc dans le sandbox (un document de plusieurs centaines de pages : < 2 s). */
export const DEFAULT_CONVERT_TIMEOUT_MS = 30_000
export const MIN_CONVERT_TIMEOUT_MS = 1_000
export const MAX_CONVERT_TIMEOUT_MS = 60_000
/** Taille maximale du Markdown (octets UTF-8), images `data:` comprises. */
export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024
/** Médias du projet listés dans la demande (chemins seulement). */
export const MAX_CONVERT_MEDIA_PATHS = 5_000
/** Taille maximale du LaTeX produit (octets UTF-8). */
export const MAX_CONVERT_LATEX_BYTES = 8 * 1024 * 1024
/** Images `data:` extraites au plus, et leur taille cumulée maximale. */
export const MAX_CONVERT_EMBEDDED_IMAGES = 50
export const MAX_CONVERT_EMBEDDED_BYTES = 4 * 1024 * 1024
/** Images décrites au plus dans la réponse (au-delà, le filtre ne les rapporte plus). */
export const MAX_CONVERT_REPORTED_IMAGES = 500
/** Clés de citation rapportées au plus (gardées, et refusées), et leur longueur maximale. */
export const MAX_CONVERT_REPORTED_CITATIONS = 500
export const MAX_CITATION_KEY_LENGTH = 200

/** Classes proposées pour un document complet (constantes de la commande pandoc). */
export const convertDocumentClassSchema = z.enum([
  'article',
  'report',
  'book',
  'scrartcl',
  'scrreprt',
  'scrbook',
  'memoir',
  'amsart',
])
export type ConvertDocumentClass = z.infer<typeof convertDocumentClassSchema>

/**
 * `document` : document LaTeX complet. `fragment` : corps seul, à inclure dans un document
 * existant, avec le préambule que pandoc produit pour ce contenu (`preamble` de la réponse).
 */
export const convertModeSchema = z.enum(['document', 'fragment'])
export type ConvertMode = z.infer<typeof convertModeSchema>

/** Niveau LaTeX des titres `#` : `default` laisse pandoc choisir selon la classe. */
export const convertTopLevelDivisionSchema = z.enum(['default', 'section', 'chapter', 'part'])
export type ConvertTopLevelDivision = z.infer<typeof convertTopLevelDivisionSchema>

/**
 * Rédaction des citations `[@clé]` : commandes de natbib (`\citep`, `\citet`) ou de biblatex
 * (`\autocite`, `\textcite`). Jamais citeproc : la bibliographie reste celle du projet (`.bib`).
 */
export const convertCitationsSchema = z.enum(['natbib', 'biblatex'])
export type ConvertCitations = z.infer<typeof convertCitationsSchema>

/**
 * Options de la conversion ; absentes : document `article`, découpage par défaut, titres non
 * numérotés (fragment : numérotation du document hôte, `numberSections` ignoré), citations natbib,
 * LaTeX brut du texte échappé. `rawLatex` recopie le LaTeX brut du Markdown (`\newpage`, blocs `{=latex}`)
 * au lieu de l'échapper. Dans tous les cas, le contenu des formules (`$…$`, `$$…$$`, y compris
 * dans les métadonnées YAML) est recopié tel quel : le LaTeX produit n'est jamais sûr par
 * construction. Il n'est jamais exécuté pendant la conversion, et sa compilation reste protégée
 * par le sandbox (seule barrière) ; l'agent signale les commandes sensibles recopiées.
 */
export const convertOptionsSchema = z.strictObject({
  mode: convertModeSchema.optional(),
  documentClass: convertDocumentClassSchema.optional(),
  topLevelDivision: convertTopLevelDivisionSchema.optional(),
  numberSections: z.boolean().optional(),
  citations: convertCitationsSchema.optional(),
  rawLatex: z.boolean().optional(),
})
export type ConvertOptions = z.infer<typeof convertOptionsSchema>

/** Répertoire du projet : '' pour la racine, sinon un chemin relatif sûr. */
export const projectDirectorySchema = z.union([z.literal(''), relativePathSchema])

const encoder = new TextEncoder()

/**
 * Demande de conversion. `sourcePath` : fichier Markdown dans le projet (les images relatives s'y
 * rapportent). `targetPath` : `.tex` à créer. `graphicsDir` : répertoire depuis lequel LaTeX
 * résout les images, celui du document principal (défaut : celui de `targetPath`). `mediaDir` :
 * répertoire où ranger les images `data:` extraites (défaut : `media` à côté de `targetPath`).
 * `media` : chemins des fichiers du projet, pour signaler les images introuvables ; leur contenu
 * ne voyage pas (pandoc ne lit aucune image).
 */
export const convertRequestSchema = z
  .object({
    projectId: z.uuid(),
    sourcePath: relativePathSchema,
    targetPath: relativePathSchema.refine((path) => /\.tex$/i.test(path), {
      message: 'Target must be a .tex file',
    }),
    graphicsDir: projectDirectorySchema.optional(),
    mediaDir: relativePathSchema.optional(),
    markdown: z.string(),
    media: z.array(relativePathSchema).max(MAX_CONVERT_MEDIA_PATHS).optional(),
    options: convertOptionsSchema.optional(),
    timeoutMs: z.number().int().min(MIN_CONVERT_TIMEOUT_MS).max(MAX_CONVERT_TIMEOUT_MS).optional(),
  })
  .superRefine((request, ctx) => {
    if (encoder.encode(request.markdown).byteLength > MAX_MARKDOWN_BYTES) {
      ctx.addIssue({ code: 'custom', message: 'Markdown is too large', path: ['markdown'] })
    }
  })
export type ConvertRequest = z.infer<typeof convertRequestSchema>

export const convertMediaTypeSchema = z.enum(['image/png', 'image/jpeg', 'application/pdf'])
export type ConvertMediaType = z.infer<typeof convertMediaTypeSchema>

/** Image `data:` extraite : chemin dans le projet (sous `mediaDir`) et contenu en base64. */
export const convertedMediaSchema = z.object({
  path: relativePathSchema,
  contentType: convertMediaTypeSchema,
  sizeBytes: z.number().int().nonnegative(),
  sha256: sha256Schema,
  contentBase64: z.string(),
})
export type ConvertedMedia = z.infer<typeof convertedMediaSchema>

/**
 * Traitement d'une image du Markdown. `project` : fichier du projet (`path`), `found` dit s'il
 * figure dans `media`. `embedded` : image `data:` extraite vers `path`. `remote` : URL, changée
 * en lien (rien n'est téléchargé). `rejected` : remplacée par son texte alternatif (`reason`).
 */
export const convertImageSchema = z.object({
  source: z.string(),
  kind: z.enum(['project', 'embedded', 'remote', 'rejected']),
  path: relativePathSchema.nullable(),
  reason: z
    .enum(['absolute_path', 'outside_project', 'unsupported_type', 'too_many_embedded'])
    .nullable(),
  found: z.boolean().nullable(),
})
export type ConvertImage = z.infer<typeof convertImageSchema>

/** Résultat d'une conversion réussie (agent → gateway → API). */
export const convertResultSchema = z.object({
  /** Document complet, ou corps seul pour un fragment. */
  latex: z.string(),
  /** Fragment : préambule produit par pandoc (paquets et macros utilisés) ; null sinon. */
  preamble: z.string().nullable(),
  /** Titre des métadonnées YAML du Markdown. */
  title: z.string().nullable(),
  media: z.array(convertedMediaSchema),
  images: z.array(convertImageSchema),
  /**
   * Clés des citations `[@clé]` rendues en commandes `\cite…`, sans doublon, dans l'ordre. Une
   * clé hors de l'alphabet sûr (lettres, chiffres, `_:.-+/`) n'est jamais recopiée : sa citation
   * reste du texte, avec un avertissement. Absente d'un agent plus ancien : liste vide.
   */
  citations: z.array(z.string().max(MAX_CITATION_KEY_LENGTH)).default([]),
  /** Avertissements de pandoc, images introuvables et citations refusées. */
  warnings: z.array(z.string()),
  durationMs: z.number().int().nonnegative(),
})
export type ConvertResult = z.infer<typeof convertResultSchema>

/**
 * Échec de la conversion (agent : HTTP 422 `convert_failed`). `timeout` : délai dépassé ;
 * `out_of_memory` : tas de pandoc plafonné atteint ; `output_too_large` : LaTeX ou images au-delà
 * des plafonds ; `failed` : pandoc a échoué (`message` : sa sortie d'erreur, tronquée).
 */
export const convertFailureReasonSchema = z.enum([
  'timeout',
  'out_of_memory',
  'output_too_large',
  'failed',
])
export type ConvertFailureReason = z.infer<typeof convertFailureReasonSchema>

export const convertFailureSchema = z.object({
  error: z.literal('convert_failed'),
  reason: convertFailureReasonSchema,
  message: z.string(),
})
export type ConvertFailure = z.infer<typeof convertFailureSchema>
