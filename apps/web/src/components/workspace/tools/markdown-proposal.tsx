'use client'

import { MARKDOWN_IMPORT_DIALOG, type MarkdownImportPayload } from '@kaxolax/editor'
import { Button } from '@kaxolax/ui'
import { FileDownIcon, XIcon } from 'lucide-react'
import { useEffect } from 'react'

/** Proposition affichée : texte collé, ou fichier `.md` tout juste uploadé. */
export interface MarkdownProposalState {
  /** Identifiant (une nouvelle proposition remplace la précédente). */
  id: string
  message: string
  payload: MarkdownImportPayload
}

/** Durée d'affichage d'une proposition sans réponse. */
const PROPOSAL_MS = 15_000

/**
 * Proposition de conversion non bloquante (collage intelligent, upload d'un `.md`) : « Convertir
 * en LaTeX » ouvre la boîte « Importer du Markdown », « Ignorer » ou le délai la ferment. Le
 * texte collé reste tel quel tant que l'utilisateur n'a rien choisi.
 */
export function MarkdownProposal({
  proposal,
  onConvert,
  onDismiss,
}: {
  proposal: MarkdownProposalState | null
  onConvert: (dialog: string, payload: MarkdownImportPayload) => void
  onDismiss: (id: string) => void
}) {
  // Délai lié à l'identifiant : un nouveau rendu de la même proposition ne le relance pas.
  const id = proposal?.id ?? null
  useEffect(() => {
    if (id === null) return
    const timer = setTimeout(() => {
      onDismiss(id)
    }, PROPOSAL_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [id, onDismiss])

  if (proposal === null) return null
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="markdown-proposal"
      className="fixed right-4 bottom-4 z-50 flex max-w-sm items-start gap-3 rounded-lg border bg-popover p-3 text-sm text-popover-foreground shadow-lg"
    >
      <FileDownIcon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <div className="grid gap-2">
        <p>{proposal.message}</p>
        <div className="flex gap-2">
          <Button
            size="xs"
            onClick={() => {
              onDismiss(proposal.id)
              onConvert(MARKDOWN_IMPORT_DIALOG, proposal.payload)
            }}
          >
            Convertir en LaTeX
          </Button>
          <Button
            size="xs"
            variant="outline"
            onClick={() => {
              onDismiss(proposal.id)
            }}
          >
            Ignorer
          </Button>
        </div>
      </div>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Fermer"
        onClick={() => {
          onDismiss(proposal.id)
        }}
      >
        <XIcon />
      </Button>
    </div>
  )
}
