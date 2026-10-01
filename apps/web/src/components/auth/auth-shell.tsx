import type { ReactNode } from 'react'

/** Mise en page des écrans de connexion et d'inscription (composants Clerk). */
export function AuthShell({ children }: { children: ReactNode }) {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-8">
      <p className="text-2xl font-bold tracking-tight">kaxolax</p>
      {children}
    </main>
  )
}
