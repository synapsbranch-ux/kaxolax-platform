'use client'

import {
  assignableRoleSchema,
  type ProjectMembersResponse,
  type ProjectRole,
  type ShareLinkState,
} from '@kaxolax/contracts'
import { Alert, Button, Input, Label, NativeSelect, Separator, Spinner } from '@kaxolax/ui'
import { useRouter } from 'next/navigation'
import { type SubmitEvent, useCallback, useEffect, useState } from 'react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { api, formValue } from '@/lib/api'
import {
  canManageLinks,
  collaboratorUsageText,
  confirmationText,
  isAtCollaboratorLimit,
  type PendingConfirmation,
  ROLE_DESCRIPTIONS,
  ROLE_LABELS,
  ROLE_OPTIONS,
  shareDialogView,
} from '@/lib/sharing'
import { InvitationList, MemberList } from './member-list'
import { ShareLinks } from './share-links'
import { SharingError } from './sharing-error'

/**
 * Contenu de la modale de partage. Propriétaire : invitation par email avec un rôle, membres
 * (changer un rôle, retirer, transférer la propriété), invitations en attente (relancer,
 * annuler) et liens de partage. Autres rôles : vue limitée (liste des membres, quitter le
 * projet). Relu à l'ouverture et à chaque événement de membre (`version`).
 */
export function SharePanel({
  projectId,
  role,
  selfId,
  version,
  onAccessChanged,
}: {
  projectId: string
  role: ProjectRole
  selfId: string
  /** Incrémenté à chaque événement de membre reçu du temps réel : la liste est relue. */
  version: number
  /** Son propre rôle a changé (transfert) : la page relit le projet. */
  onAccessChanged: () => void
}) {
  const router = useRouter()
  const view = shareDialogView(role)
  const [members, setMembers] = useState<ProjectMembersResponse | null>(null)
  const [links, setLinks] = useState<ShareLinkState[] | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [error, setError] = useState<unknown>(null)
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingConfirmation | null>(null)
  const [reloads, setReloads] = useState(0)

  const reload = useCallback(() => {
    setReloads((count) => count + 1)
  }, [])

  useEffect(() => {
    const state = { active: true }
    const manageLinks = canManageLinks(role)
    Promise.all([api.members(projectId), manageLinks ? api.shareLinks(projectId) : null]).then(
      ([loaded, loadedLinks]) => {
        if (!state.active) return
        setMembers(loaded)
        setLinks(loadedLinks?.links ?? null)
        setLoadError(null)
      },
      (caught: unknown) => {
        if (state.active) setLoadError(caught)
      },
    )
    return () => {
      state.active = false
    }
  }, [projectId, role, version, reloads])

  /** Lance une action (une à la fois) : erreur affichée, liste relue ensuite. */
  const run = useCallback(
    async (key: string, action: () => Promise<string | null>) => {
      setBusy(key)
      setError(null)
      setStatus(null)
      try {
        setStatus(await action())
      } catch (caught) {
        setError(caught)
      } finally {
        setBusy(null)
        reload()
      }
    },
    [reload],
  )

  const invite = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const form = event.currentTarget
    const data = new FormData(form)
    const email = formValue(data, 'email').trim()
    const inviteRole = assignableRoleSchema.parse(formValue(data, 'role'))
    void run('invite', async () => {
      await api.invite(projectId, email, inviteRole)
      form.reset()
      return `Invitation envoyée à ${email} (${ROLE_LABELS[inviteRole].toLowerCase()}).`
    })
  }

  const confirm = (confirmed: PendingConfirmation) => {
    switch (confirmed.kind) {
      case 'regenerate':
        void run(`link-${confirmed.link}`, async () => {
          const { link } = await api.regenerateShareLink(projectId, confirmed.link)
          setLinks((current) =>
            current ? current.map((item) => (item.kind === link.kind ? link : item)) : current,
          )
          return "Nouveau lien créé : l'ancien ne fonctionne plus."
        })
        break
      case 'transfer':
        void run(`member-${confirmed.userId}`, async () => {
          setMembers(await api.transferOwnership(projectId, confirmed.userId))
          onAccessChanged()
          return `${confirmed.name} est maintenant propriétaire du projet.`
        })
        break
      case 'remove':
        void run(`member-${confirmed.userId}`, async () => {
          await api.removeMember(projectId, confirmed.userId)
          return `${confirmed.name} a été retiré du projet.`
        })
        break
      case 'leave':
        void run('leave', async () => {
          await api.removeMember(projectId, selfId)
          router.push('/dashboard')
          return 'Vous avez quitté le projet.'
        })
        break
    }
  }

  if (loadError !== null && members === null) {
    return (
      <div className="flex flex-col items-start gap-3">
        <SharingError error={loadError} />
        <Button variant="outline" size="sm" onClick={reload}>
          Réessayer
        </Button>
      </div>
    )
  }
  if (members === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-busy="true">
        <Spinner label="" /> Chargement des membres…
      </p>
    )
  }

  const usage = members.collaborators
  const atLimit = isAtCollaboratorLimit(usage)
  const confirmation = pending ? confirmationText(pending) : null

  return (
    <div className="flex min-w-0 flex-col gap-4">
      {view === 'manage' ? (
        <form className="flex flex-col gap-2" onSubmit={invite} data-testid="invite-form">
          <Label htmlFor="invite-email">Inviter par email</Label>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Input
              id="invite-email"
              name="email"
              type="email"
              required
              maxLength={254}
              autoComplete="off"
              placeholder="nom@exemple.fr"
              className="sm:flex-1"
              data-testid="invite-email"
            />
            <NativeSelect
              name="role"
              defaultValue="editor"
              aria-label="Rôle de la personne invitée"
              className="h-9"
              data-testid="invite-role"
            >
              {ROLE_OPTIONS.map((option) => (
                <option key={option} value={option}>
                  {ROLE_LABELS[option]} ({ROLE_DESCRIPTIONS[option]})
                </option>
              ))}
            </NativeSelect>
            <Button type="submit" disabled={busy !== null} data-testid="invite-submit">
              {busy === 'invite' ? <Spinner label="" /> : null}
              Inviter
            </Button>
          </div>
          {usage ? (
            <p className="text-xs text-muted-foreground" data-testid="collaborator-usage">
              {collaboratorUsageText(usage)}
              {atLimit ? ' : limite atteinte.' : null}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="text-sm text-muted-foreground">
          Votre rôle : <strong>{ROLE_LABELS[role]}</strong> ({ROLE_DESCRIPTIONS[role]}). Seul le
          propriétaire invite et gère les membres.
        </p>
      )}

      {error !== null ? (
        <SharingError
          error={error}
          onDismiss={() => {
            setError(null)
          }}
        />
      ) : null}
      {status !== null ? (
        <Alert variant="success" role="status" data-testid="sharing-status">
          {status}
        </Alert>
      ) : null}

      <MemberList
        members={members.members}
        viewerRole={role}
        viewerId={selfId}
        busy={busy}
        onChangeRole={(userId, name, nextRole) => {
          void run(`member-${userId}`, async () => {
            await api.updateMemberRole(projectId, userId, nextRole)
            return `${name} est maintenant ${ROLE_LABELS[nextRole].toLowerCase()}.`
          })
        }}
        onConfirm={setPending}
      />

      {view === 'manage' && members.invitations.length > 0 ? (
        <InvitationList
          invitations={members.invitations}
          busy={busy}
          onResend={(invitation) => {
            void run(`invitation-${invitation.id}`, async () => {
              await api.resendInvitation(projectId, invitation.id)
              return `Invitation renvoyée à ${invitation.email}.`
            })
          }}
          onCancel={(invitation) => {
            void run(`invitation-${invitation.id}`, async () => {
              await api.cancelInvitation(projectId, invitation.id)
              return `Invitation de ${invitation.email} annulée.`
            })
          }}
        />
      ) : null}

      {links ? (
        <>
          <Separator />
          <ShareLinks
            links={links}
            busy={busy}
            onToggle={(kind, enabled) => {
              void run(`link-${kind}`, async () => {
                const { link } = await api.setShareLink(projectId, kind, enabled)
                setLinks((current) =>
                  current
                    ? current.map((item) => (item.kind === link.kind ? link : item))
                    : current,
                )
                return null
              })
            }}
            onRegenerate={(kind) => {
              setPending({ kind: 'regenerate', link: kind })
            }}
            onCopied={setStatus}
            onError={setError}
          />
        </>
      ) : null}

      <ConfirmDialog
        open={pending !== null}
        title={confirmation?.title ?? ''}
        description={confirmation?.description ?? ''}
        confirmLabel={confirmation?.confirmLabel ?? ''}
        onConfirm={() => {
          if (pending) confirm(pending)
        }}
        onOpenChange={(open) => {
          if (!open) setPending(null)
        }}
      />
    </div>
  )
}
