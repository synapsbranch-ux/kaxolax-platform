import type { Metadata } from 'next'
import { JoinPage } from '@/components/sharing/join-page'

export const metadata: Metadata = {
  title: 'Rejoindre un projet · Kaxolax',
  referrer: 'no-referrer',
}

/** Page publique d'un lien de partage : aperçu, puis adhésion une fois connecté. */
export default async function SharePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params
  return <JoinPage kind="share" token={token} />
}
