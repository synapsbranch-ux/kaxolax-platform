'use client'

import type { ZoteroSearchItem } from '@kaxolax/contracts'
import { insertCitation } from '@kaxolax/editor'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Spinner,
} from '@kaxolax/ui'
import { useEffect, useState } from 'react'
import { ZOTERO_SEARCH_MIN_LENGTH } from '@kaxolax/contracts'
import { zoteroApi, zoteroErrorMessage, ZOTERO_DIALOGS } from '@/lib/zotero'
import type { ActionDialogProps } from '../action-dialogs'
import { useWorkspaceTools } from '../workspace-tools'
import { focusEditorOnClose } from '../writing/writing-common'

/** Pause de frappe avant la recherche. */
const SEARCH_DELAY_MS = 300

type Results =
  | { kind: 'idle' }
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; items: ZoteroSearchItem[] }

/**
 * Sélecteur de citations Zotero (menu Structures, « Insérer une citation Zotero ») : recherche
 * dans la bibliothèque liée (titre, auteurs, année), puis insertion de `\cite{clé}` au curseur
 * (ou ajout à la citation sous le curseur) ; l'entrée manquante est ajoutée au `.bib` lié.
 */
export default function ZoteroCitationDialog({ context, onClose }: ActionDialogProps) {
  const { projectId } = useWorkspaceTools()
  const [query, setQuery] = useState('')
  // Résultats de la dernière recherche, avec le texte cherché.
  const [found, setFound] = useState<{ query: string; results: Results } | null>(null)
  const text = query.trim()
  const results: Results =
    text.length < ZOTERO_SEARCH_MIN_LENGTH
      ? { kind: 'idle' }
      : found?.query === text
        ? found.results
        : { kind: 'loading' }
  const [inserting, setInserting] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (text.length < ZOTERO_SEARCH_MIN_LENGTH) return
    const controller = new AbortController()
    const timer = setTimeout(() => {
      zoteroApi.search(projectId, text, controller.signal).then(
        (items) => {
          setFound({ query: text, results: { kind: 'done', items } })
        },
        (caught: unknown) => {
          if (!controller.signal.aborted) {
            setFound({
              query: text,
              results: { kind: 'error', message: zoteroErrorMessage(caught) },
            })
          }
        },
      )
    }, SEARCH_DELAY_MS)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [projectId, text])

  const insert = async (item: ZoteroSearchItem) => {
    setInserting(item.itemKey)
    setError(null)
    try {
      const { citationKey } = await zoteroApi.addCitation(projectId, item.itemKey)
      const view = context().view
      if (view === null || !insertCitation(view, citationKey)) {
        setError('Ouvrez un fichier modifiable pour insérer la citation.')
        return
      }
      onClose()
    } catch (caught) {
      setError(zoteroErrorMessage(caught))
    } finally {
      setInserting(null)
    }
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="max-h-[92dvh] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          focusEditorOnClose(event, context)
        }}
        data-testid="zotero-citation-picker"
      >
        <DialogHeader>
          <DialogTitle>Insérer une citation Zotero</DialogTitle>
          <DialogDescription>
            Recherche dans la bibliothèque ou la collection liée au projet : la clé est insérée au
            curseur et la référence ajoutée au fichier .bib si elle n’y est pas.
          </DialogDescription>
        </DialogHeader>
        <Input
          autoFocus
          aria-label="Rechercher une référence"
          placeholder="Titre, auteur ou année"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
        />
        <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
          {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
          {results.kind === 'loading' ? (
            <div className="flex justify-center py-4">
              <Spinner />
            </div>
          ) : results.kind === 'error' ? (
            <Alert variant="destructive">
              {results.message}{' '}
              <button
                type="button"
                className="underline"
                onClick={() => {
                  context().host.openDialog?.(ZOTERO_DIALOGS.panel)
                }}
              >
                Ouvrir le panneau Zotero
              </button>
            </Alert>
          ) : results.kind === 'done' && results.items.length === 0 ? (
            <p className="py-4 text-center text-sm text-muted-foreground">Aucune référence.</p>
          ) : results.kind === 'done' ? (
            <ul className="flex flex-col divide-y" data-testid="zotero-results">
              {results.items.map((item) => (
                <li key={item.itemKey} className="flex items-start justify-between gap-3 py-2">
                  <div className="min-w-0 text-sm">
                    <p className="font-medium">{item.title || 'Sans titre'}</p>
                    <p className="text-muted-foreground">
                      {[item.creators, item.year].filter(Boolean).join(' · ')}
                      {item.citationKey ? (
                        <span className="ml-2 font-mono text-xs">{item.citationKey}</span>
                      ) : null}
                    </p>
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    {item.inBibliography ? <Badge variant="secondary">Dans le .bib</Badge> : null}
                    <Button
                      size="sm"
                      disabled={inserting !== null || item.citationKey === null}
                      onClick={() => void insert(item)}
                    >
                      {inserting === item.itemKey ? <Spinner /> : null}
                      Insérer
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="py-4 text-center text-sm text-muted-foreground">
              Tapez au moins {ZOTERO_SEARCH_MIN_LENGTH} caractères.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
