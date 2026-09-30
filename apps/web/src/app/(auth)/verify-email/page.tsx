'use client'

import { Alert, Button } from '@kaxolax/ui'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useRef, useState } from 'react'
import { AuthCard } from '@/components/auth/auth-card'
import { api } from '@/lib/api'

function Verify() {
  const token = useSearchParams().get('token')
  const [state, setState] = useState<'pending' | 'done' | 'failed'>(token ? 'pending' : 'failed')
  const started = useRef(false)

  useEffect(() => {
    // Le jeton est à usage unique : une seule tentative, même en mode strict de React.
    if (!token || started.current) return
    started.current = true
    api.verifyEmail(token).then(
      () => {
        setState('done')
      },
      () => {
        setState('failed')
      },
    )
  }, [token])

  return (
    <AuthCard title="Confirmation de l'email">
      {state === 'pending' ? (
        <p className="text-sm text-muted-foreground">Vérification en cours…</p>
      ) : null}
      {state === 'done' ? (
        <div className="grid gap-4">
          <Alert variant="success">Votre adresse est confirmée.</Alert>
          <Button asChild>
            <Link href="/login">Se connecter</Link>
          </Button>
        </div>
      ) : null}
      {state === 'failed' ? (
        <Alert variant="destructive">
          Ce lien est invalide ou a expiré. Connectez-vous pour en recevoir un nouveau.
        </Alert>
      ) : null}
    </AuthCard>
  )
}

export default function VerifyEmailPage() {
  return (
    <Suspense>
      <Verify />
    </Suspense>
  )
}
