import { signRealtimeToken } from '@kaxolax/collab/token'
import {
  closeDocumentResponseSchema,
  INTERNAL_TOKEN_HEADER,
  type ProjectRole,
  REALTIME_TOKEN_TTL_SECONDS,
  type RealtimeTokenResponse,
} from '@kaxolax/contracts'
import logger from '@adonisjs/core/services/logger'
import realtimeConfig from '#config/realtime'

/** Échanges de l'API avec le service temps réel. Remplacé par un faux dans les tests. */
export default class RealtimeClient {
  /** Jeton court (5 minutes) : il ouvre les connexions WebSocket aux documents d'un projet. */
  issueToken(userId: string, projectId: string, role: ProjectRole): RealtimeTokenResponse {
    const exp = Math.floor(Date.now() / 1000) + REALTIME_TOKEN_TTL_SECONDS
    return {
      token: signRealtimeToken(
        { sub: userId, projectId, role, exp },
        realtimeConfig.tokenSecret.release(),
      ),
      url: realtimeConfig.publicUrl,
      expiresAt: new Date(exp * 1000).toISOString(),
    }
  }

  /**
   * Ferme les connexions ouvertes sur des documents supprimés. Au mieux : un échec est journalisé,
   * et une reconnexion est de toute façon refusée puisque le document n'existe plus en base.
   */
  async closeDocuments(documentIds: readonly string[]): Promise<void> {
    await Promise.all(
      documentIds.map(async (documentId) => {
        try {
          const response = await fetch(
            `${realtimeConfig.internalUrl}/internal/documents/${documentId}/close`,
            {
              method: 'POST',
              headers: { [INTERNAL_TOKEN_HEADER]: realtimeConfig.internalToken.release() },
              signal: AbortSignal.timeout(realtimeConfig.internalTimeoutMs),
            },
          )
          if (!response.ok) throw new Error(`realtime service answered ${String(response.status)}`)
          closeDocumentResponseSchema.parse(await response.json())
        } catch (error) {
          logger.warn({ err: error, documentId }, 'could not close realtime document')
        }
      }),
    )
  }
}
