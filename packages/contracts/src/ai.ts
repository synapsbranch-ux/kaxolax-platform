import { z } from 'zod'

/**
 * IA (Claude, API Anthropic) : modèle, opérations comptées, crédits mensuels, conversations et
 * messages, réglages d'activation par projet et par workspace, erreurs. Dates ISO 8601 en UTC.
 *
 * L'API seule appelle Claude (clé `ANTHROPIC_API_KEY` côté serveur) ; l'IA agit avec les droits
 * de l'utilisateur qui lance l'action et ne modifie jamais le texte directement (suggestions, voir
 * suggestions.ts). Chaque appel est mesuré (table ai_usage) et décompté des crédits mensuels du
 * plan de cet utilisateur.
 */

const isoDate = z.iso.datetime()
const count = z.number().int().nonnegative()

/** Modèle Claude par défaut (ID exact, sans suffixe de date). */
export const AI_DEFAULT_MODEL = 'claude-opus-5-5'

/** Profondeur de réflexion (`output_config.effort`), fixée explicitement pour chaque opération. */
export const aiEffortSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max'])
export type AiEffort = z.infer<typeof aiEffortSchema>

/**
 * Opérations comptées dans ai_usage : `assistant` (conversations, « Ask anything »),
 * `quick_action` (expliquer, reformuler, traduire…), `figure` (TikZ/pgfplots), `image` (bitmap,
 * fournisseur tiers, crédits « images »), `markdown_cleanup` (Markdown → LaTeX).
 */
export const AI_OPERATIONS = [
  'assistant',
  'quick_action',
  'figure',
  'image',
  'markdown_cleanup',
] as const
export const aiOperationSchema = z.enum(AI_OPERATIONS)
export type AiOperation = z.infer<typeof aiOperationSchema>

// --- Crédits ----------------------------------------------------------------------------------

/** Un crédit IA vaut 0,01 $ de coût d'API, soit 10 000 micro-dollars. */
export const AI_CREDIT_MICROS = 10_000

/** Réserves de crédits : `ai` (coût des appels à Claude) et `image` (images bitmap, à l'unité). */
export const aiCreditKindSchema = z.enum(['ai', 'image'])
export type AiCreditKind = z.infer<typeof aiCreditKindSchema>

/** Solde d'une réserve sur le mois en cours, en crédits (centièmes de crédit pour `ai`). */
export const creditBalanceSchema = z.object({
  /** Crédits du plan pour un mois. */
  monthly: count,
  /** Crédits consommés ce mois-ci (arrondis au centième supérieur). */
  used: z.number().nonnegative(),
  /** Crédits restants (jamais négatifs ; arrondis au centième inférieur). */
  remaining: z.number().nonnegative(),
})
export type CreditBalance = z.infer<typeof creditBalanceSchema>

/**
 * Crédits du compte connecté (`credits` de `GET /me/plan`) : mois civil UTC, remis à zéro le 1er.
 * La consommation est imputée à l'utilisateur qui lance l'action, sur son propre plan.
 */
export const aiCreditsSchema = z.object({
  periodStart: isoDate,
  resetsAt: isoDate,
  ai: creditBalanceSchema,
  images: creditBalanceSchema,
})
export type AiCredits = z.infer<typeof aiCreditsSchema>

// --- Limite de débit --------------------------------------------------------------------------

/**
 * Appels à Claude par utilisateur : au plus `requests` sur une fenêtre glissante de
 * `windowSeconds`, et `concurrent` en cours à la fois (par instance de l'API).
 */
export const AI_RATE_LIMIT = { requests: 20, windowSeconds: 60, concurrent: 3 } as const

// --- Erreurs ----------------------------------------------------------------------------------

/** Codes d'erreur de l'IA (`code` du corps de la réponse). */
export const AI_ERRORS = {
  /** 503 : IA non configurée (`ANTHROPIC_API_KEY` absente) ou clé refusée par l'API. */
  unavailable: 'E_AI_UNAVAILABLE',
  /** 403 : IA désactivée pour ce projet ou ce workspace (`scope`). */
  disabled: 'E_AI_DISABLED',
  /** 429 : trop d'appels de cet utilisateur (`retryAfterSeconds`). */
  rateLimited: 'E_AI_RATE_LIMITED',
  /** 503 : API Anthropic surchargée ou limitée (429, 529) après les nouvelles tentatives. */
  overloaded: 'E_AI_OVERLOADED',
  /** 502 : autre erreur de l'API Anthropic (réseau, 5xx, requête refusée). */
  upstream: 'E_AI_UPSTREAM',
  /** 422 : refus du modèle (`stop_reason` `refusal`, après le repli serveur). */
  refused: 'E_AI_REFUSED',
  /** 422 : réponse tronquée (`max_tokens` ou contexte plein). */
  truncated: 'E_AI_TRUNCATED',
  /** 499 : appel interrompu (client parti). */
  cancelled: 'E_AI_CANCELLED',
} as const

export const aiDisabledScopeSchema = z.enum(['project', 'workspace'])
export type AiDisabledScope = z.infer<typeof aiDisabledScopeSchema>

/** 403 `E_AI_DISABLED`. */
export const aiDisabledErrorSchema = z.object({
  code: z.literal('E_AI_DISABLED'),
  message: z.string(),
  scope: aiDisabledScopeSchema,
})
export type AiDisabledError = z.infer<typeof aiDisabledErrorSchema>

/** 429 `E_AI_RATE_LIMITED` (l'en-tête `retry-after` porte la même valeur). */
export const aiRateLimitedErrorSchema = z.object({
  code: z.literal('E_AI_RATE_LIMITED'),
  message: z.string(),
  retryAfterSeconds: z.number().int().positive(),
})
export type AiRateLimitedError = z.infer<typeof aiRateLimitedErrorSchema>

/** 422 `E_AI_REFUSED` : catégorie de `stop_details` (null si inconnue). */
export const aiRefusedErrorSchema = z.object({
  code: z.literal('E_AI_REFUSED'),
  message: z.string(),
  category: z.string().nullable(),
})
export type AiRefusedError = z.infer<typeof aiRefusedErrorSchema>

// --- Activation par projet et par workspace -----------------------------------------------------

/**
 * `GET /projects/:id/ai` (tout membre) et réponse de `PUT /projects/:id/ai` (propriétaire,
 * permission `manageAi`). L'IA n'est utilisable que si elle est configurée côté serveur et activée
 * à la fois pour le projet et pour son workspace.
 */
export const projectAiSettingsSchema = z.object({
  projectId: z.uuid(),
  /** Réglage du projet. */
  projectEnabled: z.boolean(),
  /** Réglage du workspace du projet. */
  workspaceEnabled: z.boolean(),
  /** Clé de l'API Anthropic présente côté serveur. */
  configured: z.boolean(),
  /** Utilisable : configurée et activée pour le projet et le workspace. */
  enabled: z.boolean(),
  /** L'utilisateur peut changer le réglage du projet. */
  canManage: z.boolean(),
})
export type ProjectAiSettings = z.infer<typeof projectAiSettingsSchema>

/** `GET /workspaces/:id/ai` (tout membre) et réponse de `PUT` (propriétaire du workspace). */
export const workspaceAiSettingsSchema = z.object({
  workspaceId: z.uuid(),
  enabled: z.boolean(),
  configured: z.boolean(),
  canManage: z.boolean(),
})
export type WorkspaceAiSettings = z.infer<typeof workspaceAiSettingsSchema>

/** Corps de `PUT /projects/:id/ai` et `PUT /workspaces/:id/ai`. */
export const updateAiSettingsInputSchema = z.strictObject({ enabled: z.boolean() })
export type UpdateAiSettingsInput = z.infer<typeof updateAiSettingsInputSchema>

// --- Contenu des messages (blocs de l'API, gardés tels quels) --------------------------------

/**
 * Blocs de contenu d'un message, enregistrés tels que l'API les renvoie : les blocs `thinking`
 * (avec leur signature), `tool_use` et `fallback` doivent être renvoyés à l'identique au tour
 * suivant. Les champs inconnus sont conservés (objets ouverts) ; un type de bloc inconnu
 * (outils serveur, futurs blocs) est accepté tel quel.
 */
const textBlockSchema = z.looseObject({ type: z.literal('text'), text: z.string() })
const thinkingBlockSchema = z.looseObject({
  type: z.literal('thinking'),
  thinking: z.string(),
  signature: z.string(),
})
const redactedThinkingBlockSchema = z.looseObject({
  type: z.literal('redacted_thinking'),
  data: z.string(),
})
const toolUseBlockSchema = z.looseObject({
  type: z.literal('tool_use'),
  id: z.string().min(1),
  name: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
})
const toolResultBlockSchema = z.looseObject({
  type: z.literal('tool_result'),
  tool_use_id: z.string().min(1),
  content: z.union([z.string(), z.array(z.looseObject({ type: z.string() }))]).optional(),
  is_error: z.boolean().optional(),
})

/** Types de blocs dont la forme est vérifiée. */
export const AI_KNOWN_BLOCK_TYPES = [
  'text',
  'thinking',
  'redacted_thinking',
  'tool_use',
  'tool_result',
] as const
const knownBlockTypes: ReadonlySet<string> = new Set(AI_KNOWN_BLOCK_TYPES)

const otherBlockSchema = z.looseObject({
  type: z.string().refine((type) => !knownBlockTypes.has(type), 'Malformed content block'),
})

export const aiContentBlockSchema = z.union([
  textBlockSchema,
  thinkingBlockSchema,
  redactedThinkingBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  otherBlockSchema,
])
export type AiContentBlock = z.infer<typeof aiContentBlockSchema>

// --- Conversations et messages (routes : tâche 3) --------------------------------------------

export const aiMessageRoleSchema = z.enum(['user', 'assistant'])
export type AiMessageRole = z.infer<typeof aiMessageRoleSchema>

/**
 * État d'un message : `streaming` pendant la génération, `complete`, `refused` (refus du
 * modèle), `truncated` (`max_tokens`), `failed` (erreur de l'API ou interruption).
 */
export const aiMessageStatusSchema = z.enum([
  'streaming',
  'complete',
  'refused',
  'truncated',
  'failed',
])
export type AiMessageStatus = z.infer<typeof aiMessageStatusSchema>

/** Usage d'un appel (tokens et coût calculé, en micro-dollars). */
export const aiUsageSummarySchema = z.object({
  inputTokens: count,
  outputTokens: count,
  cacheReadInputTokens: count,
  cacheCreationInputTokens: count,
  costMicros: count,
})
export type AiUsageSummary = z.infer<typeof aiUsageSummarySchema>

export const aiMessageSchema = z.object({
  id: z.uuid(),
  conversationId: z.uuid(),
  role: aiMessageRoleSchema,
  content: z.array(aiContentBlockSchema),
  /** Modèle qui a produit la réponse (assistant), null pour un message de l'utilisateur. */
  model: z.string().nullable(),
  status: aiMessageStatusSchema,
  stopReason: z.string().nullable(),
  usage: aiUsageSummarySchema.nullable(),
  createdAt: isoDate,
})
export type AiMessage = z.infer<typeof aiMessageSchema>

/** Longueur maximale du titre d'une conversation. */
export const AI_CONVERSATION_TITLE_MAX_LENGTH = 200

/** Conversation IA d'un utilisateur dans un projet (privée : seul son auteur la voit). */
export const aiConversationSchema = z.object({
  id: z.uuid(),
  projectId: z.uuid(),
  title: z.string().max(AI_CONVERSATION_TITLE_MAX_LENGTH).nullable(),
  archivedAt: isoDate.nullable(),
  lastMessageAt: isoDate,
  createdAt: isoDate,
})
export type AiConversation = z.infer<typeof aiConversationSchema>

/** Pagination par curseur (du plus récent au plus ancien), commune aux listes de l'IA. */
export const AI_PAGE_SIZE = 30
export const aiPageQuerySchema = z.object({
  /** Curseur opaque renvoyé par la page précédente. */
  cursor: z.string().min(1).max(200).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(AI_PAGE_SIZE),
})
export type AiPageQuery = z.infer<typeof aiPageQuerySchema>

export const aiConversationsResponseSchema = z.object({
  conversations: z.array(aiConversationSchema),
  nextCursor: z.string().nullable(),
})
export type AiConversationsResponse = z.infer<typeof aiConversationsResponseSchema>

export const aiMessagesResponseSchema = z.object({
  messages: z.array(aiMessageSchema),
  nextCursor: z.string().nullable(),
})
export type AiMessagesResponse = z.infer<typeof aiMessagesResponseSchema>

// --- Admin ------------------------------------------------------------------------------------

/**
 * `GET /admin/ai/health` : clé configurée, modèle accessible (API Models, sans coût de tokens),
 * latence de la vérification et code d'erreur éventuel.
 */
export const aiHealthResponseSchema = z.object({
  configured: z.boolean(),
  model: z.string(),
  ok: z.boolean(),
  latencyMs: count.nullable(),
  /** Code `E_AI_…` de l'échec, null si la vérification a réussi. */
  error: z.string().nullable(),
  checkedAt: isoDate,
})
export type AiHealthResponse = z.infer<typeof aiHealthResponseSchema>
