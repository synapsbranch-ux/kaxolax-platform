import { UserProfile } from '@clerk/nextjs'
import Link from 'next/link'

/**
 * Compte : profil, sécurité (MFA, sessions et appareils), facturation (onglet Billing de Clerk :
 * abonnement, factures, moyens de paiement ; affiché quand Billing est activé pour les
 * utilisateurs) et suppression, gérés par Clerk.
 */
export default function AccountPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col items-center gap-6 px-4 py-8">
      <Link href="/dashboard" className="self-start text-sm text-muted-foreground hover:underline">
        ← Tableau de bord
      </Link>
      <UserProfile path="/account" routing="path" />
    </main>
  )
}
