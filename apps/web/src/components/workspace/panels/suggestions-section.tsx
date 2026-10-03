'use client'

import type { SuggestionResolution } from '@kaxolax/collab'
import type { DecideSuggestionsInput, Suggestion } from '@kaxolax/contracts'
import { Badge, Button, cn, SimpleTooltip, Spinner } from '@kaxolax/ui'
import {
  CheckCheckIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  GitPullRequestDraftIcon,
  Undo2Icon,
  XIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { ConfirmDialog } from '@/components/confirm-dialog'
import type { ProjectTree } from '@/lib/api'
import { chatMember } from '@/lib/chat'
import {
  adjacentSuggestion,
  bulkDecision,
  filterSuggestions,
  orderSuggestions,
  SUGGESTION_KIND_LABELS,
  suggestionAuthors,
  suggestionDocuments,
  type SuggestionFilters,
  suggestionNotice,
} from '@/lib/suggestions'

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

const selectClass =
  'h-7 min-w-0 flex-1 rounded-md border border-editor-border bg-editor px-2 text-xs text-editor-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none'

/**
 * Section Suggestions du panneau Review (suivi des modifications) : suggestions ouvertes et
 * obsolètes du projet, filtrables par auteur et par document, dans l'ordre du texte du document
 * actif ; un clic saute à la suggestion dans l'éditeur. L'éditeur et le propriétaire acceptent ou
 * refusent une suggestion, toutes celles affichées (filtres appliqués) ou toutes celles d'un
 * auteur, et écartent une suggestion obsolète (refus) ; chacun retire ses propres suggestions
 * ouvertes ou obsolètes.
 */
export function SuggestionsSection({
  tree,
  suggestions,
  status,
  error,
  onRetry,
  positions,
  activeDocumentId,
  selectedId,
  onSelect,
  canDecide,
  selfId,
  filters,
  onFiltersChange,
  onDecide,
  onWithdraw,
}: {
  tree: ProjectTree | null
  suggestions: readonly Suggestion[]
  status: 'loading' | 'ready' | 'error'
  error: string | null
  onRetry: () => void
  /** Positions des suggestions du document actif (résolues dans l'éditeur). */
  positions: ReadonlyMap<string, SuggestionResolution>
  activeDocumentId: string | null
  selectedId: string | null
  onSelect: (id: string) => void
  canDecide: boolean
  selfId: string | null
  filters: SuggestionFilters
  onFiltersChange: (filters: SuggestionFilters) => void
  onDecide: (input: DecideSuggestionsInput) => Promise<void>
  onWithdraw: (id: string) => Promise<void>
}) {
  const authors = useMemo(() => suggestionAuthors(suggestions), [suggestions])
  const documents = useMemo(() => suggestionDocuments(suggestions, tree), [suggestions, tree])
  const ordered = useMemo(
    () =>
      orderSuggestions(filterSuggestions(suggestions, filters), {
        tree,
        activeDocumentId,
        positions,
      }),
    [suggestions, filters, tree, activeDocumentId, positions],
  )
  const openCount = ordered.filter((suggestion) => suggestion.status === 'open').length
  // « Tout refuser » écarte aussi les obsolètes affichées.
  const rejectCount = ordered.length
  const [confirming, setConfirming] = useState<'accept' | 'reject' | null>(null)
  const [busy, setBusy] = useState(false)

  // La suggestion sélectionnée reste visible dans la liste.
  const list = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (selectedId === null) return
    list.current
      ?.querySelector(`[data-suggestion-id="${selectedId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId])

  const navigate = (direction: 1 | -1) => {
    const next = adjacentSuggestion(ordered, selectedId, direction)
    if (next !== null) onSelect(next)
  }

  const run = (action: Promise<void>) => {
    setBusy(true)
    void action.finally(() => {
      setBusy(false)
    })
  }

  const authorName = authors.find((author) => author.id === filters.authorId)?.name ?? null
  const scopeLabel =
    authorName === null ? 'toutes les suggestions affichées' : `celles de ${authorName}`

  return (
    <>
      <div className="flex shrink-0 flex-col gap-2 border-b border-editor-border px-3 py-2">
        <div className="flex items-center gap-2">
          <select
            className={selectClass}
            aria-label="Filtrer par auteur"
            value={filters.authorId ?? ''}
            onChange={(event) => {
              onFiltersChange({ ...filters, authorId: event.target.value || null })
            }}
            data-testid="suggestions-author-filter"
          >
            <option value="">Tous les auteurs</option>
            {authors.map((author) => (
              <option key={author.id} value={author.id}>
                {author.name} ({author.open})
              </option>
            ))}
          </select>
          <select
            className={selectClass}
            aria-label="Filtrer par document"
            value={filters.documentId ?? ''}
            onChange={(event) => {
              onFiltersChange({ ...filters, documentId: event.target.value || null })
            }}
            data-testid="suggestions-document-filter"
          >
            <option value="">Tous les documents</option>
            {documents.map((document) => (
              <option key={document.id} value={document.id}>
                {document.path}
              </option>
            ))}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <SimpleTooltip label="Suggestion précédente">
            <Button
              variant="ghost"
              size="icon-xs"
              className="hover:bg-editor-tab-active"
              aria-label="Suggestion précédente"
              disabled={ordered.length === 0}
              onClick={() => {
                navigate(-1)
              }}
              data-testid="suggestion-previous"
            >
              <ChevronUpIcon />
            </Button>
          </SimpleTooltip>
          <SimpleTooltip label="Suggestion suivante">
            <Button
              variant="ghost"
              size="icon-xs"
              className="hover:bg-editor-tab-active"
              aria-label="Suggestion suivante"
              disabled={ordered.length === 0}
              onClick={() => {
                navigate(1)
              }}
              data-testid="suggestion-next"
            >
              <ChevronDownIcon />
            </Button>
          </SimpleTooltip>
          {canDecide ? (
            <span className="ml-auto flex gap-1">
              <Button
                variant="ghost"
                size="xs"
                className="hover:bg-editor-tab-active"
                disabled={openCount === 0 || busy}
                onClick={() => {
                  setConfirming('accept')
                }}
                data-testid="suggestions-accept-all"
              >
                <CheckCheckIcon /> Tout accepter
              </Button>
              <Button
                variant="ghost"
                size="xs"
                className="hover:bg-editor-tab-active"
                disabled={rejectCount === 0 || busy}
                onClick={() => {
                  setConfirming('reject')
                }}
                data-testid="suggestions-reject-all"
              >
                <XIcon /> Tout refuser
              </Button>
            </span>
          ) : null}
        </div>
      </div>

      <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-2">
        {status === 'loading' ? (
          <p className="flex items-center justify-center gap-2 p-6 text-sm text-editor-gutter-foreground">
            <Spinner label="" /> Chargement des suggestions…
          </p>
        ) : status === 'error' ? (
          <div className="flex flex-col items-center gap-2 p-6 text-center text-sm">
            <p role="alert" className="text-destructive">
              {error ?? 'Impossible de charger les suggestions.'}
            </p>
            <Button variant="outline" size="xs" onClick={onRetry}>
              Réessayer
            </Button>
          </div>
        ) : ordered.length === 0 ? (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-editor-gutter-foreground">
            <GitPullRequestDraftIcon className="size-6" />
            <p className="text-sm">
              {suggestions.length === 0
                ? 'Aucune suggestion. Passez en mode Suggérer pour proposer des modifications.'
                : 'Aucune suggestion pour ces filtres.'}
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2" aria-label="Suggestions">
            {ordered.map((suggestion) => (
              <SuggestionCard
                key={suggestion.id}
                suggestion={suggestion}
                documentName={
                  suggestion.documentId === activeDocumentId
                    ? null
                    : (tree?.documents.find((document) => document.id === suggestion.documentId)
                        ?.path ?? 'Document')
                }
                resolution={
                  suggestion.documentId === activeDocumentId
                    ? positions.get(suggestion.id)
                    : undefined
                }
                selected={suggestion.id === selectedId}
                canDecide={canDecide}
                mine={suggestion.author.id === selfId}
                busy={busy}
                onSelect={() => {
                  onSelect(suggestion.id)
                }}
                onDecide={(decision) => {
                  run(onDecide({ decision, ids: [suggestion.id] }))
                }}
                onWithdraw={() => {
                  run(onWithdraw(suggestion.id))
                }}
              />
            ))}
          </ul>
        )}
      </div>

      <ConfirmDialog
        open={confirming !== null}
        title={confirming === 'accept' ? 'Accepter les suggestions ?' : 'Refuser les suggestions ?'}
        description={
          confirming === 'accept'
            ? `Le texte proposé remplace le texte d’origine pour ${scopeLabel} (${String(openCount)}), au nom de leurs auteurs.`
            : `Les suggestions sont écartées, obsolètes comprises, le texte ne change pas : ${scopeLabel} (${String(rejectCount)}).`
        }
        confirmLabel={confirming === 'accept' ? 'Tout accepter' : 'Tout refuser'}
        onConfirm={() => {
          if (confirming !== null) run(onDecide(bulkDecision(confirming, filters)))
        }}
        onOpenChange={(open) => {
          if (!open) setConfirming(null)
        }}
      />
    </>
  )
}

function SuggestionCard({
  suggestion,
  documentName,
  resolution,
  selected,
  canDecide,
  mine,
  busy,
  onSelect,
  onDecide,
  onWithdraw,
}: {
  suggestion: Suggestion
  documentName: string | null
  resolution: SuggestionResolution | undefined
  selected: boolean
  canDecide: boolean
  mine: boolean
  busy: boolean
  onSelect: () => void
  onDecide: (decision: 'accept' | 'reject') => void
  onWithdraw: () => void
}) {
  const author = chatMember(
    suggestion.author.id,
    suggestion.author.fullName,
    suggestion.author.avatarUrl,
  )
  const open = suggestion.status === 'open'
  const stale = suggestion.status === 'stale'
  const notice = suggestionNotice(suggestion, resolution)
  return (
    <li
      data-suggestion-id={suggestion.id}
      data-testid="suggestion-card"
      data-status={suggestion.status}
      className={cn(
        'cursor-pointer rounded-md border border-editor-border bg-editor p-2 text-sm',
        selected && 'ring-2',
      )}
      style={selected ? { ['--tw-ring-color' as string]: author.color } : undefined}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.target === event.currentTarget && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault()
          onSelect()
        }
      }}
      tabIndex={0}
      aria-label={`${SUGGESTION_KIND_LABELS[suggestion.kind]} suggéré par ${author.name}`}
    >
      {documentName !== null ? (
        <p className="mb-1 truncate text-xs text-editor-gutter-foreground">{documentName}</p>
      ) : null}
      <p className="mb-1 flex items-center gap-1.5 text-xs">
        <span
          className="size-2 shrink-0 rounded-full"
          style={{ backgroundColor: author.color }}
          aria-hidden
        />
        <span className="truncate font-medium">{author.name}</span>
        {suggestion.origin === 'ai' ? (
          <Badge variant="outline" className="h-4 px-1 text-[10px]">
            IA
          </Badge>
        ) : null}
        <span className="ml-auto shrink-0 text-editor-gutter-foreground">
          {dateLabel(suggestion.createdAt)}
        </span>
      </p>
      <p className="mb-1 flex items-center gap-1 text-xs text-editor-gutter-foreground">
        {SUGGESTION_KIND_LABELS[suggestion.kind]}
        {suggestion.status === 'stale' ? (
          <Badge
            variant="secondary"
            className="h-4 px-1 text-[10px]"
            data-testid="suggestion-stale"
          >
            Obsolète
          </Badge>
        ) : null}
      </p>
      <div className="line-clamp-4 font-mono text-xs break-words whitespace-pre-wrap">
        {suggestion.originalText !== '' ? (
          <del
            className="opacity-75"
            style={{ textDecorationColor: author.color, textDecorationThickness: 2 }}
            data-testid="suggestion-original"
          >
            {suggestion.originalText}
          </del>
        ) : null}
        {suggestion.proposedText !== '' ? (
          <ins
            className="no-underline"
            style={{
              textDecorationLine: 'underline',
              textDecorationColor: author.color,
              textDecorationThickness: 2,
              backgroundColor: `color-mix(in oklab, ${author.color} 22%, transparent)`,
            }}
            data-testid="suggestion-proposed"
          >
            {suggestion.proposedText}
          </ins>
        ) : null}
      </div>
      {notice !== null ? (
        <p
          className="mt-1 text-xs text-editor-gutter-foreground italic"
          data-testid="suggestion-notice"
        >
          {notice}
        </p>
      ) : null}
      {(open || stale) && (canDecide || mine) ? (
        <div className="mt-2 flex justify-end gap-1">
          {mine ? (
            <Button
              variant="ghost"
              size="xs"
              className="mr-auto hover:bg-editor-tab-active"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation()
                onWithdraw()
              }}
              data-testid="suggestion-withdraw"
            >
              <Undo2Icon /> Retirer
            </Button>
          ) : null}
          {canDecide && stale ? (
            <Button
              variant="ghost"
              size="xs"
              className="hover:bg-editor-tab-active"
              disabled={busy}
              aria-label={`Écarter la suggestion obsolète de ${author.name}`}
              onClick={(event) => {
                event.stopPropagation()
                onDecide('reject')
              }}
              data-testid="suggestion-discard"
            >
              <XIcon /> Écarter
            </Button>
          ) : null}
          {canDecide && open ? (
            <>
              <Button
                variant="ghost"
                size="xs"
                className="hover:bg-editor-tab-active"
                disabled={busy}
                aria-label={`Refuser la suggestion de ${author.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onDecide('reject')
                }}
                data-testid="suggestion-reject"
              >
                <XIcon /> Refuser
              </Button>
              <Button
                variant="outline"
                size="xs"
                disabled={busy}
                aria-label={`Accepter la suggestion de ${author.name}`}
                onClick={(event) => {
                  event.stopPropagation()
                  onDecide('accept')
                }}
                data-testid="suggestion-accept"
              >
                <CheckIcon /> Accepter
              </Button>
            </>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}
