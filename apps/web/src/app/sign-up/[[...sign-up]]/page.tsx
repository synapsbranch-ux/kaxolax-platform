import { SignUp } from '@clerk/nextjs'
import { AuthShell } from '@/components/auth/auth-shell'

export default function SignUpPage() {
  return (
    <AuthShell>
      <SignUp
        path="/sign-up"
        routing="path"
        signInUrl="/sign-in"
        fallbackRedirectUrl="/dashboard"
      />
    </AuthShell>
  )
}
