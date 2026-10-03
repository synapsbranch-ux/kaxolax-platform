import { Suspense } from 'react'
import { ZoteroCallback } from '@/components/integrations/zotero-callback'

/**
 * Retour de zotero.org après l'autorisation (URL de rappel de l'application OAuth :
 * `APP_URL/integrations/zotero/callback`) : la page termine la connexion auprès de l'API avec la
 * session Clerk qui l'a lancée, puis revient aux intégrations du compte.
 */
export default function ZoteroCallbackPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-4 px-4">
      <Suspense>
        <ZoteroCallback />
      </Suspense>
    </main>
  )
}
