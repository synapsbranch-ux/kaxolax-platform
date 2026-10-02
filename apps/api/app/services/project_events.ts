import {
  fitProjectEvent,
  INTERNAL_TOKEN_HEADER,
  type ProjectEvent,
  projectEventResponseSchema,
} from '@kaxolax/contracts'
import logger from '@adonisjs/core/services/logger'
import realtimeConfig from '#config/realtime'

/**
 * Diffusion d'événements aux clients connectés à un projet, par le service temps réel
 * (`POST /internal/projects/:id/events`). Au mieux : un échec est journalisé, et le client garde
 * le repli par sondage (`GET /projects/:id/builds/:buildId`). Remplacé par un faux dans les tests.
 */
export default class ProjectEvents {
  async publish(event: ProjectEvent): Promise<void> {
    try {
      const response = await fetch(
        `${realtimeConfig.internalUrl}/internal/projects/${event.projectId}/events`,
        {
          method: 'POST',
          headers: {
            [INTERNAL_TOKEN_HEADER]: realtimeConfig.internalToken.release(),
            'content-type': 'application/json',
          },
          // Un résultat trop gros pour le service temps réel est remplacé par `resultOmitted`.
          body: JSON.stringify(fitProjectEvent(event)),
          signal: AbortSignal.timeout(realtimeConfig.internalTimeoutMs),
        },
      )
      if (!response.ok) throw new Error(`realtime service answered ${String(response.status)}`)
      projectEventResponseSchema.parse(await response.json())
    } catch (error) {
      logger.warn({ err: error, projectId: event.projectId }, 'could not publish project event')
    }
  }
}
