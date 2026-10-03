import Link from 'next/link'
import { AccountProfile } from '@/components/billing/account-profile'

/**
 * Compte : profil, plan et usage (/account/plan), facturation (onglet Billing de Clerk :
 * abonnement, factures, moyens de paiement ; affiché quand Billing est activé pour les
 * utilisateurs), sécurité (MFA, sessions et appareils) et suppression, gérés par Clerk.
 */
export default function AccountPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col items-center gap-6 px-4 py-8">
      <Link href="/dashboard" className="self-start text-sm text-muted-foreground hover:underline">
        ← Tableau de bord
      </Link>
      <AccountProfile />
    </main>
  )
}
