'use client'

import { Alert, Button } from '@kaxolax/ui'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { type SubmitEvent, Suspense, useState } from 'react'
import { AuthCard } from '@/components/auth/auth-card'
import { Field } from '@/components/auth/field'
import { api, ApiError, errorMessage, formValue } from '@/lib/api'

function LoginForm() {
  const router = useRouter()
  const next = useSearchParams().get('next')
  const [error, setError] = useState<string | null>(null)
  const [unverified, setUnverified] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function submit(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    const email = formValue(form, 'email')
    setPending(true)
    setError(null)
    setUnverified(null)
    try {
      await api.login({ email, password: formValue(form, 'password') })
      router.replace(next?.startsWith('/') === true ? next : '/dashboard')
    } catch (caught) {
      if (caught instanceof ApiError && caught.code === 'E_EMAIL_NOT_VERIFIED') setUnverified(email)
      else if (caught instanceof ApiError && caught.status === 400)
        setError('Email ou mot de passe incorrect.')
      else if (caught instanceof ApiError && caught.status === 429)
        setError('Trop de tentatives, réessayez dans une minute.')
      else setError(errorMessage(caught))
    } finally {
      setPending(false)
    }
  }

  return (
    <AuthCard title="Connexion" description="Accédez à vos projets LaTeX.">
      <form onSubmit={(event) => void submit(event)} className="grid gap-4">
        {error ? <Alert variant="destructive">{error}</Alert> : null}
        {unverified ? (
          <Alert>
            Confirmez d'abord votre adresse email.{' '}
            <button
              type="button"
              className="underline"
              onClick={() =>
                void api.resendVerification(unverified).then(() => {
                  setError(null)
                })
              }
            >
              Renvoyer l'email
            </button>
          </Alert>
        ) : null}
        <Field label="Email" id="email" type="email" autoComplete="email" required />
        <Field
          label="Mot de passe"
          id="password"
          type="password"
          autoComplete="current-password"
          required
        />
        <Button type="submit" disabled={pending}>
          Se connecter
        </Button>
        <div className="flex justify-between text-sm">
          <Link
            href="/forgot-password"
            className="text-muted-foreground underline-offset-4 hover:underline"
          >
            Mot de passe oublié ?
          </Link>
          <Link href="/register" className="underline-offset-4 hover:underline">
            Créer un compte
          </Link>
        </div>
      </form>
    </AuthCard>
  )
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginForm />
    </Suspense>
  )
}
