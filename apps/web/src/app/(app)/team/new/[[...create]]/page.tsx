import type { Metadata } from 'next'
import Link from 'next/link'
import { CreateTeam } from '@/components/teams/team-page'

export const metadata: Metadata = { title: 'Nouvelle équipe — Kaxolax' }

/**
 * Création d'une équipe (Organisation Clerk) : nom, logo, puis invitations. L'équipe devient un
 * workspace partagé dès sa synchronisation (webhook Clerk, ou rattrapage par sa page).
 */
export default function NewTeamPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col items-center gap-6 px-4 py-8">
      <Link href="/dashboard" className="self-start text-sm text-muted-foreground hover:underline">
        ← Tableau de bord
      </Link>
      <div className="flex flex-col gap-1 self-start">
        <h1 className="text-2xl font-semibold tracking-tight">Créer une équipe</h1>
        <p className="text-sm text-muted-foreground">
          Un workspace partagé : ses membres accèdent à tous ses projets, et le plan Team (facturé
          par siège) mutualise stockage et crédits IA.
        </p>
      </div>
      <CreateTeam />
    </main>
  )
}
