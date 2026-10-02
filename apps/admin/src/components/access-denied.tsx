'use client'

import { SignOutButton } from '@clerk/nextjs'
import { Button } from '@kaxolax/ui'

/**
 * Refus d'accès : même message quelle que soit la raison (rôle absent, second facteur non
 * vérifié, refus de l'API), pour ne rien révéler de la configuration des comptes.
 */
export function AccessDenied() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6 text-center">
      <p className="text-sm font-medium uppercase tracking-widest text-muted-foreground">
        Kaxolax · Admin
      </p>
      <h1 className="text-xl font-semibold">Accès refusé</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        Ce compte ne peut pas ouvrir cet espace. Si vous pensez que c'est une erreur,
        reconnectez-vous en validant la vérification en deux étapes.
      </p>
      <SignOutButton redirectUrl="/sign-in">
        <Button variant="outline">Se déconnecter</Button>
      </SignOutButton>
    </main>
  )
}
