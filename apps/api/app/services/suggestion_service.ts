import { anchorFromBase64, isSuggestionAnchorValid } from '@kaxolax/collab'
import {
  canDecideSuggestion,
  type CreateSuggestionInput,
  type DecideSuggestionsInput,
  SUGGESTION_APPLY_BATCH,
  SUGGESTION_DECIDE_MAX,
  SUGGESTION_EDIT_RATE_LIMIT,
  SUGGESTION_ERRORS,
  SUGGESTION_OPEN_LIMIT,
  SUGGESTION_RATE_LIMIT,
  type Suggestion as SuggestionEntry,
  type SuggestionKind,
  type SuggestionOutcome,
  type SuggestionsQuery,
  type SuggestionStatus,
  type UpdateSuggestionInput,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import Document from '#models/document'
import type Project from '#models/project'
import type { ProjectRole } from '#models/project_member'
import Suggestion from '#models/suggestion'
import type User from '#models/user'
import { assertProjectStorageAvailable } from '#services/plan_enforcement'
import { isUuid, PROJECT_ACCESS_VIEW, projectFor } from '#services/project_access'
import type RealtimeClient from '#services/realtime_client'

/**
 * Suivi des modifications (contrats dans `packages/contracts/src/suggestions.ts`). Lire : tout
 * membre (`read`) ; suggérer, modifier sa suggestion ouverte, retirer sa suggestion ouverte ou
 * obsolète : `suggest` (owner, editor, reviewer) ; accepter ou refuser (une obsolète : l'écarter) :
 * `decideSuggestion` (owner, editor).
 *
 * L'API vérifie que l'ancre se lit et a la forme du type (point pour une insertion) ; c'est le
 * document Yjs qui la résout : le navigateur pour l'affichage, le service temps réel à
 * l'acceptation (`RealtimeClient.applySuggestions`), qui applique le texte proposé au nom de
 * l'auteur et répond `stale` si le texte d'origine a changé.
 *
 * Décision : les suggestions visées sont verrouillées (`FOR UPDATE`, toujours dans l'ordre de
 * création) pendant toute la décision, application par le service temps réel comprise : un double
 * clic ou deux décideurs simultanés attendent la première décision, puis trouvent les suggestions
 * décidées (`unchanged`). L'application se fait par lots : ceux que le service a confirmés sont
 * enregistrés même si un lot suivant échoue (503 ensuite) ; les autres restent ouverts. Un nouvel
 * essai n'applique pas deux fois une suggestion déjà appliquée (idempotence par identifiant, notée
 * dans le document Yjs). Un lot appliqué sans confirmation (délai dépassé) reste ouvert en base :
 * avant de refuser, de modifier ou de retirer une suggestion ouverte, l'API demande donc au service
 * si elle est déjà dans le document, et la marque alors acceptée.
 *
 * Limites : créations par fenêtre glissante, modifications et retraits par fenêtre fixe, nombre
 * de suggestions en attente par auteur et par projet ; le texte proposé passe la garde de
 * stockage du compte du projet (comme à l'acceptation).
 */

export class SuggestionNotFoundException extends Exception {
  static override status = 404
  static override code = SUGGESTION_ERRORS.notFound
  static override message = 'Suggestion not found'
}

export class SuggestionNotAuthorException extends Exception {
  static override status = 403
  static override code = SUGGESTION_ERRORS.notAuthor
  static override message = 'Only the author can change this suggestion'
}

export class SuggestionAlreadyDecidedException extends Exception {
  static override status = 409
  static override code = SUGGESTION_ERRORS.alreadyDecided
  static override message = 'The suggestion has already been decided'
}

export class SuggestionDocumentNotFoundException extends Exception {
  static override status = 404
  static override code = SUGGESTION_ERRORS.documentNotFound
  static override message = 'Document not found'
}

export class InvalidSuggestionAnchorException extends Exception {
  static override status = 422
  static override code = SUGGESTION_ERRORS.invalidAnchor
  static override message = 'The suggestion anchor cannot be read or does not match its kind'
}

export class SuggestionRealtimeUnavailableException extends Exception {
  static override status = 503
  static override code = SUGGESTION_ERRORS.realtimeUnavailable
  static override message =
    'The realtime service did not confirm the change; unconfirmed suggestions are still open. Try again in a moment.'
}

export class SuggestionOpenLimitException extends Exception {
  static override status = 409
  static override code = SUGGESTION_ERRORS.openLimit
  static override message = 'Too many pending suggestions in this project'
}

export class SuggestionRateLimitedException extends Exception {
  static override status = 429
  static override code = SUGGESTION_ERRORS.rateLimited
  static override message = 'Too many suggestions or suggestion changes, try again later'

  constructor(readonly retryAfterSeconds: number) {
    super()
  }

  handle(_error: unknown, { response }: HttpContext) {
    response.header('retry-after', String(this.retryAfterSeconds))
    response.status(429).send({
      code: SUGGESTION_ERRORS.rateLimited,
      message: this.message,
      retryAfterSeconds: this.retryAfterSeconds,
    })
  }
}

// --- Lecture -------------------------------------------------------------------------------

interface AuthorRow {
  id: string
  full_name: string | null
  avatar_url: string | null
  deleted_at: Date | null
}

function serializeAuthor(row: AuthorRow | undefined, id: string): SuggestionEntry['author'] {
  // Compte supprimé (anonymisé) ou introuvable : ni nom ni avatar.
  const visible = row?.deleted_at === null
  return {
    id,
    fullName: visible ? row.full_name : null,
    avatarUrl: visible ? row.avatar_url : null,
  }
}

function iso(value: DateTime | null): string | null {
  return value === null ? null : value.toJSDate().toISOString()
}

/** Suggestions sérialisées avec leurs auteurs et décideurs (une requête de plus). */
async function serializeSuggestions(
  suggestions: Suggestion[],
  client?: TransactionClientContract,
): Promise<SuggestionEntry[]> {
  if (suggestions.length === 0) return []
  const ids = new Set<string>()
  for (const suggestion of suggestions) {
    ids.add(suggestion.authorId)
    if (suggestion.decidedBy !== null) ids.add(suggestion.decidedBy)
  }
  const rows = (await (client ?? db)
    .from('users')
    .whereIn('id', [...ids])
    .select('id', 'full_name', 'avatar_url', 'deleted_at')) as AuthorRow[]
  const users = new Map(rows.map((row) => [row.id, row]))
  return suggestions.map((suggestion) => ({
    id: suggestion.id,
    documentId: suggestion.documentId,
    author: serializeAuthor(users.get(suggestion.authorId), suggestion.authorId),
    origin: suggestion.origin,
    kind: suggestion.kind,
    anchor: Buffer.from(suggestion.anchor).toString('base64'),
    originalText: suggestion.originalText,
    proposedText: suggestion.proposedText,
    status: suggestion.status,
    decidedBy:
      suggestion.decidedBy === null
        ? null
        : serializeAuthor(users.get(suggestion.decidedBy), suggestion.decidedBy),
    decidedAt: iso(suggestion.decidedAt),
    aiMessageId: suggestion.aiMessageId,
    createdAt: suggestion.createdAt.toJSDate().toISOString(),
  }))
}

async function serializeSuggestion(
  suggestion: Suggestion,
  client?: TransactionClientContract,
): Promise<SuggestionEntry> {
  const [entry] = await serializeSuggestions([suggestion], client)
  if (!entry) throw new SuggestionNotFoundException()
  return entry
}

const DECIDED_STATUSES: SuggestionStatus[] = ['accepted', 'rejected', 'stale']

/** Suggestions d'un projet (tout membre), de la plus ancienne à la plus récente, par page. */
export async function listSuggestions(
  user: User,
  projectId: string,
  query: SuggestionsQuery,
): Promise<{ suggestions: SuggestionEntry[]; nextCursor: string | null }> {
  const { project } = await projectFor(user, projectId, 'read')
  const rows = Suggestion.query().where('projectId', project.id)
  if (query.documentId !== undefined) void rows.where('documentId', query.documentId)
  if (query.authorId !== undefined) void rows.where('authorId', query.authorId)
  if (query.status === 'decided') void rows.whereIn('status', DECIDED_STATUSES)
  else if (query.status !== 'all') void rows.where('status', query.status)
  if (query.after !== undefined) {
    // Après le curseur (date de création, puis identifiant) : lu sans relire la suggestion, qui a
    // pu être retirée entre deux pages.
    const [micros, id] = query.after.split('_')
    void rows.whereRaw(
      "(created_at, id) > (timestamptz 'epoch' + ?::bigint * interval '1 microsecond', ?::uuid)",
      [micros ?? '0', id ?? ''],
    )
  }
  const page = await rows
    .select('*')
    .select(db.raw('(extract(epoch from created_at) * 1000000)::bigint::text AS cursor_micros'))
    .orderBy('createdAt', 'asc')
    .orderBy('id', 'asc')
    .limit(query.limit + 1)
  const hasMore = page.length > query.limit
  const visible = page.slice(0, query.limit)
  const last = visible.at(-1)
  const lastMicros: unknown = last?.$extras.cursor_micros
  return {
    suggestions: await serializeSuggestions(visible),
    nextCursor:
      hasMore && last !== undefined && typeof lastMicros === 'string'
        ? `${lastMicros}_${last.id}`
        : null,
  }
}

// --- Écriture ------------------------------------------------------------------------------

/** Ancre décodée, lisible et de la forme du type (422 sinon). */
function anchorOf(kind: SuggestionKind, anchor: string): Buffer {
  const bytes = anchorFromBase64(anchor)
  if (bytes === null || !isSuggestionAnchorValid(kind, bytes)) {
    throw new InvalidSuggestionAnchorException()
  }
  return Buffer.from(bytes)
}

/**
 * Limite de débit des créations d'un membre dans un projet, sur une fenêtre glissante, sous
 * verrou consultatif : deux requêtes simultanées ne la dépassent pas. Les frappes successives
 * d'une même suggestion passent par sa modification (`PATCH`), qui ne compte pas.
 */
async function enforceRateLimit(
  trx: TransactionClientContract,
  projectId: string,
  userId: string,
  now: DateTime,
): Promise<void> {
  await trx.rawQuery('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', [
    `suggestions:${projectId}:${userId}`,
  ])
  const windowStart = now.minus({ seconds: SUGGESTION_RATE_LIMIT.windowSeconds })
  const recent = (await trx
    .from('suggestions')
    .where('project_id', projectId)
    .where('author_id', userId)
    .where('created_at', '>', windowStart.toJSDate())
    .orderBy('created_at', 'desc')
    .limit(SUGGESTION_RATE_LIMIT.suggestions)
    .select('created_at')) as { created_at: Date }[]
  if (recent.length < SUGGESTION_RATE_LIMIT.suggestions) return
  const oldest = recent.at(-1)?.created_at.getTime() ?? now.toMillis()
  const wait = oldest + SUGGESTION_RATE_LIMIT.windowSeconds * 1000 - now.toMillis()
  throw new SuggestionRateLimitedException(Math.max(1, Math.ceil(wait / 1000)))
}

/**
 * Limite de débit des modifications et retraits (`PATCH`, `DELETE`) d'un membre dans un projet :
 * fenêtre fixe tenue en une requête (`suggestion_edit_rates`). Refusé, l'appel ne compte pas (la
 * transaction est annulée) ; chaque appel accepté est annoncé à tous les membres, qui relisent la
 * suggestion.
 */
async function enforceEditRateLimit(
  trx: TransactionClientContract,
  projectId: string,
  userId: string,
): Promise<void> {
  const result = await trx.rawQuery<{
    rows: { window_started_at: Date; edits: number; now: Date }[]
  }>(
    `INSERT INTO suggestion_edit_rates AS r (project_id, user_id, window_started_at, edits)
     VALUES (?, ?, now(), 1)
     ON CONFLICT (project_id, user_id) DO UPDATE SET
       window_started_at = CASE WHEN r.window_started_at <= now() - ?::int * interval '1 second'
         THEN now() ELSE r.window_started_at END,
       edits = CASE WHEN r.window_started_at <= now() - ?::int * interval '1 second'
         THEN 1 ELSE r.edits + 1 END
     RETURNING window_started_at, edits, now() AS now`,
    [
      projectId,
      userId,
      SUGGESTION_EDIT_RATE_LIMIT.windowSeconds,
      SUGGESTION_EDIT_RATE_LIMIT.windowSeconds,
    ],
  )
  const row = result.rows[0]
  if (!row || row.edits <= SUGGESTION_EDIT_RATE_LIMIT.edits) return
  const wait =
    row.window_started_at.getTime() +
    SUGGESTION_EDIT_RATE_LIMIT.windowSeconds * 1000 -
    row.now.getTime()
  throw new SuggestionRateLimitedException(Math.max(1, Math.ceil(wait / 1000)))
}

/**
 * Plafond des suggestions en attente (ouvertes ou obsolètes) de l'auteur dans le projet et de tout
 * le projet (409 `E_SUGGESTION_OPEN_LIMIT`). Comptes bornés au plafond (requêtes courtes).
 */
async function enforceOpenLimit(
  trx: TransactionClientContract,
  projectId: string,
  userId: string,
): Promise<void> {
  const result = await trx.rawQuery<{ rows: { author: number; project: number }[] }>(
    `SELECT
       (SELECT count(*)::int FROM (SELECT 1 FROM suggestions
          WHERE project_id = ? AND author_id = ? AND status IN ('open', 'stale') LIMIT ?) a) AS author,
       (SELECT count(*)::int FROM (SELECT 1 FROM suggestions
          WHERE project_id = ? AND status IN ('open', 'stale') LIMIT ?) p) AS project`,
    [
      projectId,
      userId,
      SUGGESTION_OPEN_LIMIT.perAuthor,
      projectId,
      SUGGESTION_OPEN_LIMIT.perProject,
    ],
  )
  const row = result.rows[0]
  if (
    row &&
    (row.author >= SUGGESTION_OPEN_LIMIT.perAuthor ||
      row.project >= SUGGESTION_OPEN_LIMIT.perProject)
  ) {
    throw new SuggestionOpenLimitException()
  }
}

/** Suggestion écrite ou retirée, à annoncer sur le document meta. */
export interface SuggestionChange {
  project: Project
  suggestion: SuggestionEntry
}

/**
 * Crée une suggestion (permission `suggest`). `ai` : proposée par l'assistant au nom de
 * l'utilisateur qui l'a sollicité (message de l'assistant en `aiMessageId`).
 */
export async function createSuggestion(
  user: User,
  projectId: string,
  input: CreateSuggestionInput,
  options: { ai?: { messageId: string | null } } = {},
): Promise<SuggestionChange> {
  const anchor = anchorOf(input.kind, input.anchor)
  return db.transaction(async (trx) => {
    const { project } = await projectFor(user, projectId, 'suggest', { trx })
    const document = await Document.query({ client: trx })
      .where({ projectId: project.id, id: input.documentId })
      .first()
    if (!document) throw new SuggestionDocumentNotFoundException()
    const now = DateTime.now()
    await enforceRateLimit(trx, project.id, user.id, now)
    await enforceOpenLimit(trx, project.id, user.id)
    // Le texte proposé est stocké pour le compte du projet : refusé si son stockage est plein.
    const proposed = byteLength(input.proposedText)
    if (proposed > 0) await assertProjectStorageAvailable(project, proposed, { requester: user })
    const suggestion = await Suggestion.create(
      {
        projectId: project.id,
        documentId: document.id,
        authorId: user.id,
        origin: options.ai ? 'ai' : 'user',
        kind: input.kind,
        anchor,
        originalText: input.originalText,
        proposedText: input.proposedText,
        status: 'open',
        decidedBy: null,
        decidedAt: null,
        aiMessageId: options.ai?.messageId ?? null,
        createdAt: now,
      },
      { client: trx },
    )
    return { project, suggestion: await serializeSuggestion(suggestion, trx) }
  })
}

/**
 * Suggestion de l'auteur, verrouillée, dans un des statuts permis (404, 403 pour un autre auteur,
 * 409 sinon).
 */
async function ownSuggestion(
  trx: TransactionClientContract,
  projectId: string,
  suggestionId: string,
  user: User,
  statuses: readonly SuggestionStatus[],
): Promise<Suggestion> {
  if (!isUuid(suggestionId)) throw new SuggestionNotFoundException()
  const suggestion = await Suggestion.query({ client: trx })
    .where({ projectId, id: suggestionId })
    .forUpdate()
    .first()
  if (!suggestion) throw new SuggestionNotFoundException()
  if (suggestion.authorId !== user.id) throw new SuggestionNotAuthorException()
  if (!statuses.includes(suggestion.status)) throw new SuggestionAlreadyDecidedException()
  return suggestion
}

/** Une suggestion du projet (tout membre). */
export async function showSuggestion(
  user: User,
  projectId: string,
  suggestionId: string,
): Promise<SuggestionEntry> {
  const { project } = await projectFor(user, projectId, 'read')
  if (!isUuid(suggestionId)) throw new SuggestionNotFoundException()
  const suggestion = await Suggestion.query()
    .where({ projectId: project.id, id: suggestionId })
    .first()
  if (!suggestion) throw new SuggestionNotFoundException()
  return serializeSuggestion(suggestion)
}

/**
 * Remplace sa suggestion ouverte (permission `suggest`) : frappes successives fusionnées par
 * l'éditeur (`recordSuggestionEdit` de `@kaxolax/collab`). Même document. Une suggestion déjà
 * appliquée au document (acceptation interrompue) n'est pas modifiée : le texte appliqué est
 * l'ancien ; elle est marquée acceptée (`accepted` : à annoncer, puis 409). 503 si le service
 * temps réel ne peut pas le dire : rien ne change.
 */
export async function updateSuggestion(
  user: User,
  projectId: string,
  suggestionId: string,
  input: UpdateSuggestionInput,
  realtime: RealtimeClient,
): Promise<SuggestionChange & { accepted: { decidedBy: string } | null }> {
  const anchor = anchorOf(input.kind, input.anchor)
  return db.transaction(async (trx) => {
    const { project, role } = await projectFor(user, projectId, 'suggest', { trx })
    await enforceEditRateLimit(trx, project.id, user.id)
    const suggestion = await ownSuggestion(trx, project.id, suggestionId, user, ['open'])
    const accepted = await acceptIfApplied(trx, realtime, project, suggestion, user, role)
    if (accepted !== null) return accepted
    const growth = byteLength(input.proposedText) - byteLength(suggestion.proposedText)
    if (growth > 0) await assertProjectStorageAvailable(project, growth, { requester: user })
    suggestion.kind = input.kind
    suggestion.anchor = anchor
    suggestion.originalText = input.originalText
    suggestion.proposedText = input.proposedText
    await suggestion.useTransaction(trx).save()
    return { project, suggestion: await serializeSuggestion(suggestion, trx), accepted: null }
  })
}

/**
 * Suggestion ouverte de l'auteur trouvée déjà appliquée au document (acceptation interrompue, voir
 * l'en-tête du module) : marquée acceptée, à annoncer (`accepted`) avant de répondre 409. Null si
 * elle n'est pas dans le document. 503 si le service temps réel ne peut pas le dire.
 */
async function acceptIfApplied(
  trx: TransactionClientContract,
  realtime: RealtimeClient,
  project: Project,
  suggestion: Suggestion,
  user: User,
  role: ProjectRole,
): Promise<(SuggestionChange & { accepted: { decidedBy: string } }) | null> {
  const fallback = authorFallback(project, user, role)
  const applied = await appliedDeciders(trx, realtime, project, [suggestion], fallback)
  const decidedBy = applied.get(suggestion.id)
  if (decidedBy === undefined) return null
  suggestion.status = 'accepted'
  suggestion.decidedBy = decidedBy
  suggestion.decidedAt = DateTime.now()
  await suggestion.useTransaction(trx).save()
  return {
    project,
    suggestion: await serializeSuggestion(suggestion, trx),
    accepted: { decidedBy },
  }
}

/**
 * Retire sa suggestion ouverte ou obsolète (permission `suggest`). Une suggestion ouverte déjà
 * appliquée au document (acceptation interrompue, voir l'en-tête du module) n'est pas retirée :
 * elle est marquée acceptée (`accepted` : à annoncer, puis 409). 503 si le service temps réel ne
 * peut pas le dire : rien ne change.
 */
export async function deleteSuggestion(
  user: User,
  projectId: string,
  suggestionId: string,
  realtime: RealtimeClient,
): Promise<SuggestionChange & { accepted: { decidedBy: string } | null }> {
  return db.transaction(async (trx) => {
    const { project, role } = await projectFor(user, projectId, 'suggest', { trx })
    await enforceEditRateLimit(trx, project.id, user.id)
    const suggestion = await ownSuggestion(trx, project.id, suggestionId, user, ['open', 'stale'])
    if (suggestion.status === 'open') {
      const accepted = await acceptIfApplied(trx, realtime, project, suggestion, user, role)
      if (accepted !== null) return accepted
    }
    const entry = await serializeSuggestion(suggestion, trx)
    await suggestion.useTransaction(trx).delete()
    return { project, suggestion: entry, accepted: null }
  })
}

// --- Décision ------------------------------------------------------------------------------

/** Résultat d'une décision : réponse de la route et décisions à annoncer. */
export interface SuggestionDecisionResult {
  project: Project
  results: { id: string; outcome: SuggestionOutcome }[]
  suggestions: SuggestionEntry[]
  remaining: number
  /** Suggestions décidées par cette requête (événement `suggestion.decided`). */
  decided: { suggestionId: string; documentId: string; status: 'accepted' | 'rejected' | 'stale' }[]
  /**
   * Faux si le service temps réel n'a pas confirmé toutes les acceptations : celles confirmées
   * sont enregistrées (à annoncer), puis l'appelant répond 503.
   */
  complete: boolean
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, 'utf8')
}

/**
 * Applique les suggestions acceptées par le service temps réel, document par document et par lots
 * (`SUGGESTION_APPLY_BATCH`) : statut final de chacune (`accepted` ou `stale`). Au premier lot sans
 * réponse, s'arrête (`complete` faux) : les statuts des lots confirmés sont enregistrés par
 * l'appelant, les autres suggestions restent ouvertes.
 */
async function applyAccepted(
  realtime: RealtimeClient,
  project: Project,
  user: User,
  suggestions: Suggestion[],
): Promise<{ statuses: Map<string, 'accepted' | 'stale'>; complete: boolean }> {
  const growth = suggestions.reduce(
    (sum, suggestion) =>
      sum + byteLength(suggestion.proposedText) - byteLength(suggestion.originalText),
    0,
  )
  // Le texte accepté entre dans le stockage du compte du projet (comme une frappe).
  if (growth > 0) await assertProjectStorageAvailable(project, growth, { requester: user })
  const statuses = new Map<string, 'accepted' | 'stale'>()
  for (const [documentId, list] of byDocument(suggestions)) {
    for (let start = 0; start < list.length; start += SUGGESTION_APPLY_BATCH) {
      const batch = list.slice(start, start + SUGGESTION_APPLY_BATCH)
      const response = await realtime.applySuggestions(project.id, documentId, {
        decidedBy: user.id,
        suggestions: batch.map((suggestion) => ({
          id: suggestion.id,
          authorId: suggestion.authorId,
          kind: suggestion.kind,
          anchor: Buffer.from(suggestion.anchor).toString('base64'),
          originalText: suggestion.originalText,
          proposedText: suggestion.proposedText,
        })),
      })
      if (response === null) return { statuses, complete: false }
      const ids = new Set(batch.map((suggestion) => suggestion.id))
      for (const result of response.results) {
        if (!ids.has(result.id)) continue
        statuses.set(result.id, result.outcome === 'stale' ? 'stale' : 'accepted')
      }
      // Une suggestion absente de la réponse n'a pas été confirmée : elle reste ouverte.
      if (batch.some((suggestion) => !statuses.has(suggestion.id))) {
        return { statuses, complete: false }
      }
    }
  }
  return { statuses, complete: true }
}

function byDocument(suggestions: readonly Suggestion[]): Map<string, Suggestion[]> {
  const groups = new Map<string, Suggestion[]>()
  for (const suggestion of suggestions) {
    const list = groups.get(suggestion.documentId) ?? []
    list.push(suggestion)
    groups.set(suggestion.documentId, list)
  }
  return groups
}

/**
 * Suggestions ouvertes déjà appliquées au document (acceptation interrompue après l'application),
 * avec le membre qui les a acceptées. La map du document n'est écrite que par le service temps
 * réel (les écritures des clients y sont annulées) ; par prudence, le décideur lu n'est gardé que
 * s'il est encore membre du projet avec la permission `decideSuggestion` (sinon `fallback` : ni
 * compte quelconque inscrit au journal, ni profil d'un non-membre exposé). 503 si le service temps
 * réel ne répond pas : l'appelant n'a rien changé.
 */
async function appliedDeciders(
  trx: TransactionClientContract,
  realtime: RealtimeClient,
  project: Project,
  suggestions: readonly Suggestion[],
  fallback: string,
): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (const [documentId, list] of byDocument(suggestions)) {
    for (let start = 0; start < list.length; start += SUGGESTION_DECIDE_MAX) {
      const ids = list.slice(start, start + SUGGESTION_DECIDE_MAX).map((entry) => entry.id)
      const response = await realtime.appliedSuggestions(project.id, documentId, ids)
      if (response === null) throw new SuggestionRealtimeUnavailableException()
      const wanted = new Set(ids)
      for (const entry of response.applied) {
        if (wanted.has(entry.id)) found.set(entry.id, entry.decidedBy)
      }
    }
  }
  if (found.size === 0) return found
  const candidates = [...new Set(found.values())].filter(isUuid)
  const members =
    candidates.length === 0
      ? []
      : ((await trx
          .from(PROJECT_ACCESS_VIEW)
          .where('project_id', project.id)
          .whereIn('user_id', candidates)
          .select('user_id', 'role')) as { user_id: string; role: ProjectRole }[])
  const deciders = new Set(
    members.filter((row) => canDecideSuggestion(row.role)).map((row) => row.user_id),
  )
  return new Map(
    [...found].map(([id, decidedBy]) => [id, deciders.has(decidedBy) ? decidedBy : fallback]),
  )
}

/**
 * Décideur de repli pour une suggestion trouvée déjà appliquée lors d'un retrait ou d'une
 * modification par son auteur : lui-même s'il peut décider, sinon le propriétaire du projet.
 */
function authorFallback(project: Project, user: User, role: ProjectRole): string {
  return canDecideSuggestion(role) ? user.id : project.ownerId
}

/**
 * Accepte ou refuse des suggestions (permission `decideSuggestion`) : une liste d'identifiants,
 * toutes les suggestions ouvertes ou celles d'un auteur (au plus `SUGGESTION_DECIDE_MAX`, le reste
 * dans `remaining`). Un refus vise aussi les suggestions obsolètes (écartées : `rejected`). Voir
 * l'en-tête du module pour le verrouillage, l'idempotence et les acceptations interrompues.
 */
export async function decideSuggestions(
  user: User,
  projectId: string,
  input: DecideSuggestionsInput,
  realtime: RealtimeClient,
): Promise<SuggestionDecisionResult> {
  // Accepter : les suggestions ouvertes ; refuser : aussi les obsolètes (écartées).
  const decidable: SuggestionStatus[] = input.decision === 'accept' ? ['open'] : ['open', 'stale']
  return db.transaction(async (trx) => {
    const { project } = await projectFor(user, projectId, 'decideSuggestion', { trx })
    const target = () => {
      const query = Suggestion.query({ client: trx }).where('projectId', project.id)
      if (input.ids !== undefined) return query.whereIn('id', input.ids)
      void query.whereIn('status', decidable)
      if (input.authorId !== undefined) void query.where('authorId', input.authorId)
      if (input.documentId !== undefined) void query.where('documentId', input.documentId)
      return query
    }
    // Toujours dans le même ordre : deux décisions simultanées ne s'interbloquent pas.
    const locked = target().orderBy('createdAt', 'asc').orderBy('id', 'asc').forUpdate()
    if (input.ids === undefined) void locked.limit(SUGGESTION_DECIDE_MAX)
    const rows = await locked
    const pending = rows.filter((row) => decidable.includes(row.status))

    let complete = true
    const statuses = new Map<string, 'accepted' | 'rejected' | 'stale'>()
    // Décideur d'une suggestion trouvée déjà appliquée lors d'un refus (sinon `user`).
    const deciders = new Map<string, string>()
    if (input.decision === 'accept') {
      const applied = await applyAccepted(realtime, project, user, pending)
      complete = applied.complete
      for (const [id, status] of applied.statuses) statuses.set(id, status)
    } else {
      const open = pending.filter((row) => row.status === 'open')
      const applied =
        open.length === 0
          ? new Map<string, string>()
          : await appliedDeciders(trx, realtime, project, open, user.id)
      for (const row of pending) {
        const decidedBy = applied.get(row.id)
        if (decidedBy === undefined) {
          statuses.set(row.id, 'rejected')
        } else {
          statuses.set(row.id, 'accepted')
          deciders.set(row.id, decidedBy)
        }
      }
    }

    const now = DateTime.now()
    const groups = new Map<
      string,
      { status: 'accepted' | 'rejected' | 'stale'; decidedBy: string | null; ids: string[] }
    >()
    for (const row of pending) {
      const status = statuses.get(row.id)
      if (status === undefined) continue
      const decidedBy = status === 'stale' ? null : (deciders.get(row.id) ?? user.id)
      const key = `${status}:${decidedBy ?? ''}`
      const group = groups.get(key) ?? { status, decidedBy, ids: [] }
      group.ids.push(row.id)
      groups.set(key, group)
    }
    for (const { status, decidedBy, ids } of groups.values()) {
      await trx.from('suggestions').whereIn('id', ids).update({
        status,
        decided_by: decidedBy,
        decided_at: now.toJSDate(),
        updated_at: now.toJSDate(),
      })
    }

    let remaining = 0
    if (input.ids === undefined) {
      const counted = trx
        .from('suggestions')
        .where('project_id', project.id)
        .whereIn('status', decidable)
      if (input.authorId !== undefined) void counted.where('author_id', input.authorId)
      if (input.documentId !== undefined) void counted.where('document_id', input.documentId)
      const row = (await counted.count('* as total').first()) as { total: string | number } | null
      remaining = Number(row?.total ?? 0)
    }
    const fresh =
      rows.length === 0
        ? []
        : await Suggestion.query({ client: trx })
            .whereIn(
              'id',
              rows.map((row) => row.id),
            )
            .orderBy('createdAt', 'asc')
            .orderBy('id', 'asc')
    const outcomeOf = (id: string): SuggestionOutcome => {
      const status = statuses.get(id)
      if (status !== undefined) return status
      return rows.some((row) => row.id === id) ? 'unchanged' : 'missing'
    }
    const ids = input.ids ? [...new Set(input.ids)] : rows.map((row) => row.id)
    const decided = pending.flatMap((row) => {
      const status = statuses.get(row.id)
      return status === undefined
        ? []
        : [{ suggestionId: row.id, documentId: row.documentId, status }]
    })
    logger.info(
      {
        projectId: project.id,
        userId: user.id,
        decision: input.decision,
        target: input.ids ? 'ids' : input.all ? 'all' : 'author',
        accepted: decided.filter((entry) => entry.status === 'accepted').length,
        rejected: decided.filter((entry) => entry.status === 'rejected').length,
        stale: decided.filter((entry) => entry.status === 'stale').length,
        complete,
      },
      'suggestions decided',
    )
    return {
      project,
      results: ids.map((id) => ({ id, outcome: outcomeOf(id) })),
      suggestions: await serializeSuggestions(fresh, trx),
      remaining,
      decided,
      complete,
    }
  })
}
