'use client'

import {
  filterTemplates,
  TEMPLATE_CATEGORIES,
  type TemplateCategory,
  type TemplateSummary,
} from '@kaxolax/contracts'
import { Alert, Button, Input, Skeleton, cn } from '@kaxolax/ui'
import { SearchIcon } from 'lucide-react'
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import { api, errorMessage } from '@/lib/api'
import { CATEGORY_LABELS } from '@/lib/templates'
import { TemplateCard } from './template-card'

/**
 * Galerie : recherche (titre, description, mots-clés, sans tenir compte des accents), filtre par
 * catégorie avec compteurs, et grille de cartes. La recherche est faite dans le navigateur avec
 * la même fonction que l'API (`filterTemplates`), sur le catalogue chargé une fois : `initial`
 * (rendu serveur) ou `GET /api/v1/templates`.
 */
export function TemplateGallery({
  initial = null,
  onOpen,
  autoFocusSearch = false,
}: {
  initial?: TemplateSummary[] | null
  /** Ouverture d'un template dans la même vue (boîte de dialogue) ; sinon lien vers sa fiche. */
  onOpen?: (template: TemplateSummary) => void
  autoFocusSearch?: boolean
}) {
  const [templates, setTemplates] = useState<TemplateSummary[] | null>(initial)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<TemplateCategory | null>(null)
  const searchId = useId()

  const load = useCallback(() => {
    setError(null)
    api.templates().then(
      (response) => {
        setTemplates(response.templates)
      },
      (caught: unknown) => {
        setError(errorMessage(caught))
      },
    )
  }, [])

  useEffect(() => {
    if (initial !== null) return
    const timer = setTimeout(load, 0)
    return () => {
      clearTimeout(timer)
    }
  }, [initial, load])

  const filtered = useMemo(
    () =>
      templates === null
        ? null
        : filterTemplates(templates, { q: query, category: category ?? undefined }),
    [templates, query, category],
  )
  const total = filtered?.categories.reduce((sum, item) => sum + item.count, 0) ?? 0

  return (
    <div className="flex flex-col gap-4">
      <div className="relative">
        <label htmlFor={searchId} className="sr-only">
          Rechercher un template
        </label>
        <SearchIcon
          className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground"
          aria-hidden
        />
        <Input
          id={searchId}
          type="search"
          placeholder="Rechercher : thèse, beamer, CV…"
          className="pl-8"
          value={query}
          autoFocus={autoFocusSearch}
          onChange={(event) => {
            setQuery(event.target.value)
          }}
          data-testid="template-search"
        />
      </div>

      <div
        role="group"
        aria-label="Catégories"
        className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1"
      >
        <CategoryButton
          label="Tous"
          count={total}
          pressed={category === null}
          onClick={() => {
            setCategory(null)
          }}
        />
        {TEMPLATE_CATEGORIES.map((id) => (
          <CategoryButton
            key={id}
            label={CATEGORY_LABELS[id]}
            count={filtered?.categories.find((item) => item.id === id)?.count ?? 0}
            pressed={category === id}
            onClick={() => {
              setCategory(category === id ? null : id)
            }}
          />
        ))}
      </div>

      {error !== null ? (
        <Alert variant="destructive" className="flex flex-wrap items-center gap-3">
          <span>Impossible de charger la galerie : {error}</span>
          <Button size="sm" variant="outline" onClick={load}>
            Réessayer
          </Button>
        </Alert>
      ) : null}

      <p className="sr-only" aria-live="polite">
        {filtered === null
          ? ''
          : `${String(filtered.templates.length)} template${filtered.templates.length > 1 ? 's' : ''}`}
      </p>

      {filtered === null && error === null ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" aria-busy="true">
          {[0, 1, 2].map((index) => (
            <Skeleton key={index} className="aspect-[4/5] rounded-lg" />
          ))}
          <span className="sr-only">Chargement de la galerie…</span>
        </div>
      ) : null}

      {filtered !== null && filtered.templates.length === 0 ? (
        <p className="py-12 text-center text-sm text-muted-foreground">
          Aucun template ne correspond à votre recherche.
        </p>
      ) : null}

      {filtered !== null && filtered.templates.length > 0 ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="template-grid">
          {filtered.templates.map((template, index) => (
            <li key={template.id}>
              <TemplateCard template={template} onOpen={onOpen} priority={index < 3} />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function CategoryButton({
  label,
  count,
  pressed,
  onClick,
}: {
  label: string
  count: number
  pressed: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-3 text-sm outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/50',
        pressed
          ? 'border-primary bg-primary text-primary-foreground'
          : 'bg-background text-muted-foreground hover:bg-accent hover:text-accent-foreground',
      )}
    >
      {label}
      <span className={cn('text-xs tabular-nums', pressed ? 'opacity-80' : 'opacity-70')}>
        {count}
      </span>
    </button>
  )
}
