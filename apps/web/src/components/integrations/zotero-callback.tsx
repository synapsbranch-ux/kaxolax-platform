'use client'

import { Alert, Button, Spinner } from '@kaxolax/ui'
import Link from 'next/link'
import { useRouter, useSearchParams } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { zoteroApi, zoteroErrorMessage } from '@/lib/zotero'

/** Termine l'OAuth Zotero avec les paramètres de l'URL, une seule fois. */
export function ZoteroCallback() {
  const params = useSearchParams()
  const router = useRouter()
  const [failure, setFailure] = useState<string | null>(null)
  const started = useRef(false)
  const oauthToken = params.get('oauth_token')
  const oauthVerifier = params.get('oauth_verifier')
  const state = params.get('state')
  // Refus sur zotero.org, ou adresse incomplète.
  const incomplete = oauthToken === null || oauthVerifier === null || state === null
  const error = incomplete ? 'Autorisation Zotero annulée ou incomplète.' : failure

  useEffect(() => {
    if (started.current || oauthToken === null || oauthVerifier === null || state === null) return
    started.current = true
    zoteroApi.complete({ oauthToken, oauthVerifier, state }).then(
      () => {
        router.replace('/account/integrations')
      },
      (caught: unknown) => {
        setFailure(zoteroErrorMessage(caught))
      },
    )
  }, [oauthToken, oauthVerifier, state, router])

  if (error === null) {
    return (
      <div className="flex items-center gap-3 text-sm" role="status">
        <Spinner />
        Connexion de Zotero…
      </div>
    )
  }
  return (
    <>
      <Alert variant="destructive">{error}</Alert>
      <Button asChild variant="outline">
        <Link href="/account/integrations">Retour aux intégrations</Link>
      </Button>
    </>
  )
}
