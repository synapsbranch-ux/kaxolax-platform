import { z } from 'zod'
import { sha256Schema } from './common.js'

/** Contenu texte courant d'un document, tel que le voit le service temps réel. */
export const documentSnapshotSchema = z.object({
  id: z.uuid(),
  content: z.string(),
  sha256: sha256Schema,
})
export type DocumentSnapshot = z.infer<typeof documentSnapshotSchema>

/** GET /internal/projects/:id/snapshot du service temps réel. */
export const projectSnapshotSchema = z.object({
  projectId: z.uuid(),
  documents: z.array(documentSnapshotSchema),
})
export type ProjectSnapshot = z.infer<typeof projectSnapshotSchema>

/** POST /internal/documents/:id/close du service temps réel. */
export const closeDocumentResponseSchema = z.object({ closed: z.boolean() })
export type CloseDocumentResponse = z.infer<typeof closeDocumentResponseSchema>

/** POST /internal/users/:id/disconnect du service temps réel : connexions fermées. */
export const disconnectUserResponseSchema = z.object({
  connections: z.number().int().nonnegative(),
})
export type DisconnectUserResponse = z.infer<typeof disconnectUserResponseSchema>

/** Rôle d'un membre de projet (table project_members). */
export const projectRoleSchema = z.enum(['owner', 'editor', 'reviewer', 'viewer'])
export type ProjectRole = z.infer<typeof projectRoleSchema>

/** Contenu du jeton signé par l'API pour ouvrir une connexion temps réel (valable 5 minutes). */
export const realtimeTokenClaimsSchema = z.object({
  sub: z.uuid(),
  projectId: z.uuid(),
  role: projectRoleSchema,
  /**
   * Émission, en secondes depuis l'époque Unix : un jeton émis avant la dernière révocation des
   * sessions du compte (`users.sessions_revoked_at`) est refusé.
   */
  iat: z.number().int().nonnegative(),
  /** Expiration, en secondes depuis l'époque Unix. */
  exp: z.number().int().positive(),
})
export type RealtimeTokenClaims = z.infer<typeof realtimeTokenClaimsSchema>

/** POST /projects/:id/realtime-token de l'API. */
export const realtimeTokenResponseSchema = z.object({
  token: z.string().min(1),
  url: z.string().min(1),
  expiresAt: z.iso.datetime(),
})
export type RealtimeTokenResponse = z.infer<typeof realtimeTokenResponseSchema>

export const REALTIME_TOKEN_TTL_SECONDS = 300

/**
 * POST /internal/projects/:id/members/:userId/changed du service temps réel : le rôle du membre a
 * changé ou il a été retiré. Le service relit le rôle en base et l'applique aux connexions de
 * cette instance : fermées (`closed`) s'il n'est plus membre, sinon rôle et lecture seule mis à
 * jour (`updated`).
 */
export const memberChangedResponseSchema = z.object({
  closed: z.number().int().nonnegative(),
  updated: z.number().int().nonnegative(),
})
export type MemberChangedResponse = z.infer<typeof memberChangedResponseSchema>

/**
 * Message sans état (stateless Hocuspocus) envoyé à une connexion dont le rôle vient de changer :
 * l'éditeur passe en lecture seule ou en écriture sans recharger.
 */
export const roleChangedMessageSchema = z.object({
  type: z.literal('member.role-changed'),
  role: projectRoleSchema,
  readOnly: z.boolean(),
})
export type RoleChangedMessage = z.infer<typeof roleChangedMessageSchema>

/** Code de fermeture d'une connexion retirée ou refusée (Forbidden de Hocuspocus). */
export const REALTIME_FORBIDDEN_CLOSE_CODE = 4403
