import { SignIn } from '@clerk/nextjs'

/** Connexion (composant Clerk) ; la MFA est demandée par Clerk aux comptes qui l'ont activée. */
export default function SignInPage() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-4 py-8">
      <p className="text-2xl font-bold tracking-tight">
        kaxolax <span className="font-normal text-muted-foreground">admin</span>
      </p>
      <SignIn path="/sign-in" routing="path" withSignUp={false} fallbackRedirectUrl="/users" />
    </main>
  )
}
