import { signRealtimeToken } from '@kaxolax/collab/token'
import {
  type ActiveBanner,
  closeDocumentResponseSchema,
  disconnectUserResponseSchema,
  INTERNAL_TOKEN_HEADER,
  type ProjectSnapshot,
  projectSnapshotSchema,
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
    const iat = Math.floor(Date.now() / 1000)
    const exp = iat + REALTIME_TOKEN_TTL_SECONDS
    return {
      token: signRealtimeToken(
        { sub: userId, projectId, role, iat, exp },
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

  /**
   * Ferme toutes les connexions d'un utilisateur, sur tous les documents (compte banni, sessions
   * révoquées, compte supprimé). Au mieux : renvoie le nombre de connexions fermées, ou null si le
   * service n'a pas répondu ; une reconnexion est de toute façon refusée à un compte banni.
   */
  async disconnectUser(userId: string): Promise<number | null> {
    try {
      const response = await fetch(
        `${realtimeConfig.internalUrl}/internal/users/${userId}/disconnect`,
        {
          method: 'POST',
          headers: { [INTERNAL_TOKEN_HEADER]: realtimeConfig.internalToken.release() },
          signal: AbortSignal.timeout(realtimeConfig.internalTimeoutMs),
        },
      )
      if (!response.ok) throw new Error(`realtime service answered ${String(response.status)}`)
      return disconnectUserResponseSchema.parse(await response.json()).connections
    } catch (error) {
      logger.warn({ err: error, userId }, 'could not disconnect realtime user')
      return null
    }
  }

  /**
   * Une bannière système a été créée, modifiée ou supprimée ; `active` : les bannières actives
   * maintenant. Pour l'instant les navigateurs relisent `GET /banners/active` (toutes les 60 s et
   * au retour sur l'onglet) ; la diffusion en direct passera par le document meta de chaque projet
   * (tâche 5) et sera branchée ici.
   */
  notifyBannerChanged(active: readonly ActiveBanner[]): Promise<void> {
    logger.debug({ active: active.length }, 'system banners changed')
    return Promise.resolve()
  }

  /**
   * Texte courant de chaque document, modifications pas encore enregistrées comprises. Null si le
   * service ne répond pas : l'appelant se rabat alors sur l'état enregistré en base.
   */
  async snapshot(projectId: string): Promise<ProjectSnapshot | null> {
    try {
      const response = await fetch(
        `${realtimeConfig.internalUrl}/internal/projects/${projectId}/snapshot`,
        {
          headers: { [INTERNAL_TOKEN_HEADER]: realtimeConfig.internalToken.release() },
          signal: AbortSignal.timeout(realtimeConfig.snapshotTimeoutMs),
        },
      )
      if (!response.ok) throw new Error(`realtime service answered ${String(response.status)}`)
      return projectSnapshotSchema.parse(await response.json())
    } catch (error) {
      logger.warn({ err: error, projectId }, 'realtime snapshot unavailable, using stored content')
      return null
    }
  }
}
