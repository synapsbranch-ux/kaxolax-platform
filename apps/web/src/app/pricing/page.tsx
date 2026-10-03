import { PricingTable } from '@clerk/nextjs'
import { auth } from '@clerk/nextjs/server'
import { Logo } from '@kaxolax/ui'
import type { Metadata } from 'next'
import Link from 'next/link'
import { USER_PRO_PLAN } from '@/lib/plan-usage'
import { CREATE_TEAM_URL, teamUrl } from '@/lib/teams'

export const metadata: Metadata = { title: 'Tarifs — Kaxolax' }

/**
 * Tarifs : plans utilisateur de Clerk Billing (Free par défaut, Pro) avec <PricingTable />, puis
 * plan d'équipe (Team, par siège) avec la table des plans d'organisation
 * (`<PricingTable for="organization" />`, pour l'organisation active de la session). Habillés
 * comme les autres composants Clerk (`appearance` du ClerkProvider). Page publique ; abonnements,
 * factures et moyens de paiement se gèrent dans l'onglet Billing de /account (compte) ou de la
 * page de l'équipe. `has()` ne sert ici qu'à l'affichage : les limites sont appliquées par l'API.
 */
export default async function PricingPage() {
  const { isAuthenticated, has, orgId, orgSlug } = await auth()
  const isPro = isAuthenticated && has({ plan: USER_PRO_PLAN })
  const activeTeam = isAuthenticated && orgId ? orgId : null
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

      <section
        id="team"
        className="flex scroll-mt-8 flex-col gap-4 border-t pt-8"
        aria-labelledby="pricing-team"
        data-testid="pricing-team"
      >
        <div className="flex flex-col gap-2 text-center">
          <h2 id="pricing-team" className="text-xl font-semibold">
            Plan Team, pour les équipes
          </h2>
          <p className="text-muted-foreground">
            Un workspace partagé, facturé par siège : les limites de Pro sur tous les projets de
            l’équipe, accès de toute l’équipe à ses projets, 50 Go de stockage mutualisé et 2000
            crédits IA par membre et par mois, mis en commun pour les projets de l’équipe. Les
            projets personnels de chaque membre gardent les limites de son propre plan.
          </p>
        </div>
        {activeTeam !== null ? (
          <>
            <p className="text-center text-sm" data-testid="pricing-team-active">
              Plans de l’équipe active{orgSlug ? ` (${orgSlug})` : ''}.{' '}
              <Link href={teamUrl(activeTeam)} className="underline underline-offset-4">
                Page de l’équipe : membres et facturation
              </Link>
            </p>
            <PricingTable for="organization" newSubscriptionRedirectUrl={teamUrl(activeTeam)} />
          </>
        ) : (
          <p className="text-center text-sm">
            {isAuthenticated ? (
              <>
                <Link href={CREATE_TEAM_URL} className="underline underline-offset-4">
                  Créez une équipe
                </Link>{' '}
                ou choisissez-en une dans le sélecteur de workspace, puis revenez ici pour
                l’abonner.
              </>
            ) : (
              <>
                <Link href="/sign-in" className="underline underline-offset-4">
                  Connectez-vous
                </Link>{' '}
                puis créez une équipe pour l’abonner au plan Team.
              </>
            )}
          </p>
        )}
      </section>
    </main>
  )
}
