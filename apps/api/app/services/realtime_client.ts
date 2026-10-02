import { signRealtimeToken } from '@kaxolax/collab/token'
import {
  type ActiveBanner,
  type BroadcastEvent,
  closeDocumentResponseSchema,
  disconnectUserResponseSchema,
  fitProjectEvent,
  INTERNAL_TOKEN_HEADER,
  memberChangedResponseSchema,
  type ProjectEvent,
  type ProjectSnapshot,
  projectSnapshotSchema,
  publishEventResponseSchema,
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
   * Le rôle de ces membres a changé, ou ils ont été retirés du projet : le service temps réel relit
   * leur rôle en base et l'applique à leurs connexions ouvertes (fermeture, lecture seule ou
   * écriture). À appeler une fois la transaction validée. Au mieux : un échec est journalisé ; le
   * service relit de toute façon le rôle à la prochaine mise à jour d'un rédacteur et
   * périodiquement pour toutes les connexions.
   */
  async membersChanged(projectId: string, userIds: readonly string[]): Promise<void> {
    await Promise.all(
      [...new Set(userIds)].map(async (userId) => {
        try {
          const response = await fetch(
            `${realtimeConfig.internalUrl}/internal/projects/${projectId}/members/${userId}/changed`,
            {
              method: 'POST',
              headers: { [INTERNAL_TOKEN_HEADER]: realtimeConfig.internalToken.release() },
              signal: AbortSignal.timeout(realtimeConfig.internalTimeoutMs),
            },
          )
          if (!response.ok) throw new Error(`realtime service answered ${String(response.status)}`)
          memberChangedResponseSchema.parse(await response.json())
        } catch (error) {
          logger.warn({ err: error, projectId, userId }, 'could not notify realtime member change')
        }
      }),
    )
  }

  /**
   * Une bannière système a été créée, modifiée ou supprimée ; `active` : les bannières actives
   * maintenant. Diffusée en direct à tous les clients connectés à un document meta ; les
   * navigateurs relisent aussi `GET /banners/active` (toutes les 60 s et au retour sur l'onglet).
   */
  async notifyBannerChanged(active: readonly ActiveBanner[]): Promise<void> {
    await this.broadcastEvent({ type: 'banner.changed', banners: [...active] })
  }

  /**
   * Publie un événement sur le document meta d'un projet (`@kaxolax/contracts`, events) : tous les
   * clients connectés au projet le reçoivent, quelle que soit l'instance du service temps réel. À
   * appeler une fois la transaction validée. Au mieux : un échec est journalisé, jamais propagé
   * (pour une compilation, le client garde le repli par sondage `GET /projects/:id/builds/:id`).
   */
  async publishProjectEvent(projectId: string, event: ProjectEvent): Promise<void> {
    await this.publish(`/internal/projects/${projectId}/events`, event, { projectId })
  }

  /** Publie un événement à tous les clients connectés, tous projets confondus (au mieux). */
  async broadcastEvent(event: BroadcastEvent): Promise<void> {
    await this.publish('/internal/events', event, {})
  }

  private async publish(
    path: string,
    event: ProjectEvent,
    logContext: Record<string, string>,
  ): Promise<void> {
    try {
      const response = await fetch(`${realtimeConfig.internalUrl}${path}`, {
        method: 'POST',
        headers: {
          [INTERNAL_TOKEN_HEADER]: realtimeConfig.internalToken.release(),
          'content-type': 'application/json',
        },
        // Un résultat de compilation trop gros pour le service temps réel est remplacé par
        // `resultOmitted` : le client le relit par l'API.
        body: JSON.stringify({ event: fitProjectEvent(event) }),
        signal: AbortSignal.timeout(realtimeConfig.internalTimeoutMs),
      })
      if (!response.ok) throw new Error(`realtime service answered ${String(response.status)}`)
      publishEventResponseSchema.parse(await response.json())
    } catch (error) {
      logger.warn(
        { err: error, ...logContext, type: event.type },
        'could not publish realtime event',
      )
    }
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
