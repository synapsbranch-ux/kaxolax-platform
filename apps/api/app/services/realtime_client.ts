import { userChannelName } from '@kaxolax/collab'
import { signRealtimeToken, signUserRealtimeToken } from '@kaxolax/collab/token'
import {
  type ActiveBanner,
  type AppliedSuggestionsResponse,
  appliedSuggestionsResponseSchema,
  type ApplySuggestionsRequest,
  type ApplySuggestionsResponse,
  applySuggestionsResponseSchema,
  type BroadcastEvent,
  closeDocumentResponseSchema,
  disconnectUserResponseSchema,
  fitProjectEvent,
  flushUpdatesResponseSchema,
  INTERNAL_TOKEN_HEADER,
  memberChangedResponseSchema,
  type ProjectEvent,
  type ProjectSnapshot,
  projectSnapshotSchema,
  publishEventResponseSchema,
  type ProjectRole,
  REALTIME_TOKEN_TTL_SECONDS,
  type RealtimeTokenResponse,
  type ReplaceDocumentRequest,
  type ReplaceDocumentResponse,
  replaceDocumentResponseSchema,
  type UserRealtimeTokenResponse,
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
   * Jeton court (5 minutes) du canal temps réel de l'utilisateur (`user:{id}`), ouvert par toutes
   * les pages connectées : bannière système en direct. Il n'ouvre aucun document de projet.
   */
  issueUserToken(userId: string): UserRealtimeTokenResponse {
    const iat = Math.floor(Date.now() / 1000)
    const exp = iat + REALTIME_TOKEN_TTL_SECONDS
    return {
      token: signUserRealtimeToken(
        { scope: 'user', sub: userId, iat, exp },
        realtimeConfig.tokenSecret.release(),
      ),
      url: realtimeConfig.publicUrl,
      expiresAt: new Date(exp * 1000).toISOString(),
      name: userChannelName(userId),
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
   * maintenant. Diffusée en direct à toutes les pages connectées (canal de l'utilisateur, et
   * document meta d'un projet ouvert) ; les navigateurs relisent aussi `GET /banners/active`
   * (toutes les 60 s, au retour sur l'onglet et à chaque reconnexion du canal).
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
   * Historique : fait écrire tout de suite dans le journal les mises à jour Yjs en attente du
   * projet (avant une version de compilation ou de restauration). Au mieux : sinon, elles entrent
   * dans la version suivante.
   */
  async flushUpdates(projectId: string): Promise<void> {
    try {
      const response = await fetch(
        `${realtimeConfig.internalUrl}/internal/projects/${projectId}/updates/flush`,
        {
          method: 'POST',
          headers: { [INTERNAL_TOKEN_HEADER]: realtimeConfig.internalToken.release() },
          // L'instance attend aussi les autres instances (jusqu'à 2 s) : délai de l'instantané.
          signal: AbortSignal.timeout(realtimeConfig.snapshotTimeoutMs),
        },
      )
      if (!response.ok) throw new Error(`realtime service answered ${String(response.status)}`)
      flushUpdatesResponseSchema.parse(await response.json())
    } catch (error) {
      logger.warn({ err: error, projectId }, 'could not flush realtime updates')
    }
  }

  /**
   * Restauration : remplace le texte d'un document par le service temps réel (modification Yjs
   * minimale reçue par les clients connectés, attribuée à `userId`). Null si le service n'a pas
   * répondu ou ne connaît pas le document : l'appelant n'applique alors pas la restauration.
   */
  async replaceDocument(
    projectId: string,
    documentId: string,
    request: ReplaceDocumentRequest,
  ): Promise<ReplaceDocumentResponse | null> {
    try {
      const response = await fetch(
        `${realtimeConfig.internalUrl}/internal/projects/${projectId}/documents/${documentId}/replace`,
        {
          method: 'POST',
          headers: {
            [INTERNAL_TOKEN_HEADER]: realtimeConfig.internalToken.release(),
            'content-type': 'application/json',
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(realtimeConfig.snapshotTimeoutMs),
        },
      )
      if (!response.ok) throw new Error(`realtime service answered ${String(response.status)}`)
      return replaceDocumentResponseSchema.parse(await response.json())
    } catch (error) {
      logger.warn({ err: error, projectId, documentId }, 'could not replace realtime document')
      return null
    }
  }

  /**
   * Suivi des modifications : applique des suggestions acceptées au document en cours d'édition
   * (chacune au nom de son auteur dans l'historique, idempotent par identifiant). Null si le
   * service n'a pas répondu, refuse le décideur ou ne connaît pas le document : l'appelant ne
   * marque alors rien comme accepté (un nouvel essai n'applique pas deux fois).
   */
  async applySuggestions(
    projectId: string,
    documentId: string,
    request: ApplySuggestionsRequest,
  ): Promise<ApplySuggestionsResponse | null> {
    try {
      const response = await fetch(
        `${realtimeConfig.internalUrl}/internal/projects/${projectId}/documents/${documentId}/suggestions/apply`,
        {
          method: 'POST',
          headers: {
            [INTERNAL_TOKEN_HEADER]: realtimeConfig.internalToken.release(),
            'content-type': 'application/json',
          },
          body: JSON.stringify(request),
          // Rattrapage des autres instances compris (comme l'instantané).
          signal: AbortSignal.timeout(realtimeConfig.snapshotTimeoutMs),
        },
      )
      if (!response.ok) throw new Error(`realtime service answered ${String(response.status)}`)
      return applySuggestionsResponseSchema.parse(await response.json())
    } catch (error) {
      logger.warn({ err: error, projectId, documentId }, 'could not apply suggestions')
      return null
    }
  }

  /**
   * Suggestions déjà appliquées au document parmi `ids` (acceptation interrompue après
   * l'application), avec le membre qui les a acceptées. Null si le service n'a pas répondu ou
   * n'a pas pu rattraper les autres instances : l'appelant ne refuse ni ne retire rien.
   */
  async appliedSuggestions(
    projectId: string,
    documentId: string,
    ids: string[],
  ): Promise<AppliedSuggestionsResponse | null> {
    try {
      const response = await fetch(
        `${realtimeConfig.internalUrl}/internal/projects/${projectId}/documents/${documentId}/suggestions/applied`,
        {
          method: 'POST',
          headers: {
            [INTERNAL_TOKEN_HEADER]: realtimeConfig.internalToken.release(),
            'content-type': 'application/json',
          },
          body: JSON.stringify({ ids }),
          signal: AbortSignal.timeout(realtimeConfig.snapshotTimeoutMs),
        },
      )
      if (!response.ok) throw new Error(`realtime service answered ${String(response.status)}`)
      return appliedSuggestionsResponseSchema.parse(await response.json())
    } catch (error) {
      logger.warn({ err: error, projectId, documentId }, 'could not read applied suggestions')
      return null
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
