import { z } from 'zod'
import { compilerSchema, sha256Schema } from './common.js'
import { isSafeRelativePath } from './names.js'

/**
 * Galerie de templates. Le dépôt kaxolax-templates publie dans R2 un catalogue `templates.json`
 * (contrat v1, décrit dans son README) : métadonnées de chaque template et chemins relatifs de son
 * PDF, de sa miniature PNG et de son zip, avec taille et sha256. L'API le lit et le valide avec
 * `templateCatalogSchema`, puis sert aux navigateurs des fiches avec URL absolues
 * (`templateSummarySchema`).
 */

export const TEMPLATE_CATALOG_VERSION = 1

/** Catégories de la galerie, dans l'ordre d'affichage. */
export const TEMPLATE_CATEGORIES = [
  'cv',
  'these',
  'article',
  'presentation',
  'lettre',
  'rapport',
] as const
export const templateCategorySchema = z.enum(TEMPLATE_CATEGORIES)
export type TemplateCategory = z.infer<typeof templateCategorySchema>

/** Licences acceptées par le dépôt (redistribution et modification autorisées). */
export const TEMPLATE_LICENSES = [
  'CC0-1.0',
  'CC-BY-4.0',
  'CC-BY-SA-4.0',
  'MIT',
  'LPPL-1.3c',
] as const
export const templateLicenseSchema = z.enum(TEMPLATE_LICENSES)

export const TEMPLATE_LANGUAGES = ['fr', 'en'] as const
export const templateLanguageSchema = z.enum(TEMPLATE_LANGUAGES)
export type TemplateLanguage = z.infer<typeof templateLanguageSchema>

const KEBAB_CASE = /^[a-z0-9]+(-[a-z0-9]+)*$/

/** Identifiant stable d'un template (nom de son dossier dans le dépôt). */
export const templateIdSchema = z.string().min(2).max(64).regex(KEBAB_CASE)

/** Document principal : chemin relatif terminé par `.tex` (règle de metadata.schema.json). */
const MAIN_DOCUMENT = /^([A-Za-z0-9_][A-Za-z0-9_-]*\/)*[A-Za-z0-9_][A-Za-z0-9_.-]*\.tex$/

/** Métadonnées d'un template (metadata.json, sans `$schema`, `mainDocument` toujours présent). */
export const templateMetadataSchema = z.object({
  id: templateIdSchema,
  title: z.string().min(3).max(80),
  category: templateCategorySchema,
  description: z.string().min(20).max(300),
  compiler: compilerSchema,
  license: templateLicenseSchema,
  mainDocument: z.string().max(255).regex(MAIN_DOCUMENT),
  tags: z
    .array(z.string().min(2).max(32).regex(KEBAB_CASE))
    .min(1)
    .max(10)
    .refine((tags) => new Set(tags).size === tags.length, { message: 'Duplicate tag' }),
  language: templateLanguageSchema,
})
export type TemplateMetadata = z.infer<typeof templateMetadataSchema>

/** Chemin d'un fichier publié, relatif à `templates.json` (jamais absolu, jamais `..`). */
/**
 * Chemin relatif d'un fichier publié (`<id>/<id>.zip`) : segments alphanumériques, `_`, `.`, `-`,
 * sans `:`, `%`, `?` ni `#`, pour qu'il ne puisse jamais se résoudre hors de la base publique
 * (`http:hôte`, `javascript:…`).
 */
const CATALOG_PATH = /^[A-Za-z0-9_][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_][A-Za-z0-9_.-]*)*$/

const catalogPathSchema = z
  .string()
  .max(512)
  .regex(CATALOG_PATH, { message: 'Unsafe relative path' })
  .refine(isSafeRelativePath, { message: 'Unsafe relative path' })

export const catalogFileSchema = z.object({
  path: catalogPathSchema,
  bytes: z.number().int().positive(),
  sha256: sha256Schema,
})
export type CatalogFile = z.infer<typeof catalogFileSchema>

export const catalogTemplateSchema = templateMetadataSchema.extend({
  files: z.object({
    pdf: catalogFileSchema,
    thumbnail: catalogFileSchema.extend({
      width: z.number().int().positive().max(10_000),
      height: z.number().int().positive().max(10_000),
    }),
    zip: catalogFileSchema,
  }),
})
export type CatalogTemplate = z.infer<typeof catalogTemplateSchema>

/**
 * `templates.json`, contrat v1. Les valeurs connues sont validées strictement (un template
 * invalide fait refuser tout le catalogue) ; les champs inconnus sont ignorés, comme le prévoit
 * le contrat (un champ ajouté ne change pas la version).
 */
export const templateCatalogSchema = z
  .object({
    version: z.literal(TEMPLATE_CATALOG_VERSION),
    generatedAt: z.iso.datetime({ offset: true }),
    source: z.object({
      commit: z
        .string()
        .regex(/^[0-9a-f]{40}$/)
        .nullable(),
      texliveImage: z.string().min(1).max(255).nullable(),
    }),
    templates: z.array(catalogTemplateSchema).max(1000),
  })
  .superRefine((catalog, ctx) => {
    const seen = new Set<string>()
    for (const [index, template] of catalog.templates.entries()) {
      if (seen.has(template.id)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate template id: ${template.id}`,
          path: ['templates', index, 'id'],
        })
      }
      seen.add(template.id)
    }
  })
export type TemplateCatalog = z.infer<typeof templateCatalogSchema>

// --- API → navigateur ---------------------------------------------------------------------------

/**
 * Template tel que l'API le sert : métadonnées et URL publiques (domaine public R2) de la
 * miniature et du PDF, suffixées de `?v=<sha256 court>` pour contourner le cache après une
 * nouvelle publication. URL nulles quand les fichiers ne sont pas publiés (catalogue de
 * démonstration du développement local, sans `TEMPLATES_PUBLIC_URL`).
 */
export const templateSummarySchema = templateMetadataSchema.extend({
  thumbnail: z.object({
    url: z.url().nullable(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
  pdf: z.object({ url: z.url().nullable(), bytes: z.number().int().positive() }),
  zipBytes: z.number().int().positive(),
})
export type TemplateSummary = z.infer<typeof templateSummarySchema>

/** `GET /api/v1/templates` : recherche plein texte et filtres, tous facultatifs. */
export const templateListQuerySchema = z.object({
  q: z.string().trim().max(100).optional(),
  category: templateCategorySchema.optional(),
  language: templateLanguageSchema.optional(),
  compiler: compilerSchema.optional(),
})
export type TemplateListQuery = z.infer<typeof templateListQuerySchema>

/**
 * Réponse de `GET /api/v1/templates`. `categories` : toutes les catégories, dans l'ordre de la
 * galerie, avec le nombre de templates qui répondent aux autres critères (sans le filtre de
 * catégorie), pour afficher les compteurs des onglets.
 */
export const templateListResponseSchema = z.object({
  templates: z.array(templateSummarySchema),
  categories: z.array(
    z.object({ id: templateCategorySchema, count: z.number().int().nonnegative() }),
  ),
  generatedAt: z.iso.datetime({ offset: true }),
})
export type TemplateListResponse = z.infer<typeof templateListResponseSchema>

export const templateResponseSchema = z.object({ template: templateSummarySchema })
export type TemplateResponse = z.infer<typeof templateResponseSchema>

/**
 * `POST /api/v1/projects/from-template`. Sans `name` : titre du template ; sans `workspaceId` :
 * workspace personnel.
 */
export const createProjectFromTemplateSchema = z.strictObject({
  templateId: templateIdSchema,
  name: z
    .string()
    .trim()
    .min(1)
    .max(255)
    .refine((name) => !/[\r\n]/.test(name), { message: 'The name must fit on one line' })
    .optional(),
  workspaceId: z.uuid().optional(),
})
export type CreateProjectFromTemplate = z.infer<typeof createProjectFromTemplateSchema>

/** Codes d'erreur de la galerie. */
export const TEMPLATE_ERRORS = {
  notFound: 'E_TEMPLATE_NOT_FOUND',
  /** Catalogue illisible ou invalide, sans copie en cache : 503. */
  catalogUnavailable: 'E_TEMPLATES_UNAVAILABLE',
  /** Zip du template introuvable ou téléchargement en échec : 502. */
  downloadFailed: 'E_TEMPLATE_DOWNLOAD_FAILED',
  /** Zip téléchargé dont la taille ou le sha256 ne correspond pas au catalogue : 502. */
  integrity: 'E_TEMPLATE_INTEGRITY',
} as const

// --- Recherche ----------------------------------------------------------------------------------

/** Texte comparable : minuscules, sans accents ni ponctuation, espaces simples. */
export function normalizeTemplateText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

/** Champs filtrables d'un template (catalogue ou fiche servie par l'API). */
type Searchable = Pick<
  TemplateMetadata,
  'id' | 'title' | 'description' | 'tags' | 'category' | 'language' | 'compiler'
>

/**
 * Vrai si le template répond à la requête : chaque mot de `q` apparaît (préfixe d'un mot,
 * sans tenir compte des accents) dans le titre, la description, les mots-clés, l'id ou la
 * catégorie ; les autres critères sont des égalités.
 */
export function matchesTemplateQuery(
  template: Searchable,
  query: Omit<TemplateListQuery, 'category'>,
): boolean {
  if (query.language !== undefined && template.language !== query.language) return false
  if (query.compiler !== undefined && template.compiler !== query.compiler) return false
  const words = normalizeTemplateText(query.q ?? '')
    .split(' ')
    .filter((word) => word !== '')
  if (words.length === 0) return true
  const haystack = ` ${normalizeTemplateText(
    [template.title, template.description, template.id, template.category, ...template.tags].join(
      ' ',
    ),
  )}`
  return words.every((word) => haystack.includes(` ${word}`))
}

/**
 * Applique recherche et filtres, trie par catégorie (ordre de la galerie) puis par titre, et
 * compte les templates de chaque catégorie qui répondent aux autres critères.
 */
export function filterTemplates<T extends Searchable>(
  templates: readonly T[],
  query: TemplateListQuery,
): { templates: T[]; categories: { id: TemplateCategory; count: number }[] } {
  const matching = templates.filter((template) => matchesTemplateQuery(template, query))
  const order = (template: T) => TEMPLATE_CATEGORIES.indexOf(template.category)
  return {
    templates: matching
      .filter((template) => query.category === undefined || template.category === query.category)
      .sort((a, b) => order(a) - order(b) || a.title.localeCompare(b.title, 'fr')),
    categories: TEMPLATE_CATEGORIES.map((id) => ({
      id,
      count: matching.filter((template) => template.category === id).length,
    })),
  }
}
