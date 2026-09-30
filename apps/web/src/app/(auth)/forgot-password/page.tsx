'use client'

import { Alert, Button } from '@kaxolax/ui'
import Link from 'next/link'
import { type SubmitEvent, useState } from 'react'
import { AuthCard } from '@/components/auth/auth-card'
import { Field } from '@/components/auth/field'
import { api, errorMessage, formValue } from '@/lib/api'

export default function ForgotPasswordPage() {
  const [sent, setSent] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    try {
      await api.forgotPassword(formValue(new FormData(event.currentTarget), 'email'))
      setSent(true)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  return (
    <AuthCard
      title="Mot de passe oublié"
      description="Recevez un lien pour choisir un nouveau mot de passe."
    >
      {sent ? (
        <Alert variant="success">
          Si un compte existe pour cette adresse, un email vient d'être envoyé.
        </Alert>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="grid gap-4">
          {error ? <Alert variant="destructive">{error}</Alert> : null}
          <Field label="Email" id="email" type="email" autoComplete="email" required />
          <Button type="submit">Envoyer le lien</Button>
        </form>
      )}
      <Link
        href="/login"
        className="mt-4 block text-center text-sm underline-offset-4 hover:underline"
      >
        Retour à la connexion
      </Link>
    </AuthCard>
  )
}
