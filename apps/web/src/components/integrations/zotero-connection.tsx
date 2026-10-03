'use client'

import type { ZoteroConnectionResponse } from '@kaxolax/contracts'
import { Alert, Button, Spinner } from '@kaxolax/ui'
import { useEffect, useState } from 'react'
import { zoteroApi, zoteroErrorMessage } from '@/lib/zotero'

/**
 * Connexion du compte à Zotero (Compte → Intégrations) : connecter (OAuth 1.0a sur zotero.org,
 * accès en lecture seule à la bibliothèque et aux groupes) ou déconnecter (la clé est révoquée
 * chez Zotero et effacée ; les projets liés avec elle ne se synchronisent plus).
 */
export function ZoteroConnection() {
  const [state, setState] = useState<ZoteroConnectionResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    const status = { live: true }
    zoteroApi.connection().then(
      (value) => {
        if (status.live) setState(value)
      },
      (caught: unknown) => {
        if (status.live) setError(zoteroErrorMessage(caught))
      },
    )
    return () => {
      status.live = false
    }
  }, [])

  const connect = async () => {
    setBusy(true)
    setError(null)
    try {
      const { authorizeUrl } = await zoteroApi.connect()
      window.location.assign(authorizeUrl)
    } catch (caught) {
      setError(zoteroErrorMessage(caught))
      setBusy(false)
    }
  }

  const disconnect = async () => {
    setBusy(true)
    setError(null)
    try {
      await zoteroApi.disconnect()
      setState((current) => (current ? { ...current, connection: null } : current))
    } catch (caught) {
      setError(zoteroErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border p-4" data-testid="zotero-connection">
      <div>
        <h2 className="font-medium">Zotero</h2>
        <p className="text-sm text-muted-foreground">
          Liez un projet à une bibliothèque ou une collection Zotero pour alimenter son fichier .bib
          et insérer des citations. Kaxolax demande un accès en lecture seule.
        </p>
      </div>
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      {state === null ? (
        error === null ? (
          <Spinner />
        ) : null
      ) : !state.available ? (
        <Alert>L’intégration Zotero n’est pas configurée sur ce service.</Alert>
      ) : state.connection === null ? (
        <div>
          <Button disabled={busy} onClick={() => void connect()}>
            {busy ? <Spinner /> : null}
            Connecter Zotero
          </Button>
        </div>
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-sm">
            Connecté en tant que{' '}
            <strong>
              {state.connection.username ?? `utilisateur ${state.connection.zoteroUserId}`}
            </strong>
          </p>
          <Button variant="outline" disabled={busy} onClick={() => void disconnect()}>
            Déconnecter
          </Button>
        </div>
      )}
    </section>
  )
}
