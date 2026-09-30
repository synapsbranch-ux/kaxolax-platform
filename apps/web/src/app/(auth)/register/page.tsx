'use client'

import { Alert, Button } from '@kaxolax/ui'
import Link from 'next/link'
import { type SubmitEvent, useState } from 'react'
import { AuthCard } from '@/components/auth/auth-card'
import { Field } from '@/components/auth/field'
import { api, errorMessage, formValue } from '@/lib/api'

export default function RegisterPage() {
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = formValue(form, 'email')
    setPending(true)
    setError(null)
    try {
      const fullName = formValue(form, 'fullName').trim()
      await api.register({
        email,
        password: formValue(form, 'password'),
        ...(fullName ? { fullName } : {}),
      })
      setSentTo(email)
    } catch (caught) {
      setError(errorMessage(caught))
    } finally {
      setPending(false)
    }
  }

  if (sentTo !== null) {
    return (
      <AuthCard title="Vérifiez vos emails">
        <p className="text-sm">
          Un lien de confirmation a été envoyé à <strong>{sentTo}</strong>. Cliquez dessus pour
          activer votre compte, puis connectez-vous.
        </p>
        <Button asChild className="mt-4 w-full" variant="outline">
          <Link href="/login">Aller à la connexion</Link>
        </Button>
      </AuthCard>
    )
  }

  return (
    <AuthCard title="Créer un compte" description="Gratuit, sans carte bancaire.">
      <form onSubmit={(event) => void submit(event)} className="grid gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        <Field label="Nom complet" id="fullName" autoComplete="name" />
        <Field label="Email" id="email" type="email" autoComplete="email" required />
        <Field
          label="Mot de passe (8 caractères minimum)"
          id="password"
          type="password"
          autoComplete="new-password"
          minLength={8}
          required
        />
        <Button type="submit" disabled={pending}>
          Créer mon compte
        </Button>
        <p className="text-center text-sm text-muted-foreground">
          Déjà inscrit ?{' '}
          <Link href="/login" className="text-foreground underline-offset-4 hover:underline">
            Se connecter
          </Link>
        </p>
      </form>
    </AuthCard>
  )
}
