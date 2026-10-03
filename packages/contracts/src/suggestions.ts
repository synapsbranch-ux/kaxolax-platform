import { z } from 'zod'
import { chatAuthorSchema } from './chat.js'
import { COMMENT_ANCHOR_MAX_LENGTH } from './comments.js'

/**
 * Suivi des modifications : suggestions d'insertion, de suppression ou de remplacement, faites
 * par un membre (mode Suggérer) ou par l'IA (au nom de l'utilisateur qui l'a sollicitée). Le texte
 * du document ne change qu'à l'acceptation. Schéma et contrats posés par la tâche 1 (socle) ;
 * routes, temps réel et interface : tâche 2.
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

/** Création d'une suggestion par un membre (tâche 2) ; réponse 201 : la suggestion. */
export const createSuggestionInputSchema = z
  .strictObject({
    documentId: z.uuid(),
    kind: suggestionKindSchema,
    anchor: anchorSchema,
    originalText: textSchema.default(''),
    proposedText: textSchema.default(''),
  })
  .refine((input) => suggestionTextsMatchKind(input.kind, input.originalText, input.proposedText), {
    message: 'The texts do not match the kind of suggestion',
    path: ['kind'],
  })
export type CreateSuggestionInput = z.infer<typeof createSuggestionInputSchema>
