import type { Metadata } from 'next'
import { JoinPage } from '@/components/sharing/join-page'

export const metadata: Metadata = { title: 'Invitation · Kaxolax', referrer: 'no-referrer' }

/** Page publique d'une invitation par email : aperçu, puis acceptation une fois connecté. */
export default async function InvitationPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <JoinPage kind="invitation" token={token} />
}
