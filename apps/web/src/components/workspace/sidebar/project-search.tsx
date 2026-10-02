'use client'

import type { ProjectSearchMatch, ProjectSearchResponse } from '@kaxolax/contracts'
import { MAX_SEARCH_QUERY_LENGTH } from '@kaxolax/contracts'
import { Button, Input, SimpleTooltip, Spinner, Toggle } from '@kaxolax/ui'
import {
  CaseSensitiveIcon,
  ChevronRightIcon,
  FileTextIcon,
  RegexIcon,
  WholeWordIcon,
  XIcon,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { api, errorMessage } from '@/lib/api'

/** Pause après la dernière frappe avant d'interroger l'API. */
const SEARCH_DEBOUNCE_MS = 300

interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
}

/** Occurrences regroupées par fichier, dans l'ordre renvoyé par l'API. */
function groupByFile(matches: readonly ProjectSearchMatch[]) {
  const groups = new Map<string, ProjectSearchMatch[]>()
  for (const match of matches) {
    const group = groups.get(match.path)
    if (group) group.push(match)
    else groups.set(match.path, [match])
  }
  return [...groups.entries()]
}

const toggleClass =
  'text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground data-[state=on]:bg-sidebar-primary data-[state=on]:text-sidebar-primary-foreground'

/**
 * Recherche dans tout le projet (loupe de la sidebar, Ctrl+Maj+F) : champ, options (casse, mot
 * entier, expression régulière), résultats groupés par fichier ; un clic ouvre le fichier à la
 * ligne et sélectionne l'occurrence. `request` change à chaque ouverture demandée (préremplissage
 * avec la sélection de l'éditeur).
 */
export function ProjectSearch({
  projectId,
  request,
  onOpenMatch,
  onClose,
}: {
  projectId: string
  request: { query: string; serial: number }
  onOpenMatch: (match: ProjectSearchMatch) => void
  onClose: () => void
}) {
  const [query, setQuery] = useState(request.query)
  const [options, setOptions] = useState<SearchOptions>({
    caseSensitive: false,
    wholeWord: false,
    regex: false,
  })
  const [state, setState] = useState<{
    key: string
    response: ProjectSearchResponse | null
    error: string | null
  } | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const input = useRef<HTMLInputElement>(null)
  const [handledSerial, setHandledSerial] = useState(request.serial)

  // Nouvelle demande d'ouverture : texte sélectionné repris (s'il y en a un) et champ sélectionné.
  if (handledSerial !== request.serial) {
    setHandledSerial(request.serial)
    if (request.query !== '') setQuery(request.query)
  }
  useEffect(() => {
    // Image suivante : la sidebar repliée vient d'être dépliée (elle n'est plus inerte).
    const frame = requestAnimationFrame(() => {
      input.current?.focus()
      input.current?.select()
    })
    return () => {
      cancelAnimationFrame(frame)
    }
  }, [request.serial])

  const trimmed = query.trim() === '' ? '' : query
  const key = JSON.stringify([trimmed, options])

  useEffect(() => {
    if (trimmed === '') return
    const run = { active: true }
    const timer = setTimeout(() => {
      api.search(projectId, { q: trimmed, ...options }).then(
        (response) => {
          if (run.active) setState({ key, response, error: null })
        },
        (caught: unknown) => {
          if (run.active) setState({ key, response: null, error: errorMessage(caught) })
        },
      )
    }, SEARCH_DEBOUNCE_MS)
    return () => {
      run.active = false
      clearTimeout(timer)
    }
  }, [projectId, trimmed, options, key])

  const current = state?.key === key ? state : null
  const loading = trimmed !== '' && current === null
  const groups = useMemo(() => groupByFile(current?.response?.matches ?? []), [current])

  const option = (name: keyof SearchOptions, label: string, Icon: typeof RegexIcon) => (
    <SimpleTooltip label={label}>
      <Toggle
        size="xs"
        className={toggleClass}
        pressed={options[name]}
        aria-label={label}
        onPressedChange={(pressed) => {
          setOptions((currentOptions) => ({ ...currentOptions, [name]: pressed }))
        }}
      >
        <Icon />
      </Toggle>
    </SimpleTooltip>
  )

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="project-search">
      <div className="flex shrink-0 items-center justify-between px-3 pt-2 text-xs font-semibold uppercase tracking-wide text-sidebar-muted-foreground">
        Rechercher dans le projet
        <Button
          variant="ghost"
          size="icon-xs"
          className="text-sidebar-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          aria-label="Fermer la recherche"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>
      <div className="shrink-0 space-y-1.5 px-2 py-2">
        <Input
          ref={input}
          value={query}
          maxLength={MAX_SEARCH_QUERY_LENGTH}
          placeholder={options.regex ? 'Expression régulière' : 'Rechercher'}
          aria-label="Texte recherché"
          className="h-8 border-sidebar-border bg-sidebar-accent/40 text-sidebar-foreground placeholder:text-sidebar-muted-foreground"
          onChange={(event) => {
            setQuery(event.target.value)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onClose()
            if (event.key === 'Enter') {
              const first = current?.response?.matches[0]
              if (first) onOpenMatch(first)
            }
          }}
          data-testid="project-search-input"
        />
        <div className="flex items-center gap-0.5">
          {option('caseSensitive', 'Respecter la casse', CaseSensitiveIcon)}
          {option('wholeWord', 'Mot entier', WholeWordIcon)}
          {option('regex', 'Expression régulière', RegexIcon)}
          <span className="ml-auto text-xs text-sidebar-muted-foreground" aria-live="polite">
            {loading ? (
              <Spinner label="Recherche…" className="size-3.5" />
            ) : current?.response ? (
              summary(current.response, groups.length)
            ) : null}
          </span>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto px-1 pb-2">
        {current?.error ? (
          <p className="px-2 text-xs text-destructive" role="alert">
            {current.error}
          </p>
        ) : null}
        {groups.map(([path, matches]) => {
          const open = !collapsed.has(path)
          return (
            <div key={path} data-testid="search-file">
              <button
                type="button"
                className="flex w-full items-center gap-1 rounded-md px-1.5 py-1 text-left text-sm hover:bg-sidebar-accent"
                aria-expanded={open}
                onClick={() => {
                  setCollapsed((currentSet) => {
                    const next = new Set(currentSet)
                    if (open) next.add(path)
                    else next.delete(path)
                    return next
                  })
                }}
              >
                <ChevronRightIcon
                  className={`size-3.5 shrink-0 transition-transform ${open ? 'rotate-90' : ''}`}
                />
                <FileTextIcon className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
                <span className="truncate font-medium">{path}</span>
                <span className="ml-auto rounded-full bg-sidebar-accent px-1.5 text-xs text-sidebar-muted-foreground">
                  {matches.length}
                </span>
              </button>
              {open ? (
                <ul>
                  {matches.map((match) => (
                    <li key={`${String(match.line)}:${String(match.column)}`}>
                      <button
                        type="button"
                        className="flex w-full items-baseline gap-2 rounded-md py-0.5 pl-7 pr-2 text-left font-mono text-xs hover:bg-sidebar-accent"
                        onClick={() => {
                          onOpenMatch(match)
                        }}
                        data-testid="search-match"
                      >
                        <span className="shrink-0 tabular-nums text-sidebar-muted-foreground">
                          {match.line}
                        </span>
                        <MatchPreview match={match} />
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          )
        })}
      </div>
    </div>
  )
}

function summary(response: ProjectSearchResponse, files: number): string {
  const count = response.matches.length
  if (count === 0) return 'Aucun résultat'
  const text = `${String(count)}${response.truncated ? '+' : ''} résultat${count > 1 ? 's' : ''} dans ${String(files)} fichier${files > 1 ? 's' : ''}`
  return response.timedOut ? `${text} (recherche interrompue)` : text
}

/** Extrait de ligne, occurrence surlignée. */
function MatchPreview({ match }: { match: ProjectSearchMatch }) {
  const start = match.previewStart
  const end = Math.min(start + match.length, match.preview.length)
  return (
    <span className="min-w-0 truncate whitespace-pre">
      {match.preview.slice(0, start).trimStart()}
      <mark className="rounded-sm bg-editor-match px-px text-sidebar-foreground">
        {match.preview.slice(start, end)}
      </mark>
      {match.preview.slice(end)}
    </span>
  )
}
