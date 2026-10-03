'use client'

import { useClerk, useOrganizationList } from '@clerk/nextjs'
import { Alert, Button } from '@kaxolax/ui'
import { UsersIcon } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { teamUrl } from '@/lib/teams'

/**
 * Invitations d'équipe en attente du compte (Organisations Clerk, invitations envoyées depuis la
 * page d'une équipe) : accepter rejoint l'équipe (Clerk), en fait l'organisation active et ouvre
 * sa page, qui attend la synchronisation du workspace. Rien n'est affiché sans invitation.
 */
export function TeamInvitations() {
  const router = useRouter()
  const { setActive } = useClerk()
  const { isLoaded, userInvitations } = useOrganizationList({
    userInvitations: { status: 'pending' },
  })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  if (!isLoaded || userInvitations.data.length === 0) return null

  return (
    <section
      className="mb-4 flex flex-col gap-2"
      aria-label="Invitations d’équipe"
      data-testid="team-invitations"
    >
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      {userInvitations.data.map((invitation) => {
        const organization = invitation.publicOrganizationData
        return (
          <div
            key={invitation.id}
            className="flex flex-wrap items-center gap-3 rounded-lg border bg-card px-4 py-3 text-sm"
            data-testid="team-invitation"
          >
            <UsersIcon className="size-4 text-muted-foreground" aria-hidden />
            <span className="min-w-0 flex-1">
              Vous êtes invité à rejoindre l’équipe <strong>{organization.name}</strong>.
            </span>
            <Button
              size="sm"
              disabled={busy !== null}
              onClick={() => {
                setBusy(invitation.id)
                setError(null)
                invitation
                  .accept()
                  .then(() => setActive({ organization: organization.id }))
                  .then(() => {
                    router.push(teamUrl(organization.id))
                  })
                  .catch(() => {
                    setError('L’invitation n’a pas pu être acceptée : elle a peut-être expiré.')
                    setBusy(null)
                    void userInvitations.revalidate()
                  })
              }}
            >
              Rejoindre
            </Button>
          </div>
        )
      })}
    </section>
  )
}
