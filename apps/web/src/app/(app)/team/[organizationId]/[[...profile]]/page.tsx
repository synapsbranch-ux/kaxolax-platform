import type { Metadata } from 'next'
import Link from 'next/link'
import { TeamPage } from '@/components/teams/team-page'

export const metadata: Metadata = { title: 'Équipe — Kaxolax' }

/**
 * Page d'une équipe : `/team/<org_…>` et les pages de `<OrganizationProfile />` (membres,
 * invitations, facturation, projets, plan et usage) sous la même adresse.
 */
export default async function TeamProfilePage({
  params,
}: PageProps<'/team/[organizationId]/[[...profile]]'>) {
  const { organizationId } = await params
  return (
    <main className="mx-auto flex min-h-screen max-w-5xl flex-col items-center gap-6 px-4 py-8">
      <Link href="/dashboard" className="self-start text-sm text-muted-foreground hover:underline">
        ← Tableau de bord
      </Link>
      <TeamPage key={organizationId} clerkOrganizationId={decodeURIComponent(organizationId)} />
    </main>
  )
}
