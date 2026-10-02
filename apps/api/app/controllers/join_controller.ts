import type { InvitationPreview, JoinProjectResponse, ShareLinkPreview } from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
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
    if (changed) await this.realtime.membersChanged(result.projectId, [user.id])
    return result
  }

  async shareLink({ params }: HttpContext): Promise<ShareLinkPreview> {
    return shareLinkPreview(String(params.token))
  }

  async joinWithShareLink({ params, auth }: HttpContext): Promise<JoinProjectResponse> {
    const user = auth.getUserOrFail()
    const { changed, ...result } = await joinWithShareLink(user, String(params.token))
    if (changed) await this.realtime.membersChanged(result.projectId, [user.id])
    return result
  }
}
