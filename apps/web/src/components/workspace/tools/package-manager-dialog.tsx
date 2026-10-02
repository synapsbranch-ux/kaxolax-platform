'use client'

import type { TexlivePackageDetail, TexlivePackageList } from '@kaxolax/contracts'
import {
  addPackage,
  goToLine,
  type PackageManagerPayload,
  type ProjectPackage,
  projectPackages,
  removePackage,
  setPackageOptions,
} from '@kaxolax/editor'
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
  Label,
  NativeSelect,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
  cn,
} from '@kaxolax/ui'
import { BookOpenIcon, ExternalLinkIcon, SearchIcon } from 'lucide-react'
import { useEffect, useId, useState, useSyncExternalStore } from 'react'
import { api } from '@/lib/api'
import {
  addPackageMessage,
  isPackageManagerPayload,
  parsePackageOptions,
  texliveErrorMessage,
} from '@/lib/package-tools'
import type { ActionDialogProps } from '../action-dialogs'
import { useWorkspaceTools } from '../workspace-tools'
import { focusEditorOnClose } from '../writing/writing-common'

/** Pause de frappe avant la recherche dans l'index. */
const SEARCH_DELAY_MS = 250
const PER_PAGE = 20

type Tab = 'search' | 'project'

/**
 * Gestionnaire de packages (menu Packages) : recherche dans l'index de TeX Live servi par l'API
 * (nom, fichiers `.sty`, description), fiche (description, catégorie, sujets, licence, liens
 * CTAN et documentation), ajout d'un `\usepackage` avec options, et liste des packages du
 * document : options, retrait, ligne. Lecture seule : liste et recherche seulement.
 */
export default function PackageManagerDialog({ payload, context, onClose }: ActionDialogProps) {
  if (!isPackageManagerPayload(payload)) return null
  return <PackageManager payload={payload} context={context} onClose={onClose} />
}

function PackageManager({
  payload,
  context,
  onClose,
}: Omit<ActionDialogProps, 'payload'> & { payload: PackageManagerPayload }) {
  const tools = useWorkspaceTools()
  const index = tools.projectIndex
  // Index relu à chaque modification (packages du document principal, lu en direct).
  useSyncExternalStore(
    (listener) => index.subscribe(listener),
    () => index.version,
    () => index.version,
  )
  const mainDocument = tools.mainDocument
  const showMain =
    !payload.hasPreamble && mainDocument !== null && mainDocument.id !== tools.activeDocument?.id
  // Fichier sans préambule (chapitre inclus) : packages du document principal, en lecture seule.
  const mainPackages = showMain ? index.preamblePackages(mainDocument.path) : null
  const [tab, setTab] = useState<Tab>(
    payload.packages.length > 0 || (mainPackages?.length ?? 0) > 0 ? 'project' : 'search',
  )
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  // Relecture du préambule après chaque modification.
  const [, setRevision] = useState(0)
  const [message, setMessage] = useState<{ text: string; level: 'info' | 'warning' } | null>(null)
  const view = context().view
  const readOnly = payload.readOnly || view === null || context().host.readOnly === true
  const packages =
    mainPackages ?? (view === null ? payload.packages : projectPackages(view.state.doc))
  const loadedNames = new Set(packages.map((entry) => entry.name))

  const changed = (text: string, level: 'info' | 'warning' = 'info') => {
    setRevision((value) => value + 1)
    setMessage({ text, level })
  }

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="max-h-[92dvh] grid-rows-[auto_auto_minmax(0,1fr)] overflow-hidden sm:max-w-3xl"
        onCloseAutoFocus={(event) => {
          focusEditorOnClose(event, context)
        }}
        data-testid="package-manager"
      >
        <DialogHeader>
          <DialogTitle>Gestionnaire de packages</DialogTitle>
          <DialogDescription>
            {payload.hasPreamble
              ? 'Packages de TeX Live : recherche, ajout au préambule avec options, retrait.'
              : 'Ce fichier n’a pas de préambule : les packages se chargent dans le document principal.'}
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-2">
          <Tabs
            value={tab}
            onValueChange={(value) => {
              if (value === 'search' || value === 'project') setTab(value)
            }}
          >
            <TabsList>
              <TabsTrigger value="search">Rechercher</TabsTrigger>
              <TabsTrigger value="project" data-testid="package-tab-project">
                {mainPackages === null ? 'Packages du document' : 'Packages du projet'} (
                {packages.length})
              </TabsTrigger>
            </TabsList>
          </Tabs>
          {message ? (
            <Alert
              role="status"
              variant={message.level === 'warning' ? 'destructive' : 'default'}
              className="py-2 text-sm"
            >
              {message.text}
            </Alert>
          ) : null}
          {showMain ? (
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              {mainPackages === null ? (
                <>
                  Le document principal est <code>{mainDocument.path}</code>.
                </>
              ) : (
                <>
                  Packages chargés par le document principal <code>{mainDocument.path}</code>{' '}
                  (ouvrez-le pour les modifier).
                </>
              )}
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  tools.openDocument(mainDocument.id)
                  onClose()
                }}
              >
                Ouvrir le document principal
              </Button>
            </div>
          ) : null}
        </div>
        <div className="min-h-0 overflow-hidden">
          {tab === 'search' ? (
            <SearchPane
              query={query}
              onQueryChange={setQuery}
              selected={selected}
              onSelect={setSelected}
              loaded={loadedNames}
              canAdd={!readOnly && payload.hasPreamble}
              onAdd={(name, options) => {
                if (view === null) return
                const status = addPackage(view, name, options)
                const result = addPackageMessage(name, status)
                changed(result.message, result.level)
              }}
            />
          ) : (
            <ProjectPane
              packages={packages}
              readOnly={readOnly || mainPackages !== null}
              onShow={(name) => {
                setQuery(name)
                setSelected(name)
                setTab('search')
              }}
              onGoTo={(entry) => {
                if (mainPackages !== null && mainDocument !== null) {
                  void tools.editDocument(mainDocument.path, (mainView) => {
                    goToLine(mainView, entry.line)
                    return true
                  })
                  onClose()
                  return
                }
                if (view === null) return
                goToLine(view, entry.line)
                onClose()
              }}
              onRemove={(entry) => {
                if (view === null) return
                const status = removePackage(view, entry.name)
                if (status === 'remove') {
                  changed(
                    entry.shared && entry.options.length > 0
                      ? `${entry.name} retiré. Les options [${entry.options.join(', ')}] restent sur les autres packages de la commande : vérifiez-les.`
                      : `${entry.name} retiré du préambule.`,
                    entry.shared && entry.options.length > 0 ? 'warning' : 'info',
                  )
                } else changed(`${entry.name} n’est plus dans le préambule.`, 'warning')
              }}
              onOptions={(entry, options) => {
                if (view === null) return
                const status = setPackageOptions(view, entry.name, options, entry.from)
                if (status === 'update') changed(`Options de ${entry.name} modifiées.`)
                else if (status === 'shared')
                  changed(
                    `${entry.name} partage sa commande avec d’autres packages : réglez ses options à la main.`,
                    'warning',
                  )
              }}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}

function SearchPane({
  query,
  onQueryChange,
  selected,
  onSelect,
  loaded,
  canAdd,
  onAdd,
}: {
  query: string
  onQueryChange: (query: string) => void
  selected: string | null
  onSelect: (name: string | null) => void
  loaded: ReadonlySet<string>
  canAdd: boolean
  onAdd: (name: string, options: string[]) => void
}) {
  const ids = useId()
  const [page, setPage] = useState(1)
  const [results, setResults] = useState<{
    key: string
    list: TexlivePackageList | null
    error: string | null
  } | null>(null)
  const trimmed = query.trim()
  const key = `${trimmed}\n${String(page)}`

  useEffect(() => {
    if (trimmed === '') return
    let active = true
    const timer = setTimeout(() => {
      api.texlivePackages({ q: trimmed, page, perPage: PER_PAGE }).then(
        (list) => {
          if (active) setResults({ key, list, error: null })
        },
        (caught: unknown) => {
          if (active) setResults({ key, list: null, error: texliveErrorMessage(caught) })
        },
      )
    }, SEARCH_DELAY_MS)
    return () => {
      active = false
      clearTimeout(timer)
    }
  }, [trimmed, page, key])

  const current = results?.key === key ? results : null
  const loading = trimmed !== '' && current === null
  const list = current?.list ?? null
  const pages = list === null ? 1 : Math.max(1, Math.ceil(list.total / list.perPage))

  return (
    <div className="grid h-full min-h-0 gap-3 md:grid-cols-[minmax(0,1fr)_minmax(0,1.2fr)]">
      <div className="flex min-h-0 flex-col gap-2">
        <Label htmlFor={`${ids}-q`} className="sr-only">
          Rechercher un package
        </Label>
        <div className="relative">
          <SearchIcon className="absolute top-2.5 left-2.5 size-4 text-muted-foreground" />
          <Input
            id={`${ids}-q`}
            className="pl-8"
            placeholder="Nom, fichier .sty ou mot-clé (tableaux, graphiques…)"
            value={query}
            autoFocus
            maxLength={100}
            onChange={(event) => {
              onQueryChange(event.target.value)
              setPage(1)
            }}
            data-testid="package-search"
          />
        </div>
        <div
          className="min-h-40 flex-1 overflow-y-auto rounded-md border md:max-h-[50dvh]"
          aria-busy={loading}
        >
          {trimmed === '' ? (
            <p className="p-3 text-sm text-muted-foreground">
              Cherchez parmi tous les packages de TeX Live, par exemple « siunitx », « tableau » ou
              « tikz ».
            </p>
          ) : loading ? (
            <p className="flex items-center gap-2 p-3 text-sm text-muted-foreground">
              <Spinner label="" /> Recherche…
            </p>
          ) : current?.error ? (
            <p className="p-3 text-sm text-destructive" role="alert">
              {current.error}
            </p>
          ) : list === null || list.packages.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">Aucun package trouvé.</p>
          ) : (
            <ul aria-label="Résultats" className="divide-y">
              {list.packages.map((entry) => {
                const name = entry.usepackage[0] ?? entry.name
                const isLoaded = entry.usepackage.some((style) => loaded.has(style))
                return (
                  <li key={entry.name}>
                    <button
                      type="button"
                      aria-current={selected === entry.name ? 'true' : undefined}
                      className={cn(
                        'grid w-full gap-0.5 px-3 py-2 text-left text-sm hover:bg-accent focus-visible:bg-accent focus-visible:outline-none',
                        selected === entry.name && 'bg-accent',
                      )}
                      onClick={() => {
                        onSelect(entry.name)
                      }}
                      data-package={entry.name}
                    >
                      <span className="flex items-center gap-2">
                        <span className="font-mono font-medium">{name}</span>
                        {name !== entry.name ? (
                          <span className="text-xs text-muted-foreground">({entry.name})</span>
                        ) : null}
                        {isLoaded ? <Badge variant="secondary">Chargé</Badge> : null}
                      </span>
                      <span className="line-clamp-2 text-xs text-muted-foreground">
                        {entry.shortdesc ?? 'Sans description'}
                      </span>
                    </button>
                  </li>
                )
              })}
            </ul>
          )}
        </div>
        {list !== null && pages > 1 ? (
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>
              {list.total} packages · page {page} / {pages}
            </span>
            <span className="flex gap-1">
              <Button
                size="xs"
                variant="outline"
                disabled={page <= 1}
                onClick={() => {
                  setPage(page - 1)
                }}
              >
                Précédents
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={page >= pages}
                onClick={() => {
                  setPage(page + 1)
                }}
              >
                Suivants
              </Button>
            </span>
          </div>
        ) : null}
      </div>
      <div className="min-h-0 overflow-y-auto rounded-md border p-3 md:max-h-[58dvh]">
        {selected === null ? (
          <p className="text-sm text-muted-foreground">Choisissez un package pour voir sa fiche.</p>
        ) : (
          <PackageDetail
            key={selected}
            name={selected}
            loaded={loaded}
            canAdd={canAdd}
            onAdd={onAdd}
          />
        )}
      </div>
    </div>
  )
}

function PackageDetail({
  name,
  loaded,
  canAdd,
  onAdd,
}: {
  name: string
  loaded: ReadonlySet<string>
  canAdd: boolean
  onAdd: (name: string, options: string[]) => void
}) {
  const ids = useId()
  const [detail, setDetail] = useState<TexlivePackageDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [style, setStyle] = useState<string | null>(null)
  const [options, setOptions] = useState('')

  useEffect(() => {
    let active = true
    api.texlivePackage(name).then(
      (loadedDetail) => {
        if (active) setDetail(loadedDetail)
      },
      (caught: unknown) => {
        if (active) setError(texliveErrorMessage(caught))
      },
    )
    return () => {
      active = false
    }
  }, [name])

  if (error !== null) {
    return (
      <p className="text-sm text-destructive" role="alert">
        {error}
      </p>
    )
  }
  if (detail === null) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Spinner label="" /> Chargement de la fiche…
      </p>
    )
  }
  const usepackage = detail.usepackage
  const target = style ?? (usepackage.includes(name) ? name : (usepackage[0] ?? null))
  const parsedOptions = parsePackageOptions(options)
  const isLoaded = target !== null && loaded.has(target)

  return (
    <article className="grid gap-3 text-sm" aria-labelledby={`${ids}-title`}>
      <header className="grid gap-1">
        <h3 id={`${ids}-title`} className="font-mono text-base font-semibold">
          {detail.name}
        </h3>
        <p>{detail.shortdesc ?? 'Sans description.'}</p>
      </header>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Catégorie</dt>
        <dd>{detail.category}</dd>
        {detail.topics.length > 0 ? (
          <>
            <dt className="text-muted-foreground">Sujets</dt>
            <dd>{detail.topics.join(', ')}</dd>
          </>
        ) : null}
        {detail.version ? (
          <>
            <dt className="text-muted-foreground">Version</dt>
            <dd>{detail.version}</dd>
          </>
        ) : null}
        {detail.license ? (
          <>
            <dt className="text-muted-foreground">Licence</dt>
            <dd>{detail.license}</dd>
          </>
        ) : null}
        {detail.collection ? (
          <>
            <dt className="text-muted-foreground">Collection</dt>
            <dd>{detail.collection}</dd>
          </>
        ) : null}
      </dl>
      <div className="flex flex-wrap gap-2">
        {detail.ctanUrl ? (
          <Button asChild size="xs" variant="outline">
            <a href={detail.ctanUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLinkIcon /> Fiche CTAN
            </a>
          </Button>
        ) : null}
        <Button asChild size="xs" variant="outline">
          <a href={detail.docUrl} target="_blank" rel="noopener noreferrer">
            <BookOpenIcon /> Documentation
          </a>
        </Button>
      </div>
      {usepackage.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          Ce package ne fournit pas de fichier .sty à charger avec \usepackage (classe, police ou
          outil).
        </p>
      ) : (
        <form
          className="grid gap-2 border-t pt-3"
          onSubmit={(event) => {
            event.preventDefault()
            if (target === null || parsedOptions === null) return
            onAdd(target, parsedOptions)
          }}
        >
          {usepackage.length > 1 ? (
            <div className="grid gap-1">
              <Label htmlFor={`${ids}-style`}>Fichier à charger</Label>
              <NativeSelect
                id={`${ids}-style`}
                value={target ?? ''}
                onChange={(event) => {
                  setStyle(event.target.value)
                }}
              >
                {usepackage.map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}
          <div className="grid gap-1">
            <Label htmlFor={`${ids}-options`}>
              Options (facultatives, séparées par des virgules)
            </Label>
            <Input
              id={`${ids}-options`}
              placeholder="margin=2cm, a4paper"
              value={options}
              maxLength={300}
              disabled={!canAdd}
              aria-invalid={parsedOptions === null}
              aria-describedby={`${ids}-preview`}
              onChange={(event) => {
                setOptions(event.target.value)
              }}
            />
          </div>
          <code id={`${ids}-preview`} className="rounded bg-muted px-2 py-1 font-mono text-xs">
            {parsedOptions === null
              ? 'Options invalides (crochets, barre oblique inverse ou accolades non fermées).'
              : `\\usepackage${parsedOptions.length > 0 ? `[${parsedOptions.join(',')}]` : ''}{${target ?? ''}}`}
          </code>
          {canAdd ? (
            <Button
              type="submit"
              size="sm"
              className="justify-self-start"
              disabled={target === null || parsedOptions === null}
              data-testid="package-add"
            >
              {isLoaded ? 'Ajouter les options' : 'Ajouter au préambule'}
            </Button>
          ) : (
            <p className="text-xs text-muted-foreground">
              Ajout impossible : lecture seule, ou fichier sans préambule.
            </p>
          )}
        </form>
      )}
    </article>
  )
}

function ProjectPane({
  packages,
  readOnly,
  onShow,
  onGoTo,
  onRemove,
  onOptions,
}: {
  packages: readonly ProjectPackage[]
  readOnly: boolean
  onShow: (name: string) => void
  onGoTo: (entry: ProjectPackage) => void
  onRemove: (entry: ProjectPackage) => void
  onOptions: (entry: ProjectPackage, options: string[]) => void
}) {
  if (packages.length === 0) {
    return (
      <p className="py-3 text-sm text-muted-foreground">
        Aucun package chargé par ce fichier (\usepackage ou \RequirePackage dans le préambule).
      </p>
    )
  }
  return (
    <ul
      className="max-h-[58dvh] divide-y overflow-y-auto rounded-md border"
      aria-label="Packages du document"
    >
      {packages.map((entry, index) => (
        <PackageRow
          key={`${entry.name}:${String(entry.from)}:${String(index)}`}
          entry={entry}
          readOnly={readOnly}
          onShow={onShow}
          onGoTo={onGoTo}
          onRemove={onRemove}
          onOptions={onOptions}
        />
      ))}
    </ul>
  )
}

function PackageRow({
  entry,
  readOnly,
  onShow,
  onGoTo,
  onRemove,
  onOptions,
}: {
  entry: ProjectPackage
  readOnly: boolean
  onShow: (name: string) => void
  onGoTo: (entry: ProjectPackage) => void
  onRemove: (entry: ProjectPackage) => void
  onOptions: (entry: ProjectPackage, options: string[]) => void
}) {
  const ids = useId()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.options.join(', '))
  const parsed = parsePackageOptions(draft)
  return (
    <li className="grid gap-2 px-3 py-2 text-sm" data-package-row={entry.name}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono font-medium">{entry.name}</span>
        {entry.options.length > 0 ? (
          <span className="font-mono text-xs text-muted-foreground">
            [{entry.options.join(',')}]
          </span>
        ) : null}
        {entry.command === 'RequirePackage' ? (
          <Badge variant="outline">\RequirePackage</Badge>
        ) : null}
        <span className="ml-auto flex flex-wrap gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              onGoTo(entry)
            }}
            aria-label={`Aller à la ligne ${String(entry.line)} (${entry.name})`}
          >
            Ligne {entry.line}
          </Button>
          <Button
            size="xs"
            variant="ghost"
            onClick={() => {
              onShow(entry.name)
            }}
          >
            Fiche
          </Button>
          {readOnly ? null : (
            <>
              <Button
                size="xs"
                variant="ghost"
                disabled={entry.shared}
                title={
                  entry.shared
                    ? 'Commande partagée avec d’autres packages : options à régler à la main.'
                    : undefined
                }
                aria-expanded={editing}
                onClick={() => {
                  setEditing((value) => !value)
                }}
              >
                Options
              </Button>
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  onRemove(entry)
                }}
                data-testid="package-remove"
              >
                Retirer
              </Button>
            </>
          )}
        </span>
      </div>
      {editing ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            if (parsed === null) return
            onOptions(entry, parsed)
            setEditing(false)
          }}
        >
          <Label htmlFor={`${ids}-options`} className="sr-only">
            Options de {entry.name}
          </Label>
          <Input
            id={`${ids}-options`}
            className="h-8 min-w-48 flex-1"
            value={draft}
            maxLength={300}
            aria-invalid={parsed === null}
            autoFocus
            onChange={(event) => {
              setDraft(event.target.value)
            }}
          />
          <Button type="submit" size="xs" disabled={parsed === null}>
            Enregistrer
          </Button>
        </form>
      ) : null}
    </li>
  )
}
