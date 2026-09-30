import { Button } from '@kaxolax/ui'
import Link from 'next/link'

export default function NotFound() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-6xl font-bold text-muted-foreground">404</p>
      <h1 className="text-xl font-semibold">Page introuvable</h1>
      <p className="text-muted-foreground">Cette page n'existe pas, ou vous n'y avez pas accès.</p>
      <Button asChild>
        <Link href="/dashboard">Retour aux projets</Link>
      </Button>
    </main>
  )
}
