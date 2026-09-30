'use client'

import { Alert, Button } from '@kaxolax/ui'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { type SubmitEvent, Suspense, useState } from 'react'
import { AuthCard } from '@/components/auth/auth-card'
import { Field } from '@/components/auth/field'
import { api, errorMessage, formValue } from '@/lib/api'

function ResetForm() {
  const token = useSearchParams().get('token') ?? ''
  const [done, setDone] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      await api.resetPassword(token, formValue(new FormData(event.currentTarget), 'password'))
      setDone(true)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  return (
    <AuthCard title="Nouveau mot de passe">
      {done ? (
        <div className="grid gap-4">
          <Alert variant="success">Votre mot de passe a été changé.</Alert>
          <Button asChild>
            <Link href="/login">Se connecter</Link>
          </Button>
        </div>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <Field
            label="Nouveau mot de passe"
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
          />
          <Button type="submit" disabled={token === ''}>
            Enregistrer
          </Button>
        </form>
      )}
    </AuthCard>
  )
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetForm />
    </Suspense>
  )
}
