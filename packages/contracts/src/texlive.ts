import { z } from 'zod'
import { MAX_MISSING_FILE_LENGTH } from './log.js'

/**
 * Index des packages TeX Live, produit par kaxolax-texlive-images (scripts/package-index.py) au
 * build de l'image et publié dans R2 sous `texlive/<année>/packages.json`. L'API le lit, le garde
 * en mémoire et le sert au navigateur (gestionnaire de packages, suggestions d'un fichier `.sty`
 * introuvable). Les champs inconnus d'une version plus récente du format sont ignorés.
 */
export const texlivePackageSchema = z.object({
  name: z.string().min(1),
  shortdesc: z.string().nullable(),
  /** Catégorie TeX Live : `Package`, `ConTeXt` ou `TLCore`. */
  category: z.string().min(1),
  /** Sujets du catalogue CTAN (`maths`, `graphics`…). */
  topics: z.array(z.string()),
  license: z.string().nullable(),
  version: z.string().nullable(),
  /** Fiche CTAN, nulle sans fiche au catalogue. */
  ctanUrl: z.string().nullable(),
  /** Documentation (texdoc.org). */
  docUrl: z.string(),
  /** Fichiers `.sty` et `.cls` chargeables par LaTeX. */
  styles: z.array(z.string()),
  collection: z.string().nullable(),
})
export type TexlivePackage = z.infer<typeof texlivePackageSchema>

export const texliveIndexSchema = z.object({
  texliveYear: z.number().int().nullable(),
  generatedFrom: z.string(),
  packages: z.array(texlivePackageSchema),
  /** Index inverse : fichier de style → packages qui le fournissent. */
  byStyle: z.record(z.string(), z.array(z.string())),
})
export type TexliveIndex = z.infer<typeof texliveIndexSchema>

export const TEXLIVE_PACKAGES_PER_PAGE = 20
export const MAX_TEXLIVE_PACKAGES_PER_PAGE = 100

/** `GET /api/v1/texlive/packages?q=&category=&topic=&page=&perPage=` */
export const texlivePackagesQuerySchema = z.object({
  /** Recherche dans le nom, les fichiers `.sty`/`.cls` et la description (mots tous présents). */
  q: z.string().trim().max(100).optional(),
  category: z.string().trim().max(50).optional(),
  topic: z.string().trim().max(50).optional(),
  page: z.coerce.number().int().min(1).max(10_000).default(1),
  perPage: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_TEXLIVE_PACKAGES_PER_PAGE)
    .default(TEXLIVE_PACKAGES_PER_PAGE),
})
export type TexlivePackagesQuery = z.infer<typeof texlivePackagesQuerySchema>

/**
 * Package dans une liste. `usepackage` : noms à passer à `\usepackage` (fichiers `.sty`, celui
 * du nom du package en premier, au plus `MAX_SUMMARY_STYLES`) ; vide pour une classe ou un
 * package sans `.sty` (police, outil). `matchingUsepackage` (recherche avec `q` seulement) :
 * ceux de ces noms, même au-delà des `MAX_SUMMARY_STYLES` premiers, qui contiennent un des mots
 * cherchés, au plus `MAX_MATCHING_STYLES` (`typear` → `typearea` de koma-script).
 */
export const texlivePackageSummarySchema = z.object({
  name: z.string(),
  shortdesc: z.string().nullable(),
  category: z.string(),
  topics: z.array(z.string()),
  ctanUrl: z.string().nullable(),
  docUrl: z.string(),
  usepackage: z.array(z.string()),
  matchingUsepackage: z.array(z.string()).optional(),
})
export type TexlivePackageSummary = z.infer<typeof texlivePackageSummarySchema>
export const MAX_SUMMARY_STYLES = 10
export const MAX_MATCHING_STYLES = 100

export const texlivePackageListSchema = z.object({
  texliveYear: z.number().int().nullable(),
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  perPage: z.number().int().positive(),
  packages: z.array(texlivePackageSummarySchema),
})
export type TexlivePackageList = z.infer<typeof texlivePackageListSchema>

/** `GET /api/v1/texlive/packages/:name` : fiche complète (nom de package, ou de fichier `.sty`). */
export const texlivePackageDetailSchema = texlivePackageSchema.extend({
  usepackage: z.array(z.string()),
  texliveYear: z.number().int().nullable(),
})
export type TexlivePackageDetail = z.infer<typeof texlivePackageDetailSchema>

/**
 * `GET /api/v1/texlive/suggestions?name=` : `name` est un nom passé à `\usepackage`
 * (`amsmth`), ou le fichier introuvable d'une erreur « File `amsmth.sty' not found »
 * (`LogEntry.missingFile`). Un `.cls` cherche parmi les classes, le reste parmi les `.sty`.
 */
export const packageSuggestionsQuerySchema = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(MAX_MISSING_FILE_LENGTH)
    .regex(/^[^\s{}\\%]+$/, { message: 'Invalid package name' }),
})
export type PackageSuggestionsQuery = z.infer<typeof packageSuggestionsQuerySchema>

export const packageSuggestionSchema = z.object({
  /** Nom à écrire dans `\usepackage{…}` (ou `\documentclass{…}`), sans extension. */
  name: z.string(),
  /** Fichier fourni (`graphicx.sty`). */
  file: z.string(),
  /** Package TeX Live qui le fournit (`graphics`). */
  package: z.string(),
  shortdesc: z.string().nullable(),
  /** Distance d'édition avec le nom demandé (0 : même nom, à la casse près). */
  distance: z.number().int().nonnegative(),
})
export type PackageSuggestion = z.infer<typeof packageSuggestionSchema>

export const packageSuggestionsSchema = z.object({
  /** Nom demandé, sans extension. */
  query: z.string(),
  kind: z.enum(['package', 'class']),
  /**
   * Le fichier existe dans TeX Live : il manque à l'image de compilation (variante réduite), ou
   * le nom est écrit avec une autre casse.
   */
  exists: z.boolean(),
  suggestions: z.array(packageSuggestionSchema),
})
export type PackageSuggestions = z.infer<typeof packageSuggestionsSchema>
