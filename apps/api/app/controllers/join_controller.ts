import type { InvitationPreview, JoinProjectResponse, ShareLinkPreview } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import { joinEvent } from '#services/project_events'
import RealtimeClient from '#services/realtime_client'
import {
  acceptInvitation,
  invitationPreview,
  joinWithShareLink,
  shareLinkPreview,
} from '#services/sharing_service'

/**
 * Accès à un projet par jeton : invitation par email et lien de partage. Les aperçus sont publics
 * et ne donnent que le nom du projet, le rôle (et le nom de l'invitant) ; rejoindre exige d'être
 * connecté.
 */
@inject()
export default class JoinController {
  constructor(private readonly realtime: RealtimeClient) {}

  async invitation({ params }: HttpContext): Promise<InvitationPreview> {
    return invitationPreview(String(params.token))
  }

  async acceptInvitation({ params, auth }: HttpContext): Promise<JoinProjectResponse> {
    const user = auth.getUserOrFail()
    const { changed, ...result } = await acceptInvitation(user, String(params.token))
    await this.membershipChanged(user.id, result, changed)
    return result
  }

  async shareLink({ params }: HttpContext): Promise<ShareLinkPreview> {
    return shareLinkPreview(String(params.token))
  }

  async joinWithShareLink({ params, auth }: HttpContext): Promise<JoinProjectResponse> {
    const user = auth.getUserOrFail()
    const { changed, ...result } = await joinWithShareLink(user, String(params.token))
    await this.membershipChanged(user.id, result, changed)
    return result
  }

  /**
   * Après validation : un rôle relevé (`changed`) est appliqué aux connexions ouvertes ; une
   * arrivée ou un rôle relevé est annoncé aux membres connectés.
   */
  private async membershipChanged(
    userId: string,
    result: JoinProjectResponse,
    changed: boolean,
  ): Promise<void> {
    if (changed) await this.realtime.membersChanged(result.projectId, [userId])
    const event = joinEvent(userId, result, changed)
    if (event) await this.realtime.publishProjectEvent(result.projectId, event)
  }
}
