'use client'

import {
  type AssignableRole,
  assignableRoleSchema,
  type ProjectInvitationEntry,
  type ProjectMemberEntry,
  type ProjectRole,
} from '@kaxolax/contracts'
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  NativeSelect,
  PresenceAvatar,
  SimpleTooltip,
} from '@kaxolax/ui'
import { EllipsisIcon } from 'lucide-react'
import { useNow } from '@/hooks/use-now'
import {
  formatDate,
  memberActions,
  memberName,
  type PendingConfirmation,
  resendCooldownSeconds,
  ROLE_LABELS,
  ROLE_OPTIONS,
} from '@/lib/sharing'

/** Membres du projet : rôle (modifiable par le propriétaire), retrait, transfert, départ. */
export function MemberList({
  members,
  viewerRole,
  viewerId,
  busy,
  onChangeRole,
  onConfirm,
}: {
  members: readonly ProjectMemberEntry[]
  viewerRole: ProjectRole
  viewerId: string
  /** Action en cours (clé `member-<id>`, `leave`…) : boutons désactivés. */
  busy: string | null
  onChangeRole: (userId: string, name: string, role: AssignableRole) => void
  onConfirm: (pending: PendingConfirmation) => void
}) {
  return (
    <section aria-labelledby="share-members-title" className="flex flex-col gap-1">
      <h3 id="share-members-title" className="text-sm font-medium">
        Membres ({members.length})
      </h3>
      <ul className="flex flex-col" data-testid="member-list">
        {members.map((member) => {
          const name = memberName(member)
          const self = member.user.id === viewerId
          const actions = memberActions(viewerRole, viewerId, member)
          const disabled = busy !== null
          return (
            <li
              key={member.user.id}
              className="flex min-w-0 items-center gap-2 py-1.5"
              data-testid="member-row"
            >
              <PresenceAvatar name={name} imageUrl={member.user.avatarUrl} size="sm" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm font-medium">
                  {name}
                  {self ? <span className="font-normal text-muted-foreground"> (vous)</span> : null}
                </span>
                {member.user.email && member.user.email !== name ? (
                  <span className="truncate text-xs text-muted-foreground">
                    {member.user.email}
                  </span>
                ) : null}
              </span>
              {actions.changeRole && member.role !== 'owner' ? (
                <NativeSelect
                  aria-label={`Rôle de ${name}`}
                  value={member.role}
                  disabled={disabled}
                  onChange={(event) => {
                    const parsed = assignableRoleSchema.safeParse(event.target.value)
                    if (parsed.success) onChangeRole(member.user.id, name, parsed.data)
                  }}
                  data-testid="member-role"
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {ROLE_LABELS[option]}
                    </option>
                  ))}
                </NativeSelect>
              ) : (
                <Badge variant={member.role === 'owner' ? 'default' : 'secondary'}>
                  {ROLE_LABELS[member.role]}
                </Badge>
              )}
              {actions.leave ? (
                <Button
                  variant="outline"
                  size="xs"
                  disabled={disabled}
                  onClick={() => {
                    onConfirm({ kind: 'leave' })
                  }}
                  data-testid="leave-project"
                >
                  Quitter
                </Button>
              ) : null}
              {actions.remove || actions.transfer ? (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      disabled={disabled}
                      aria-label={`Actions pour ${name}`}
                      data-testid="member-actions"
                    >
                      <EllipsisIcon />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    {actions.transfer ? (
                      <DropdownMenuItem
                        onSelect={() => {
                          onConfirm({ kind: 'transfer', userId: member.user.id, name })
                        }}
                      >
                        Transférer la propriété
                      </DropdownMenuItem>
                    ) : null}
                    {actions.remove ? (
                      <DropdownMenuItem
                        variant="destructive"
                        onSelect={() => {
                          onConfirm({ kind: 'remove', userId: member.user.id, name })
                        }}
                      >
                        Retirer du projet
                      </DropdownMenuItem>
                    ) : null}
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </li>
          )
        })}
      </ul>
    </section>
  )
}

/** Invitations en attente (propriétaire) : échéance, relance (une par minute), annulation. */
export function InvitationList({
  invitations,
  busy,
  onResend,
  onCancel,
}: {
  invitations: readonly ProjectInvitationEntry[]
  busy: string | null
  onResend: (invitation: ProjectInvitationEntry) => void
  onCancel: (invitation: ProjectInvitationEntry) => void
}) {
  const now = useNow(5_000)
  return (
    <section aria-labelledby="share-invitations-title" className="flex flex-col gap-1">
      <h3 id="share-invitations-title" className="text-sm font-medium">
        Invitations en attente ({invitations.length})
      </h3>
      <ul className="flex flex-col" data-testid="invitation-list">
        {invitations.map((invitation) => {
          const cooldown = resendCooldownSeconds(invitation, now)
          const disabled = busy !== null
          return (
            <li
              key={invitation.id}
              className="flex min-w-0 flex-wrap items-center gap-2 py-1.5"
              data-testid="invitation-row"
            >
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-sm">{invitation.email}</span>
                <span className="text-xs text-muted-foreground">
                  {ROLE_LABELS[invitation.role]} ·{' '}
                  {invitation.expired ? 'expirée' : `expire le ${formatDate(invitation.expiresAt)}`}
                </span>
              </span>
              {invitation.expired ? <Badge variant="warning">Expirée</Badge> : null}
              <SimpleTooltip
                label={
                  cooldown > 0
                    ? `Relance possible dans ${String(cooldown)} s`
                    : "Renvoyer l'email (nouveau lien)"
                }
              >
                {/* Enveloppe : l'infobulle reste accessible quand le bouton est désactivé. */}
                <span tabIndex={cooldown > 0 ? 0 : -1}>
                  <Button
                    variant="outline"
                    size="xs"
                    disabled={disabled || cooldown > 0}
                    onClick={() => {
                      onResend(invitation)
                    }}
                    data-testid="invitation-resend"
                  >
                    Relancer
                  </Button>
                </span>
              </SimpleTooltip>
              <Button
                variant="ghost"
                size="xs"
                disabled={disabled}
                onClick={() => {
                  onCancel(invitation)
                }}
                data-testid="invitation-cancel"
              >
                Annuler
              </Button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
