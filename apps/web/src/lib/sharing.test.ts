import type { ProjectInvitationEntry, ProjectMemberEntry } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import { ApiError } from './api'
import {
  authUrl,
  collaboratorUsageText,
  confirmationText,
  isAtCollaboratorLimit,
  memberActions,
  memberName,
  planLimitOf,
  resendCooldownSeconds,
  shareDialogView,
  sharingErrorMessage,
} from './sharing'

const OWNER = '00000000-0000-4000-8000-000000000001'
const EDITOR = '00000000-0000-4000-8000-000000000002'
const VIEWER = '00000000-0000-4000-8000-000000000003'

const member = (id: string, role: ProjectMemberEntry['role'], fullName: string | null = null) => ({
  user: { id, email: null, fullName, avatarUrl: null },
  role,
  joinedAt: '2026-10-01T00:00:00.000Z',
})

describe('share dialog state', () => {
  it('gives the owner the full view and other roles the limited view', () => {
    expect(shareDialogView('owner')).toBe('manage')
    for (const role of ['editor', 'reviewer', 'viewer'] as const)
      expect(shareDialogView(role)).toBe('limited')
  })

  it('offers member actions by role', () => {
    expect(memberActions('owner', OWNER, member(EDITOR, 'editor'))).toEqual({
      changeRole: true,
      remove: true,
      transfer: true,
      leave: false,
    })
    // Le propriétaire ne se retire pas et ne change pas son rôle.
    expect(memberActions('owner', OWNER, member(OWNER, 'owner'))).toEqual({
      changeRole: false,
      remove: false,
      transfer: false,
      leave: false,
    })
    // Vue limitée : seulement quitter, sur sa propre ligne.
    expect(memberActions('viewer', VIEWER, member(VIEWER, 'viewer'))).toEqual({
      changeRole: false,
      remove: false,
      transfer: false,
      leave: true,
    })
    expect(memberActions('editor', EDITOR, member(VIEWER, 'viewer'))).toEqual({
      changeRole: false,
      remove: false,
      transfer: false,
      leave: false,
    })
  })

  it('names members and describes the collaborator limit', () => {
    expect(memberName(member(EDITOR, 'editor', '  Ada  '))).toBe('Ada')
    expect(
      memberName({
        ...member(EDITOR, 'editor'),
        user: { ...member(EDITOR, 'editor').user, email: 'a@b.fr' },
      }),
    ).toBe('a@b.fr')
    expect(memberName(member(EDITOR, 'editor', ' '))).toBe('Collaborateur')
    expect(collaboratorUsageText({ plan: 'free', max: 1, used: 1 })).toBe(
      '1 sur 1 collaborateur (plan free)',
    )
    expect(collaboratorUsageText({ plan: 'pro', max: null, used: 3 })).toBe(
      '3 collaborateurs (plan pro, illimités)',
    )
    expect(isAtCollaboratorLimit({ plan: 'free', max: 1, used: 1 })).toBe(true)
    expect(isAtCollaboratorLimit({ plan: 'pro', max: null, used: 99 })).toBe(false)
    expect(isAtCollaboratorLimit(null)).toBe(false)
  })

  it('waits a minute between two sends of an invitation', () => {
    const invitation = { lastSentAt: '2026-10-02T10:00:00.000Z' } as ProjectInvitationEntry
    const at = (seconds: number) => Date.parse('2026-10-02T10:00:00.000Z') + seconds * 1000
    expect(resendCooldownSeconds(invitation, at(0))).toBe(60)
    expect(resendCooldownSeconds(invitation, at(59.5))).toBe(1)
    expect(resendCooldownSeconds(invitation, at(61))).toBe(0)
  })

  it('asks a confirmation for each irreversible action', () => {
    expect(confirmationText({ kind: 'regenerate', link: 'edit' }).confirmLabel).toBe('Régénérer')
    expect(confirmationText({ kind: 'transfer', userId: EDITOR, name: 'Ada' }).title).toContain(
      'Ada',
    )
    expect(confirmationText({ kind: 'leave' }).confirmLabel).toBe('Quitter')
  })
})

describe('sharing errors', () => {
  it('reads the plan limit from the error body', () => {
    const error = new ApiError(403, 'E_PLAN_LIMIT', 'limit', [], {
      code: 'E_PLAN_LIMIT',
      message: 'limit',
      limit: { name: 'collaborators', plan: 'free', max: 1 },
      feature: 'unlimited_collaborators',
      upgradeUrl: 'https://app.kaxolax.test/pricing',
    })
    expect(planLimitOf(error)).toEqual({ plan: 'free', max: 1 })
    expect(sharingErrorMessage(error)).toContain('1 collaborateur')
    expect(planLimitOf(new ApiError(403, 'E_PROJECT_FORBIDDEN', 'no'))).toBeNull()
  })

  it('translates the sharing error codes', () => {
    const mismatch = new ApiError(403, 'E_INVITATION_EMAIL_MISMATCH', 'mismatch', [], {
      code: 'E_INVITATION_EMAIL_MISMATCH',
      message: 'mismatch',
      invitedEmailHint: 'a***@exemple.fr',
    })
    expect(sharingErrorMessage(mismatch)).toContain('a***@exemple.fr')
    const tooMany = new ApiError(429, 'E_TOO_MANY_INVITATIONS', 'slow', [], {
      code: 'E_TOO_MANY_INVITATIONS',
      message: 'slow',
      retryAfterSeconds: 42,
    })
    expect(sharingErrorMessage(tooMany)).toContain('42 s')
    expect(sharingErrorMessage(new ApiError(410, 'E_INVITATION_EXPIRED', 'expired'))).toContain(
      'expiré',
    )
    expect(sharingErrorMessage(new Error('boom'))).toBe('boom')
  })

  it('comes back to the page after signing in or up', () => {
    expect(authUrl('sign-in', '/invitations/abc')).toBe(
      '/sign-in?redirect_url=%2Finvitations%2Fabc',
    )
  })
})
