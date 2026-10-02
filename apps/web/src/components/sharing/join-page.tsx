'use client'

import { useAuth, useClerk } from '@clerk/nextjs'
import { type AssignableRole, SHARING_ERRORS } from '@kaxolax/contracts'
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
  Logo,
  Spinner,
} from '@kaxolax/ui'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useCallback, useEffect, useState } from 'react'
import { api, ApiError } from '@/lib/api'
import { markPlanLimitHandled } from '@/lib/plan-limits'
import { authUrl, formatDate, ROLE_DESCRIPTIONS, ROLE_LABELS } from '@/lib/sharing'
import { SharingError } from './sharing-error'

/** Ce que la page affiche du projet à rejoindre (aperçu public). */
interface Preview {
  projectName: string
  role: AssignableRole
  inviterName: string | null
  expiresAt: string | null
  /** Invitation déjà acceptée (par exemple automatiquement à l'inscription). */
  accepted: boolean
}

/**
 * Page publique d'une invitation (`/invitations/[token]`) ou d'un lien de partage
 * (`/share/[token]`) : aperçu sans compte (projet, rôle, invitant), puis acceptation une fois
 * connecté. Sans session : connexion ou inscription Clerk, avec retour sur cette page. Une
 * invitation déjà acceptée (inscription depuis l'email) est réglée tout de suite : l'acceptation
 * est idempotente pour le compte invité et donne le projet.
 */
export function JoinPage({ kind, token }: { kind: 'invitation' | 'share'; token: string }) {
  const { isLoaded, isSignedIn } = useAuth()
  const clerk = useClerk()
  const router = useRouter()
  const [preview, setPreview] = useState<Preview | null>(null)
  const [loadError, setLoadError] = useState<unknown>(null)
  const [joinError, setJoinError] = useState<unknown>(null)
  const [joining, setJoining] = useState(false)
  const returnTo = `/${kind === 'invitation' ? 'invitations' : 'share'}/${encodeURIComponent(token)}`

  useEffect(() => {
    const state = { active: true }
    const load: Promise<Preview> =
      kind === 'invitation'
        ? api.invitationPreview(token).then((loaded) => ({ ...loaded }))
        : api
            .shareLinkPreview(token)
            .then((loaded) => ({ ...loaded, inviterName: null, expiresAt: null, accepted: false }))
    load.then(
      (loaded) => {
        if (state.active) setPreview(loaded)
      },
      (caught: unknown) => {
        markPlanLimitHandled(caught)
        if (state.active) setLoadError(caught)
      },
    )
    return () => {
      state.active = false
    }
  }, [kind, token])

  const join = useCallback(async () => {
    setJoining(true)
    setJoinError(null)
    try {
      const joined =
        kind === 'invitation' ? await api.acceptInvitation(token) : await api.joinShareLink(token)
      router.replace(`/project/${joined.projectId}`)
    } catch (caught) {
      // Limite du plan affichée sur la page (`SharingError`), pas par la boîte globale.
      markPlanLimitHandled(caught)
      setJoinError(caught)
      setJoining(false)
    }
  }, [kind, token, router])

  // Invitation déjà acceptée et compte connecté : direction le projet sans clic de plus.
  const autoJoin = preview?.accepted === true && isLoaded && isSignedIn
  useEffect(() => {
    if (!autoJoin) return
    const timer = setTimeout(() => {
      void join()
    }, 0)
    return () => {
      clearTimeout(timer)
    }
  }, [autoJoin, join])

  const title = kind === 'invitation' ? 'Invitation à collaborer' : 'Rejoindre un projet'
  const mismatch =
    joinError instanceof ApiError && joinError.code === SHARING_ERRORS.invitationEmailMismatch

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-4 py-8 text-foreground">
      <Link
        href="/"
        className="flex items-center gap-2 rounded-md text-2xl font-bold tracking-tight outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
      >
        <Logo size={32} title="" />
        Kaxolax
      </Link>
      <Card className="w-full max-w-md" data-testid="join-card">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          {preview ? (
            <CardDescription>
              {preview.inviterName
                ? `${preview.inviterName} vous invite à rejoindre`
                : 'Vous êtes invité à rejoindre'}{' '}
              <strong className="text-foreground">« {preview.projectName} »</strong> comme{' '}
              <strong className="text-foreground">{ROLE_LABELS[preview.role].toLowerCase()}</strong>{' '}
              ({ROLE_DESCRIPTIONS[preview.role]}).
            </CardDescription>
          ) : null}
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          {loadError !== null ? <SharingError error={loadError} /> : null}
          {preview === null && loadError === null ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground" aria-busy="true">
              <Spinner label="" /> Chargement…
            </p>
          ) : null}
          {preview?.expiresAt && !preview.accepted ? (
            <p className="text-xs text-muted-foreground">
              Invitation valable jusqu'au {formatDate(preview.expiresAt)}.
            </p>
          ) : null}
          {joinError !== null ? <SharingError error={joinError} /> : null}
        </CardContent>
        {preview ? (
          <CardFooter className="flex flex-col items-stretch gap-2">
            {!isLoaded ? (
              <Spinner label="Chargement de la session" />
            ) : isSignedIn ? (
              <>
                <Button onClick={() => void join()} disabled={joining} data-testid="join-submit">
                  {joining ? <Spinner label="" /> : null}
                  {kind === 'invitation' ? "Accepter l'invitation" : 'Rejoindre le projet'}
                </Button>
                {mismatch ? (
                  <Button
                    variant="outline"
                    onClick={() =>
                      void clerk.signOut({ redirectUrl: authUrl('sign-in', returnTo) })
                    }
                  >
                    Changer de compte
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <p className="text-sm text-muted-foreground">
                  Connectez-vous pour rejoindre le projet. Pas encore de compte ? Créez-le : vous
                  reviendrez ici ensuite.
                </p>
                <Button asChild>
                  <Link href={authUrl('sign-in', returnTo)} data-testid="join-sign-in">
                    Se connecter
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link href={authUrl('sign-up', returnTo)} data-testid="join-sign-up">
                    Créer un compte
                  </Link>
                </Button>
              </>
            )}
          </CardFooter>
        ) : null}
      </Card>
    </main>
  )
}
