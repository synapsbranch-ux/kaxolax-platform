import { PricingTable } from '@clerk/nextjs'
import { auth } from '@clerk/nextjs/server'
import { PRO_PLAN } from '@kaxolax/contracts'
import { Logo } from '@kaxolax/ui'
import type { Metadata } from 'next'
import Link from 'next/link'

export const metadata: Metadata = { title: 'Tarifs — Kaxolax' }

/**
 * Tarifs : plans utilisateur de Clerk Billing (Free par défaut, Pro) avec <PricingTable />, habillé
 * comme les autres composants Clerk (`appearance` du ClerkProvider). Page publique ; abonnement,
 * factures et moyens de paiement se gèrent dans l'onglet Billing de /account. `has()` ne sert ici
 * qu'à l'affichage : les limites sont appliquées par l'API.
 */
export default async function PricingPage() {
  const { isAuthenticated, has } = await auth()
  const isPro = isAuthenticated && has({ plan: PRO_PLAN })
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col gap-8 px-4 py-8">
      <header className="flex items-center justify-between gap-4">
        <Link href={isAuthenticated ? '/dashboard' : '/'} aria-label="Kaxolax">
          <Logo />
        </Link>
        <Link
          href={isAuthenticated ? '/dashboard' : '/sign-in'}
          className="text-sm text-muted-foreground hover:underline"
        >
          {isAuthenticated ? '← Tableau de bord' : 'Se connecter'}
        </Link>
      </header>
      <section className="flex flex-col gap-2 text-center">
        <h1 className="text-2xl font-semibold">Choisissez votre plan</h1>
        <p className="text-muted-foreground">
          Free pour commencer ; Pro pour des compilations jusqu’à 4 minutes, des collaborateurs
          illimités, l’historique complet et 20 Go de stockage.
        </p>
        {isPro ? (
          <p className="text-sm" data-testid="pricing-current-plan">
            Vous êtes abonné à Pro.{' '}
            <Link href="/account/billing" className="underline underline-offset-4">
              Gérer l’abonnement et les factures
            </Link>
          </p>
        ) : null}
      </section>
      <PricingTable newSubscriptionRedirectUrl="/dashboard" />
    </main>
  )
}
