import { describe, expect, it } from 'vitest'
import {
  memberChangedResponseSchema,
  REALTIME_FORBIDDEN_CLOSE_CODE,
  roleChangedMessageSchema,
} from './realtime.js'
import {
  createInvitationInputSchema,
  invitationPreviewSchema,
  joinProjectResponseSchema,
  SHARING_ERRORS,
  tooManyInvitationsErrorSchema,
  projectMembersResponseSchema,
  SHARE_LINK_ROLES,
  shareLinksResponseSchema,
  updateMemberRoleInputSchema,
} from './sharing.js'

const id = '0b9f8d3e-5a4c-4b1e-9f2a-3c4d5e6f7a8b'
const date = '2026-10-01T12:00:00.000Z'

describe('sharing contracts', () => {
  it('validates an invitation request', () => {
    expect(
      createInvitationInputSchema.safeParse({ email: 'ada@example.com', role: 'reviewer' }).success,
    ).toBe(true)
    expect(
      createInvitationInputSchema.safeParse({ email: 'ada@example.com', role: 'owner' }).success,
    ).toBe(false)
    expect(
      createInvitationInputSchema.safeParse({ email: 'not-an-email', role: 'viewer' }).success,
    ).toBe(false)
    expect(updateMemberRoleInputSchema.safeParse({ role: 'owner' }).success).toBe(false)
  })

  it('describes the members list with pending invitations', () => {
    const response = {
      members: [
        {
          user: { id, email: 'ada@example.com', fullName: 'Ada', avatarUrl: null },
          role: 'owner',
          joinedAt: date,
        },
      ],
      invitations: [
        {
          id,
          email: 'grace@example.com',
          role: 'editor',
          invitedBy: { id, fullName: 'Ada' },
          createdAt: date,
          lastSentAt: date,
          expiresAt: date,
          expired: false,
        },
      ],
      collaborators: { plan: 'free', max: 1, used: 1 },
    }
    expect(projectMembersResponseSchema.parse(response)).toEqual(response)
    // Emails des autres membres masqués pour qui ne gère pas les membres.
    const hidden = {
      ...response,
      members: response.members.map((member) => ({
        ...member,
        user: { ...member.user, email: null },
      })),
    }
    expect(projectMembersResponseSchema.parse(hidden)).toEqual(hidden)
    expect(
      projectMembersResponseSchema.safeParse({ ...response, collaborators: null }).success,
    ).toBe(true)
  })

  it('maps each share link kind to its role', () => {
    expect(SHARE_LINK_ROLES).toEqual({ view: 'viewer', edit: 'editor' })
    const links = {
      links: [
        { kind: 'view', role: 'viewer', enabled: false, url: null, createdAt: null },
        {
          kind: 'edit',
          role: 'editor',
          enabled: true,
          url: 'http://localhost:3000/share/abc',
          createdAt: date,
        },
      ],
    }
    expect(shareLinksResponseSchema.parse(links)).toEqual(links)
  })

  it('keeps public previews minimal and join answers explicit', () => {
    const preview = {
      projectName: 'Thèse',
      inviterName: null,
      role: 'viewer',
      expiresAt: date,
      accepted: false,
    }
    expect(invitationPreviewSchema.parse(preview)).toEqual(preview)
    expect(invitationPreviewSchema.safeParse({ ...preview, role: 'owner' }).success).toBe(false)
    expect(
      joinProjectResponseSchema.parse({ projectId: id, role: 'owner', joined: false }),
    ).toEqual({ projectId: id, role: 'owner', joined: false })
    expect(
      tooManyInvitationsErrorSchema.safeParse({
        code: SHARING_ERRORS.tooManyInvitations,
        message: 'Too many',
        retryAfterSeconds: null,
      }).success,
    ).toBe(true)
  })

  it('describes the realtime member change contracts', () => {
    expect(memberChangedResponseSchema.parse({ closed: 1, updated: 0 })).toEqual({
      closed: 1,
      updated: 0,
    })
    expect(
      roleChangedMessageSchema.safeParse({
        type: 'member.role-changed',
        role: 'viewer',
        readOnly: true,
      }).success,
    ).toBe(true)
    expect(REALTIME_FORBIDDEN_CLOSE_CODE).toBe(4403)
  })
})
