'use client'

import type { WordCountResponse } from '@kaxolax/contracts'
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  NativeSelect,
  Label,
  Spinner,
} from '@kaxolax/ui'
import { RefreshCwIcon } from 'lucide-react'
import { useEffect, useId, useState } from 'react'
import { api } from '@/lib/api'
import {
  formatCount,
  isWordCountPayload,
  SECTION_KIND_LABELS,
  sectionTitle,
  wordCountErrorMessage,
  wordCountRows,
} from '@/lib/word-count'
import type { ActionDialogProps } from '../action-dialogs'
import { useWorkspaceTools } from '../workspace-tools'
import { focusEditorOnClose } from '../writing/writing-common'

type Scope = 'main' | 'active'

type State =
  | { kind: 'loading' }
  | { kind: 'error'; message: string }
  | { kind: 'done'; result: WordCountResponse }

/**
 * Compteur de mots (menu Fichier, barre d'état) : texcount exécuté par le compilateur, dans le
 * sandbox, sur le document principal (et les fichiers qu'il inclut) ou sur le fichier ouvert.
 * Total, texte, titres, légendes, formules, puis détail par section.
 */
export default function WordCountDialog({ payload, context, onClose }: ActionDialogProps) {
  if (!isWordCountPayload(payload)) return null
  return <WordCount context={context} onClose={onClose} />
}

function WordCount({ context, onClose }: Omit<ActionDialogProps, 'payload'>) {
  const tools = useWorkspaceTools()
  const ids = useId()
  const active = tools.activeDocument
  const canCountActive =
    active !== null && active.id !== tools.mainDocument?.id && /\.(?:tex|ltx)$/i.test(active.path)
  const [scope, setScope] = useState<Scope>(
    tools.mainDocument === null && canCountActive ? 'active' : 'main',
  )
  const [attempt, setAttempt] = useState(0)
  const [state, setState] = useState<{ key: string; value: State } | null>(null)
  const documentId = scope === 'active' && active !== null ? active.id : null
  const key = `${documentId ?? 'main'}:${String(attempt)}`
  const { projectId, flush } = tools

  useEffect(() => {
    // Objet plutôt que variable : TypeScript ne garde pas le rétrécissement après un await.
    const status = { live: true }
    void (async () => {
      try {
        // Le comptage lit les documents enregistrés : les dernières frappes d'abord.
        await flush()
        const result = await api.wordCount(projectId, documentId)
        if (status.live) setState({ key, value: { kind: 'done', result } })
      } catch (caught) {
        if (status.live)
          setState({ key, value: { kind: 'error', message: wordCountErrorMessage(caught) } })
      }
    })()
    return () => {
      status.live = false
    }
  }, [projectId, documentId, flush, key])

  const current: State = state?.key === key ? state.value : { kind: 'loading' }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="max-h-[92dvh] grid-rows-[auto_auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-2xl"
        onCloseAutoFocus={(event) => {
          focusEditorOnClose(event, context)
        }}
        data-testid="word-count"
      >
        <DialogHeader>
          <DialogTitle>Compteur de mots</DialogTitle>
          <DialogDescription>
            Compté par texcount : commandes, formules et commentaires exclus, fichiers inclus
            comptés à leur place.
          </DialogDescription>
        </DialogHeader>
        {canCountActive ? (
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor={`${ids}-scope`}>Document</Label>
            <NativeSelect
              id={`${ids}-scope`}
              value={scope}
              onChange={(event) => {
                setScope(event.target.value === 'active' ? 'active' : 'main')
              }}
            >
              <option value="main">
                Document principal{tools.mainDocument ? ` (${tools.mainDocument.path})` : ''}
              </option>
              <option value="active">Fichier ouvert ({active.path})</option>
            </NativeSelect>
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">
            {tools.mainDocument ? (
              <>
                Document principal : <code>{tools.mainDocument.path}</code>
              </>
            ) : null}
          </p>
        )}
        <div
          className="min-h-0 overflow-y-auto"
          aria-live="polite"
          aria-busy={current.kind === 'loading'}
        >
          {current.kind === 'loading' ? (
            <p className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Spinner label="" /> Comptage en cours…
            </p>
          ) : current.kind === 'error' ? (
            <Alert variant="destructive" role="alert">
              {current.message}
            </Alert>
          ) : (
            <Results result={current.result} />
          )}
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            disabled={current.kind === 'loading'}
            onClick={() => {
              setAttempt((value) => value + 1)
            }}
            data-testid="word-count-refresh"
          >
            <RefreshCwIcon /> Recompter
          </Button>
          <Button onClick={onClose}>Fermer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function Results({ result }: { result: WordCountResponse }) {
  const { total } = result
  const rows = wordCountRows(result.sections)
  const tiles = [
    { label: 'Total', value: total.words, strong: true },
    { label: 'Texte', value: total.text },
    { label: 'Titres', value: total.headers },
    { label: 'Légendes', value: total.captions },
  ]
  return (
    <div className="grid gap-4">
      <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4" data-testid="word-count-total">
        {tiles.map((tile) => (
          <div key={tile.label} className="rounded-md border px-3 py-2">
            <dt className="text-xs text-muted-foreground">{tile.label}</dt>
            <dd className={tile.strong ? 'text-2xl font-semibold' : 'text-xl font-medium'}>
              {formatCount(tile.value)}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">
        {formatCount(total.headerCount)} titres · {formatCount(total.floatCount)} flottants ·{' '}
        {formatCount(total.inlineMathCount)} formules en ligne ·{' '}
        {formatCount(total.displayMathCount)} formules centrées · {result.rootResourcePath} ·{' '}
        {(result.durationMs / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s
      </p>
      {rows.length > 0 ? (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <caption className="sr-only">Détail par section</caption>
            <thead className="bg-muted text-xs text-muted-foreground">
              <tr>
                <th scope="col" className="px-3 py-1.5 text-left font-medium">
                  Section
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  Total
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  Texte
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  Titres
                </th>
                <th scope="col" className="px-2 py-1.5 text-right font-medium">
                  Légendes
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rows.map((row, index) => (
                <tr key={index}>
                  <th
                    scope="row"
                    className="max-w-72 truncate px-3 py-1.5 text-left font-normal"
                    style={{ paddingLeft: `${String(0.75 + row.depth * 1)}rem` }}
                    title={`${SECTION_KIND_LABELS[row.kind]} : ${sectionTitle(row)}`}
                  >
                    {sectionTitle(row)}
                  </th>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatCount(row.words)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{formatCount(row.text)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatCount(row.headers)}
                  </td>
                  <td className="px-2 py-1.5 text-right tabular-nums">
                    {formatCount(row.captions)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {result.warnings.length > 0 ? (
        <section className="grid gap-1">
          <h3 className="text-xs font-semibold uppercase text-muted-foreground">
            Avertissements de texcount
          </h3>
          <ul className="list-disc pl-5 text-xs">
            {result.warnings.map((warning, index) => (
              <li key={index}>{warning}</li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}
