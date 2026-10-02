import { z } from 'zod'

/**
 * Préférences d'un utilisateur (table `user_preferences`, colonne jsonb), appliquées sur tous ses
 * appareils. Toutes les clés sont facultatives : seules celles que l'utilisateur a changées sont
 * stockées, les autres prennent la valeur de `DEFAULT_PREFERENCES` (qui peut donc évoluer).
 * Objets stricts : une clé inconnue est refusée (une tâche qui en ajoute une étend ce schéma).
 */

/**
 * Projets dont les onglets ouverts sont mémorisés : au-delà, ceux dont les onglets ont été
 * modifiés le moins récemment sortent (numéro d'ordre `usedSeq` de chaque entrée).
 */
export const MAX_OPEN_TABS_PROJECTS = 20
/** Onglets ouverts mémorisés par projet. */
export const MAX_OPEN_TABS_PER_PROJECT = 30
/** Taille maximale du JSON stocké, en octets (UTF-8). */
export const MAX_PREFERENCES_BYTES = 32 * 1024

export const themeSchema = z.enum(['dark', 'light'])
export type Theme = z.infer<typeof themeSchema>

export const editorKeymapSchema = z.enum(['default', 'vim', 'emacs'])
export type EditorKeymap = z.infer<typeof editorKeymapSchema>

/** Taille d'une colonne, en pourcentage de la largeur de la page. */
const percentSchema = z.number().min(0).max(100)

export const layoutPreferencesSchema = z.strictObject({
  sidebarSize: percentSchema.optional(),
  editorSize: percentSchema.optional(),
  pdfSize: percentSchema.optional(),
  sidebarCollapsed: z.boolean().optional(),
})

/** Options de compilation choisies dans le menu de la pastille de statut. */
export const compilePreferencesSchema = z.strictObject({
  draft: z.boolean().optional(),
  haltOnFirstError: z.boolean().optional(),
})

/**
 * Onglets ouverts dans un projet : ids des documents (et des fichiers binaires prévisualisés) dans
 * l'ordre d'affichage, et l'actif. `usedSeq` est posé par `mergePreferences` (la valeur envoyée
 * est ignorée) : numéro croissant de la dernière modification, qui décide des projets gardés.
 * L'ordre des clés d'un objet ne peut pas servir : jsonb le réordonne.
 */
export const openTabsEntrySchema = z.strictObject({
  documentIds: z.array(z.uuid()).max(MAX_OPEN_TABS_PER_PROJECT),
  activeDocumentId: z.uuid().nullable(),
  usedSeq: z.number().int().nonnegative().optional(),
})
export type OpenTabsEntry = z.infer<typeof openTabsEntrySchema>

/** Paramètres de l'éditeur (tâche 10) : validés dès maintenant, pas encore appliqués. */
export const editorPreferencesSchema = z.strictObject({
  fontFamily: z.string().trim().min(1).max(100).optional(),
  fontSize: z.number().int().min(8).max(32).optional(),
  lineHeight: z.number().min(1).max(3).optional(),
  keymap: editorKeymapSchema.optional(),
  wrap: z.boolean().optional(),
  spellcheck: z.boolean().optional(),
  syntaxTheme: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,49}$/)
    .optional(),
})

export const userPreferencesSchema = z.strictObject({
  /** Thème de la sidebar et de l'éditeur (la zone PDF reste claire). Défaut : `dark`. */
  theme: themeSchema.optional(),
  /** Tailles des trois colonnes (défaut 18/41/41) et repli de la sidebar (défaut : dépliée). */
  layout: layoutPreferencesSchema.optional(),
  /** Barre d'outils (bouton Tools) affichée. Défaut : masquée. */
  toolsVisible: z.boolean().optional(),
  /** Compilation automatique après une pause de frappe. Défaut : désactivée. */
  autoCompile: z.boolean().optional(),
  /** Mode brouillon et arrêt à la première erreur. Défaut : désactivés. */
  compile: compilePreferencesSchema.optional(),
  /** Onglets ouverts, par id de projet (au plus `MAX_OPEN_TABS_PROJECTS`). Défaut : aucun. */
  openTabs: z
    .record(z.uuid(), openTabsEntrySchema)
    .refine((tabs) => Object.keys(tabs).length <= MAX_OPEN_TABS_PROJECTS, {
      message: `At most ${String(MAX_OPEN_TABS_PROJECTS)} projects`,
    })
    .optional(),
  /** Paramètres de l'éditeur (voir `DEFAULT_PREFERENCES.editor`). */
  editor: editorPreferencesSchema.optional(),
})
/** Préférences stockées, ou modification envoyée par `PATCH /me/preferences`. */
export type UserPreferences = z.infer<typeof userPreferencesSchema>

type DeepRequired<T> = T extends readonly unknown[]
  ? T
  : T extends object
    ? { [K in keyof T]-?: DeepRequired<T[K]> }
    : T

/** Préférences complètes, valeurs par défaut appliquées (réponse de `GET /me/preferences`). */
export type ResolvedPreferences = DeepRequired<UserPreferences>

export const DEFAULT_PREFERENCES: ResolvedPreferences = {
  theme: 'dark',
  layout: { sidebarSize: 18, editorSize: 41, pdfSize: 41, sidebarCollapsed: false },
  toolsVisible: false,
  autoCompile: false,
  compile: { draft: false, haltOnFirstError: false },
  openTabs: {},
  editor: {
    fontFamily: 'monospace',
    fontSize: 14,
    lineHeight: 1.5,
    keymap: 'default',
    wrap: true,
    spellcheck: true,
    syntaxTheme: 'default',
  },
}

/** Réponse de `GET` et `PATCH /me/preferences`. */
export interface PreferencesResponse {
  preferences: ResolvedPreferences
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Fusion profonde : les objets sont fusionnés clé par clé, les tableaux et les valeurs simples
 * remplacés, une valeur `undefined` ignorée.
 */
function deepMerge(
  current: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    const previous = result[key]
    result[key] =
      isPlainObject(previous) && isPlainObject(value) ? deepMerge(previous, value) : value
  }
  return result
}

/** Numéro d'ordre d'une entrée d'onglets (0 si absent ou invalide). */
function usedSeq(entry: unknown): number {
  if (!isPlainObject(entry)) return 0
  const value = entry.usedSeq
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : 0
}

/**
 * Numérote les projets dont la modification touche les onglets (au-dessus du plus grand numéro
 * stocké), puis garde les `MAX_OPEN_TABS_PROJECTS` projets aux numéros les plus grands.
 */
function stampOpenTabs(
  current: Record<string, unknown>,
  merged: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const tabs = merged.openTabs
  if (!isPlainObject(tabs)) return merged
  const touched = isPlainObject(patch.openTabs) ? Object.keys(patch.openTabs) : []
  // Numéros déjà stockés seulement : ceux de la modification viennent du client.
  const stored = isPlainObject(current.openTabs) ? Object.values(current.openTabs) : []
  let next = Math.max(0, ...stored.map(usedSeq)) + 1
  const stamped: Record<string, unknown> = { ...tabs }
  for (const id of touched) {
    const entry = stamped[id]
    if (isPlainObject(entry)) stamped[id] = { ...entry, usedSeq: next++ }
  }
  const entries = Object.entries(stamped)
  if (entries.length <= MAX_OPEN_TABS_PROJECTS) return { ...merged, openTabs: stamped }
  // Tri stable : à numéro égal (entrées anciennes sans numéro), l'ordre existant est gardé.
  const kept = entries
    .toSorted(([, a], [, b]) => usedSeq(a) - usedSeq(b))
    .slice(-MAX_OPEN_TABS_PROJECTS)
  return { ...merged, openTabs: Object.fromEntries(kept) }
}

/**
 * Applique une modification aux préférences stockées (fusion profonde, tableaux remplacés ; les
 * onglets des projets modifiés le moins récemment sortent au-delà de `MAX_OPEN_TABS_PROJECTS`),
 * puis valide le résultat. Lève une `ZodError` s'il est invalide.
 */
export function mergePreferences(
  current: UserPreferences,
  patch: UserPreferences,
): UserPreferences {
  return userPreferencesSchema.parse(stampOpenTabs(current, deepMerge(current, patch), patch))
}

/** Comme `mergePreferences`, sans lever : résultat de `safeParse`. */
export function safeMergePreferences(current: UserPreferences, patch: UserPreferences) {
  return userPreferencesSchema.safeParse(stampOpenTabs(current, deepMerge(current, patch), patch))
}

/**
 * Garde d'une valeur ce que `schema` accepte : la valeur entière si elle est valide, sinon, pour
 * un objet, ses champs valides un par un (récursivement) ; `undefined` si rien n'est gardé.
 */
function keepValid(schema: z.core.$ZodType, value: unknown): unknown {
  const parsed = z.safeParse(schema, value)
  if (parsed.success) return parsed.data
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema
  if (!(inner instanceof z.ZodObject) || !isPlainObject(value)) return undefined
  const shape: Readonly<Record<string, z.core.$ZodType>> = (inner as z.ZodObject<z.core.$ZodShape>)
    .shape
  const kept: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(shape)) {
    const result = keepValid(field, value[key])
    if (result !== undefined) kept[key] = result
  }
  return Object.keys(kept).length > 0 ? kept : undefined
}

/** Onglets stockés : entrées valides seulement, au plus `MAX_OPEN_TABS_PROJECTS` (les plus récentes). */
function keepValidOpenTabs(value: unknown): Record<string, OpenTabsEntry> | undefined {
  if (!isPlainObject(value)) return undefined
  const entries: [string, OpenTabsEntry][] = []
  for (const [id, entry] of Object.entries(value)) {
    if (!z.uuid().safeParse(id).success) continue
    const parsed = openTabsEntrySchema.safeParse(entry)
    if (parsed.success) entries.push([id, parsed.data])
  }
  return Object.fromEntries(
    entries
      .toSorted(([, a], [, b]) => (a.usedSeq ?? 0) - (b.usedSeq ?? 0))
      .slice(-MAX_OPEN_TABS_PROJECTS),
  )
}

/**
 * Préférences stockées, relues avec tolérance : une clé devenue invalide (schéma resserré ou clé
 * retirée par une tâche ultérieure) est écartée seule, les autres sont gardées. Ne lève jamais.
 */
export function sanitizePreferences(value: unknown): UserPreferences {
  const parsed = userPreferencesSchema.safeParse(value)
  if (parsed.success) return parsed.data
  if (!isPlainObject(value)) return {}
  const kept: Record<string, unknown> = {}
  for (const [key, field] of Object.entries(userPreferencesSchema.shape)) {
    const result = key === 'openTabs' ? keepValidOpenTabs(value[key]) : keepValid(field, value[key])
    if (result !== undefined) kept[key] = result
  }
  const cleaned = userPreferencesSchema.safeParse(kept)
  return cleaned.success ? cleaned.data : {}
}

/** Préférences complètes : valeurs stockées par-dessus `DEFAULT_PREFERENCES`. */
export function resolvePreferences(stored: UserPreferences): ResolvedPreferences {
  const defaults = DEFAULT_PREFERENCES
  const layout = stored.layout ?? {}
  const compile = stored.compile ?? {}
  const editor = stored.editor ?? {}
  return {
    theme: stored.theme ?? defaults.theme,
    layout: {
      sidebarSize: layout.sidebarSize ?? defaults.layout.sidebarSize,
      editorSize: layout.editorSize ?? defaults.layout.editorSize,
      pdfSize: layout.pdfSize ?? defaults.layout.pdfSize,
      sidebarCollapsed: layout.sidebarCollapsed ?? defaults.layout.sidebarCollapsed,
    },
    toolsVisible: stored.toolsVisible ?? defaults.toolsVisible,
    autoCompile: stored.autoCompile ?? defaults.autoCompile,
    compile: {
      draft: compile.draft ?? defaults.compile.draft,
      haltOnFirstError: compile.haltOnFirstError ?? defaults.compile.haltOnFirstError,
    },
    openTabs: Object.fromEntries(
      Object.entries(stored.openTabs ?? defaults.openTabs).map(([id, entry]) => [
        id,
        { ...entry, usedSeq: entry.usedSeq ?? 0 },
      ]),
    ),
    editor: {
      fontFamily: editor.fontFamily ?? defaults.editor.fontFamily,
      fontSize: editor.fontSize ?? defaults.editor.fontSize,
      lineHeight: editor.lineHeight ?? defaults.editor.lineHeight,
      keymap: editor.keymap ?? defaults.editor.keymap,
      wrap: editor.wrap ?? defaults.editor.wrap,
      spellcheck: editor.spellcheck ?? defaults.editor.spellcheck,
      syntaxTheme: editor.syntaxTheme ?? defaults.editor.syntaxTheme,
    },
  }
}
