import {
  type InvitationResponse,
  type MemberResponse,
  type ProjectInvitationsResponse,
  type ProjectMembersResponse,
  SHARE_LINK_KINDS,
  type ShareLinkKind,
  type ShareLinkResponse,
  type ShareLinksResponse,
  INVITATION_TTL_DAYS,
} from '@kaxolax/contracts'
import { inject } from '@adonisjs/core'
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import mail from '@adonisjs/mail/services/main'
import { InvitationEmailFailedException, ShareLinkNotFoundException } from '#exceptions/sharing'
import ProjectInvitationMail from '#mails/project_invitation_mail'
import { ownershipTransferEvents, publishProjectEvents } from '#services/project_events'
import RealtimeClient from '#services/realtime_client'
import {
  cancelInvitation,
  changeMemberRole,
  type InvitationToSend,
  inviteByEmail,
  projectInvitations,
  projectMembers,
  regenerateShareLink,
  removeMember,
  resendInvitation,
  revertInvitationSend,
  setShareLinkEnabled,
  shareLinks,
  transferProjectOwnership,
} from '#services/sharing_service'
import {
  createInvitationValidator,
  transferOwnershipValidator,
  updateMemberRoleValidator,
  updateShareLinkValidator,
} from '#validators/sharing'

function shareLinkKind(value: unknown): ShareLinkKind {
  const kind = SHARE_LINK_KINDS.find((candidate) => candidate === value)
  if (!kind) throw new ShareLinkNotFoundException()
  return kind
}

/**
 * Partage d'un projet : membres, invitations, transfert de propriété, liens de partage. Contrats
 * dans `packages/contracts/src/sharing.ts` ; droits par la matrice des permissions.
 */
@inject()
export default class SharingController {
  constructor(private readonly realtime: RealtimeClient) {}

  /**
   * Envoie l'email d'une invitation, une fois la transaction validée. En cas d'échec, l'envoi est
   * annulé (ancien lien de nouveau valide, envoi non compté, invitation nouvelle supprimée) avant
   * la réponse 502.
   */
  private async sendInvitation(sent: InvitationToSend): Promise<void> {
    try {
      await mail.send(
        new ProjectInvitationMail({ ...sent.mail, expiresInDays: INVITATION_TTL_DAYS }),
      )
    } catch (error) {
      logger.error({ err: error, invitationId: sent.invitation.id }, 'invitation email failed')
      try {
        await revertInvitationSend(sent)
      } catch (revertError) {
        logger.error(
          { err: revertError, invitationId: sent.invitation.id },
          'invitation send could not be reverted',
        )
      }
      throw new InvitationEmailFailedException()
    }
  }

  async members({ params, auth }: HttpContext): Promise<ProjectMembersResponse> {
    return projectMembers(auth.getUserOrFail(), String(params.id))
  }

  async updateMember({ params, request, auth }: HttpContext): Promise<MemberResponse> {
    const { role } = await request.validateUsing(updateMemberRoleValidator)
    const projectId = String(params.id)
    const user = auth.getUserOrFail()
    const { member, changed } = await changeMemberRole(user, projectId, String(params.userId), role)
    if (changed) {
      await this.realtime.membersChanged(projectId, [member.user.id])
      await this.realtime.publishProjectEvent(projectId, {
        type: 'member.role-updated',
        userId: member.user.id,
        role: member.role,
        actorId: user.id,
      })
    }
    return { member }
  }

  /** Retire un membre (propriétaire), ou quitte le projet (`:userId` = soi-même). */
  async removeMember({ params, auth, response }: HttpContext) {
    const projectId = String(params.id)
    const memberId = String(params.userId)
    const user = auth.getUserOrFail()
    await removeMember(user, projectId, memberId)
    // Déconnecté de tous les documents du projet en moins de 2 s, puis annoncé aux autres.
    await this.realtime.membersChanged(projectId, [memberId])
    await this.realtime.publishProjectEvent(projectId, {
      type: 'member.removed',
      userId: memberId,
      actorId: user.id,
    })
    response.noContent()
  }

  async transfer({ params, request, auth }: HttpContext): Promise<ProjectMembersResponse> {
    const { userId } = await request.validateUsing(transferOwnershipValidator)
    const user = auth.getUserOrFail()
    const projectId = String(params.id)
    const transfer = await transferProjectOwnership(user, projectId, userId)
    await this.realtime.membersChanged(projectId, [transfer.fromUserId, transfer.toUserId])
    await publishProjectEvents(this.realtime, projectId, ownershipTransferEvents(transfer, user.id))
    return projectMembers(user, projectId)
  }

  async invitations({ params, auth }: HttpContext): Promise<ProjectInvitationsResponse> {
    return { invitations: await projectInvitations(auth.getUserOrFail(), String(params.id)) }
  }

  /** 201 pour une nouvelle invitation, 200 si une invitation en attente a été renvoyée. */
  async invite({ params, request, auth, response }: HttpContext) {
    const input = await request.validateUsing(createInvitationValidator)
    const sent = await inviteByEmail(auth.getUserOrFail(), String(params.id), input)
    await this.sendInvitation(sent)
    const body: InvitationResponse = { invitation: sent.invitation }
    response.status(sent.created ? 201 : 200).send(body)
  }

  async resend({ params, auth }: HttpContext): Promise<InvitationResponse> {
    const sent = await resendInvitation(
      auth.getUserOrFail(),
      String(params.id),
      String(params.invitationId),
    )
    await this.sendInvitation(sent)
    return { invitation: sent.invitation }
  }

  async cancel({ params, auth, response }: HttpContext) {
    await cancelInvitation(auth.getUserOrFail(), String(params.id), String(params.invitationId))
    response.noContent()
  }

  async shareLinks({ params, auth }: HttpContext): Promise<ShareLinksResponse> {
    return { links: await shareLinks(auth.getUserOrFail(), String(params.id)) }
  }

  async updateShareLink({ params, request, auth }: HttpContext): Promise<ShareLinkResponse> {
    const kind = shareLinkKind(params.kind)
    const { enabled } = await request.validateUsing(updateShareLinkValidator)
    return {
      link: await setShareLinkEnabled(auth.getUserOrFail(), String(params.id), kind, enabled),
    }
  }

  async regenerateShareLink({ params, auth }: HttpContext): Promise<ShareLinkResponse> {
    const kind = shareLinkKind(params.kind)
    return { link: await regenerateShareLink(auth.getUserOrFail(), String(params.id), kind) }
  }
}
