import { z } from 'zod'
import { chatAuthorSchema } from './chat.js'
import { COMMENT_ANCHOR_MAX_LENGTH } from './comments.js'

/**
 * Suivi des modifications : suggestions d'insertion, de suppression ou de remplacement, faites
 * par un membre (mode Suggérer) ou par l'IA (au nom de l'utilisateur qui l'a sollicitée). Le texte
 * du document ne change qu'à l'acceptation. Routes `/api/v1/projects/:id/suggestions*` :
 *
 * - lire : tout membre (`read`) ; suggérer, modifier ou retirer sa suggestion ouverte : permission
 *   `suggest` (propriétaire, éditeur, relecteur) ; accepter ou refuser : `decideSuggestion`
 *   (propriétaire, éditeur) ; le lecteur ne fait que lire ;
 * - l'acceptation passe par le service temps réel, qui applique le texte proposé au document Yjs
 *   en cours d'édition au nom de l'auteur de la suggestion (historique) ; une suggestion dont le
 *   texte d'origine a changé devient `stale` au lieu d'être appliquée.
 *
 * Ancrage : deux positions relatives Yjs (début et fin) encodées comme les ancres des
 * commentaires (`@kaxolax/collab`, anchors ; même format binaire, base64 en JSON). Pour une
 * insertion, début et fin désignent le même point.
 */

const isoDate = z.iso.datetime()

export const SUGGESTION_KINDS = ['insert', 'delete', 'replace'] as const
export const suggestionKindSchema = z.enum(SUGGESTION_KINDS)
export type SuggestionKind = z.infer<typeof suggestionKindSchema>

/** `stale` : le texte d'origine a changé ou disparu avant la décision (ancre détachée). */
export const SUGGESTION_STATUSES = ['open', 'accepted', 'rejected', 'stale'] as const
export const suggestionStatusSchema = z.enum(SUGGESTION_STATUSES)
export type SuggestionStatus = z.infer<typeof suggestionStatusSchema>

/** Auteur humain (mode Suggérer) ou IA (lien vers le message de l'assistant). */
export const suggestionOriginSchema = z.enum(['user', 'ai'])
export type SuggestionOrigin = z.infer<typeof suggestionOriginSchema>

/** Longueur maximale du texte d'origine et du texte proposé (unités UTF-16). */
export const SUGGESTION_TEXT_MAX_LENGTH = 20_000

const anchorSchema = z
  .string()
  .min(1)
  .max(COMMENT_ANCHOR_MAX_LENGTH)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/, 'The anchor must be base64')
const textSchema = z.string().max(SUGGESTION_TEXT_MAX_LENGTH)

/**
 * Cohérence du type et des textes (même règle que la contrainte de la table) : une insertion n'a
 * pas de texte d'origine, une suppression pas de texte proposé, un remplacement les deux.
 */
export function suggestionTextsMatchKind(
  kind: SuggestionKind,
  originalText: string,
  proposedText: string,
): boolean {
  switch (kind) {
    case 'insert':
      return originalText === '' && proposedText !== ''
    case 'delete':
      return originalText !== '' && proposedText === ''
    case 'replace':
      return originalText !== '' && proposedText !== '' && originalText !== proposedText
  }
}

export const suggestionSchema = z.object({
  id: z.uuid(),
  documentId: z.uuid(),
  /** Membre qui a suggéré, ou qui a sollicité l'IA (`origin` = `ai`). */
  author: chatAuthorSchema,
  origin: suggestionOriginSchema,
  kind: suggestionKindSchema,
  /** Positions relatives Yjs (début et fin) encodées, en base64. */
  anchor: anchorSchema,
  /** Texte remplacé ou supprimé, tel qu'au moment de la suggestion ('' pour une insertion). */
  originalText: textSchema,
  /** Texte inséré ou de remplacement ('' pour une suppression). */
  proposedText: textSchema,
  status: suggestionStatusSchema,
  /** Membre qui a accepté ou refusé ; null tant qu'ouverte ou si devenue obsolète. */
  decidedBy: chatAuthorSchema.nullable(),
  decidedAt: isoDate.nullable(),
  /** Message de l'assistant qui a proposé la modification (`origin` = `ai`). */
  aiMessageId: z.uuid().nullable(),
  createdAt: isoDate,
})
export type Suggestion = z.infer<typeof suggestionSchema>

const textsMatch = {
  check: (input: { kind: SuggestionKind; originalText: string; proposedText: string }) =>
    suggestionTextsMatchKind(input.kind, input.originalText, input.proposedText),
  message: 'The texts do not match the kind of suggestion',
}

/** Champs d'une modification proposée : type, ancre et textes. */
const suggestionChangeShape = {
  kind: suggestionKindSchema,
  anchor: anchorSchema,
  originalText: textSchema.default(''),
  proposedText: textSchema.default(''),
}

/**
 * `POST /projects/:id/suggestions` (permission `suggest`) ; réponse 201 : `suggestionResponseSchema`.
 * L'ancre d'une insertion désigne un point (début = fin, `createPointAnchor`), celle d'une
 * suppression ou d'un remplacement la plage du texte d'origine (`createCommentAnchor`).
 */
export const createSuggestionInputSchema = z
  .strictObject({ documentId: z.uuid(), ...suggestionChangeShape })
  .refine(textsMatch.check, { message: textsMatch.message, path: ['kind'] })
export type CreateSuggestionInput = z.infer<typeof createSuggestionInputSchema>

/**
 * `PATCH /projects/:id/suggestions/:suggestionId` : l'auteur remplace sa suggestion ouverte (frappes
 * successives fusionnées, voir `recordSuggestionEdit` de `@kaxolax/collab`). Réponse : la suggestion.
 */
export const updateSuggestionInputSchema = z
  .strictObject(suggestionChangeShape)
  .refine(textsMatch.check, { message: textsMatch.message, path: ['kind'] })
export type UpdateSuggestionInput = z.infer<typeof updateSuggestionInputSchema>

/** Codes d'erreur propres aux suggestions (`code` du corps de la réponse). */
export const SUGGESTION_ERRORS = {
  /** 404 : suggestion inconnue dans ce projet. */
  notFound: 'E_SUGGESTION_NOT_FOUND',
  /** 403 : seul l'auteur modifie ou retire sa suggestion. */
  notAuthor: 'E_SUGGESTION_NOT_AUTHOR',
  /**
   * 409 : la suggestion a déjà été acceptée ou refusée (modification d'une suggestion obsolète
   * aussi : elle ne peut plus qu'être retirée ou écartée).
   */
  alreadyDecided: 'E_SUGGESTION_ALREADY_DECIDED',
  /** 404 : le document visé n'existe pas dans ce projet. */
  documentNotFound: 'E_DOCUMENT_NOT_FOUND',
  /** 422 : ancre illisible, ou qui ne correspond pas au type (point pour une insertion). */
  invalidAnchor: 'E_SUGGESTION_INVALID_ANCHOR',
  /**
   * 429 : trop de suggestions (créations) ou de modifications et retraits sur la fenêtre
   * (`retryAfterSeconds`).
   */
  rateLimited: 'E_SUGGESTION_RATE_LIMITED',
  /** 409 : trop de suggestions en attente (ouvertes ou obsolètes) pour l'auteur ou le projet. */
  openLimit: 'E_SUGGESTION_OPEN_LIMIT',
  /**
   * 503 : le service temps réel n'a pas confirmé l'application (ou la vérification avant un refus
   * ou un retrait) ; les suggestions sans confirmation restent ouvertes, réessayer.
   */
  realtimeUnavailable: 'E_SUGGESTION_REALTIME_UNAVAILABLE',
} as const

/** Suggestions (créations) qu'un membre peut faire dans un projet par fenêtre glissante. */
export const SUGGESTION_RATE_LIMIT = { suggestions: 120, windowSeconds: 60 } as const

/**
 * Modifications et retraits (`PATCH`, `DELETE`) qu'un membre peut faire dans un projet par fenêtre
 * fixe : l'éditeur n'envoie une modification qu'après 400 ms sans frappe (150 par minute au plus).
 */
export const SUGGESTION_EDIT_RATE_LIMIT = { edits: 240, windowSeconds: 60 } as const

/**
 * Suggestions en attente (ouvertes ou obsolètes) au plus par auteur dans un projet, et dans tout
 * le projet : borne la place occupée par des textes que le propriétaire n'a pas encore acceptés.
 */
export const SUGGESTION_OPEN_LIMIT = { perAuthor: 1000, perProject: 5000 } as const

/** Suggestions décidées au plus par requête `decide` (le reste : `remaining`, relancer). */
export const SUGGESTION_DECIDE_MAX = 500

export const SUGGESTION_PAGE_SIZE = 500
export const SUGGESTION_PAGE_MAX_SIZE = 1000

/** Filtre de statut de la liste : un statut, `decided` (acceptées, refusées, obsolètes) ou `all`. */
export const suggestionStatusFilterSchema = z.enum([
  ...SUGGESTION_STATUSES,
  'decided',
  'all',
] as const)
export type SuggestionStatusFilter = z.infer<typeof suggestionStatusFilterSchema>

/**
 * `GET /projects/:id/suggestions` (tout membre) : suggestions du projet, d'un document, d'un
 * auteur, de la plus ancienne à la plus récente ; page suivante avec `after` = `nextCursor`.
 */
/**
 * Curseur de pagination des suggestions : date de création (microsecondes depuis l'époque Unix)
 * et identifiant de la dernière suggestion lue. Il ne dépend pas de l'existence de cette
 * suggestion : un retrait entre deux pages n'arrête pas la lecture.
 */
export const suggestionCursorSchema = z
  .string()
  .regex(/^\d{1,19}_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)

export const suggestionsQuerySchema = z.object({
  documentId: z.uuid().optional(),
  authorId: z.uuid().optional(),
  status: suggestionStatusFilterSchema.default('open'),
  after: suggestionCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(SUGGESTION_PAGE_MAX_SIZE).default(SUGGESTION_PAGE_SIZE),
})
export type SuggestionsQuery = z.infer<typeof suggestionsQuerySchema>

export const suggestionsResponseSchema = z.object({
  suggestions: z.array(suggestionSchema),
  /** Curseur à passer en `after` pour la page suivante ; null : plus rien. */
  nextCursor: suggestionCursorSchema.nullable(),
})
export type SuggestionsResponse = z.infer<typeof suggestionsResponseSchema>

/** Réponse de la création, de la modification et de la lecture d'une suggestion. */
export const suggestionResponseSchema = z.object({ suggestion: suggestionSchema })
export type SuggestionResponse = z.infer<typeof suggestionResponseSchema>

export const suggestionDecisionSchema = z.enum(['accept', 'reject'])
export type SuggestionDecision = z.infer<typeof suggestionDecisionSchema>

/**
 * `POST /projects/:id/suggestions/decide` (permission `decideSuggestion`) : accepter ou refuser
 * une ou plusieurs suggestions (`ids`), toutes les suggestions ouvertes (`all: true`) ou toutes
 * celles d'un auteur (`authorId`) ; exactement une de ces trois cibles. `documentId` restreint
 * `all` et `authorId` à un document. Un refus vise aussi les suggestions obsolètes (« Écarter ») :
 * elles quittent le panneau. Idempotent : une suggestion déjà acceptée ou refusée reste telle
 * quelle (`unchanged`), un double clic ou deux décideurs simultanés n'appliquent le texte qu'une
 * fois. Une suggestion ouverte dont le texte a déjà été appliqué (acceptation interrompue) est
 * marquée `accepted` au lieu d'être refusée.
 */
export const decideSuggestionsInputSchema = z
  .strictObject({
    decision: suggestionDecisionSchema,
    ids: z.array(z.uuid()).min(1).max(SUGGESTION_DECIDE_MAX).optional(),
    all: z.literal(true).optional(),
    authorId: z.uuid().optional(),
    documentId: z.uuid().optional(),
  })
  .refine(
    (input) =>
      [input.ids !== undefined, input.all !== undefined, input.authorId !== undefined].filter(
        Boolean,
      ).length === 1,
    { message: 'Give exactly one of ids, all or authorId', path: ['ids'] },
  )
  .refine((input) => input.ids === undefined || input.documentId === undefined, {
    message: 'documentId only narrows all or authorId',
    path: ['documentId'],
  })
export type DecideSuggestionsInput = z.infer<typeof decideSuggestionsInputSchema>

/**
 * Résultat par suggestion visée : `accepted` (texte appliqué), `rejected`, `stale` (texte
 * d'origine changé : rien n'est appliqué), `unchanged` (déjà décidée, ou obsolète pour une
 * acceptation), `missing` (identifiant inconnu dans le projet, ou retirée par son auteur).
 */
export const suggestionOutcomeSchema = z.enum([
  'accepted',
  'rejected',
  'stale',
  'unchanged',
  'missing',
])
export type SuggestionOutcome = z.infer<typeof suggestionOutcomeSchema>

export const decideSuggestionsResponseSchema = z.object({
  results: z.array(z.object({ id: z.uuid(), outcome: suggestionOutcomeSchema })),
  /** État à jour des suggestions trouvées. */
  suggestions: z.array(suggestionSchema),
  /** Suggestions ouvertes encore visées par `all` ou `authorId` au-delà de la limite (0 sinon). */
  remaining: z.number().int().nonnegative(),
})
export type DecideSuggestionsResponse = z.infer<typeof decideSuggestionsResponseSchema>

/** 429 de la création, de la modification ou du retrait d'une suggestion. */
export const suggestionRateLimitedErrorSchema = z.object({
  code: z.literal('E_SUGGESTION_RATE_LIMITED'),
  message: z.string(),
  retryAfterSeconds: z.number().int().positive(),
})

// --- Événements (document meta, voir events.ts) ---------------------------------------------

/** Nouvelle suggestion : le client la relit (`GET …/suggestions?documentId=`). */
export const suggestionCreatedEventSchema = z.object({
  type: z.literal('suggestion.created'),
  suggestionId: z.uuid(),
  documentId: z.uuid(),
  authorId: z.uuid(),
})
export type SuggestionCreatedEvent = z.infer<typeof suggestionCreatedEventSchema>

/** Suggestion modifiée (`edited`) ou retirée (`deleted`) par son auteur. */
export const suggestionUpdatedEventSchema = z.object({
  type: z.literal('suggestion.updated'),
  suggestionId: z.uuid(),
  documentId: z.uuid(),
  change: z.enum(['edited', 'deleted']),
  actorId: z.uuid(),
})
export type SuggestionUpdatedEvent = z.infer<typeof suggestionUpdatedEventSchema>

/** Suggestions acceptées, refusées ou devenues obsolètes par une décision (`actorId`). */
export const suggestionDecidedEventSchema = z.object({
  type: z.literal('suggestion.decided'),
  decisions: z
    .array(
      z.object({
        suggestionId: z.uuid(),
        documentId: z.uuid(),
        status: suggestionStatusSchema.exclude(['open']),
      }),
    )
    .min(1)
    .max(SUGGESTION_DECIDE_MAX),
  actorId: z.uuid(),
})
export type SuggestionDecidedEvent = z.infer<typeof suggestionDecidedEventSchema>

// --- Route interne du service temps réel ------------------------------------------------------

/** Suggestions appliquées au plus par appel de la route interne (corps borné). */
export const SUGGESTION_APPLY_BATCH = 50

/**
 * `POST /internal/projects/:projectId/documents/:documentId/suggestions/apply` : applique des
 * suggestions acceptées au document Yjs en cours d'édition, chacune au nom de son auteur (journal
 * de l'historique), décideur journalisé. `decidedBy` doit pouvoir décider (rôle relu en base).
 */
export const applySuggestionsRequestSchema = z.object({
  decidedBy: z.uuid(),
  suggestions: z
    .array(
      z.object({
        id: z.uuid(),
        authorId: z.uuid(),
        kind: suggestionKindSchema,
        anchor: anchorSchema,
        originalText: textSchema,
        proposedText: textSchema,
      }),
    )
    .min(1)
    .max(SUGGESTION_APPLY_BATCH),
})
export type ApplySuggestionsRequest = z.infer<typeof applySuggestionsRequestSchema>

/**
 * `applied` : texte appliqué maintenant ; `already-applied` : déjà appliquée (appel répété après
 * une réponse perdue) ; `stale` : texte d'origine changé ou ancre introuvable, rien d'appliqué.
 */
export const suggestionApplyOutcomeSchema = z.enum(['applied', 'already-applied', 'stale'])
export type SuggestionApplyOutcome = z.infer<typeof suggestionApplyOutcomeSchema>

export const applySuggestionsResponseSchema = z.object({
  results: z.array(z.object({ id: z.uuid(), outcome: suggestionApplyOutcomeSchema })),
})
export type ApplySuggestionsResponse = z.infer<typeof applySuggestionsResponseSchema>

/**
 * `POST /internal/projects/:projectId/documents/:documentId/suggestions/applied` : lesquelles de
 * ces suggestions ont déjà été appliquées au document (map `appliedSuggestions` du document Yjs,
 * autres instances rattrapées). L'API le vérifie avant de refuser ou de retirer une suggestion
 * ouverte : une acceptation interrompue (réponse perdue, délai dépassé) a pu l'appliquer.
 */
export const appliedSuggestionsRequestSchema = z.object({
  ids: z.array(z.uuid()).min(1).max(SUGGESTION_DECIDE_MAX),
})
export type AppliedSuggestionsRequest = z.infer<typeof appliedSuggestionsRequestSchema>

export const appliedSuggestionsResponseSchema = z.object({
  /** Suggestions déjà appliquées et membre qui les a acceptées. */
  applied: z.array(z.object({ id: z.uuid(), decidedBy: z.string() })),
})
export type AppliedSuggestionsResponse = z.infer<typeof appliedSuggestionsResponseSchema>
