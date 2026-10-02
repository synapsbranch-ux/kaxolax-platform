'use client'

import type {
  DocumentDiffResponse,
  ProjectVersion,
  VersionAuthor,
  VersionDetail,
  VersionEntry,
} from '@kaxolax/contracts'
import {
  Alert,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  Spinner,
  cn,
} from '@kaxolax/ui'
import {
  ArrowLeftIcon,
  DownloadIcon,
  FileIcon,
  FileTextIcon,
  HistoryIcon,
  ImageIcon,
  RotateCcwIcon,
  TagIcon,
} from 'lucide-react'
import Image from 'next/image'
import { type SubmitEvent, useEffect, useMemo, useState } from 'react'
import { api } from '@/lib/api'
import {
  authorColors,
  authorName,
  changedEntries,
  dayKey,
  dayLabel,
  diffLines,
  diffStats,
  ENTRY_STATUS_LABELS,
  groupByDay,
  historyErrorMessage,
  restoreRemovals,
  timeLabel,
  VERSION_KIND_LABELS,
} from '@/lib/history'
import { useProjectHistory } from '../use-project-history'

/**
 * Tiroir Historique (tâche 8) : versions du projet groupées par jour, détail d'une version
 * (fichiers changés), diff d'un document coloré par auteur, aperçu d'une image, labels,
 * restauration du projet ou d'un fichier (une version de l'état courant est créée d'abord) et
 * téléchargement d'une version en zip. Lecture pour tous ; labels et restauration pour les
 * rôles qui éditent.
 */
export function HistoryDrawer({
  projectId,
  open,
  canEdit,
  onOpenChange,
}: {
  projectId: string
  open: boolean
  /** Rôle qui édite (owner, editor) : labels et restauration. */
  canEdit: boolean
  onOpenChange: (open: boolean) => void
}) {
  const history = useProjectHistory(projectId, open)
  const [selected, setSelected] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const selectedVersion = history.versions.find((version) => version.id === selected) ?? null

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) setSelected(null)
        onOpenChange(next)
      }}
    >
      <SheetContent
        side="right"
        className={cn(
          'max-w-[95vw] gap-0 sm:max-w-[95vw]',
          selected === null ? 'w-96' : 'w-[min(60rem,95vw)]',
        )}
        data-testid="history-drawer"
      >
        <SheetHeader className="border-b">
          <SheetTitle>Historique</SheetTitle>
          <SheetDescription>
            {history.retentionDays === null
              ? 'Versions du projet, comparaison et restauration. Historique complet.'
              : `Versions du projet, comparaison et restauration. Conservées ${String(history.retentionDays)} jour${history.retentionDays > 1 ? 's' : ''} (sauf les versions nommées).`}
          </SheetDescription>
        </SheetHeader>
        {notice ? (
          <Alert className="mx-4 mt-3 py-2" role="status">
            {notice}
          </Alert>
        ) : null}
        {selectedVersion ? (
          <VersionView
            projectId={projectId}
            version={selectedVersion}
            authors={history.authors}
            canEdit={canEdit}
            onBack={() => {
              setSelected(null)
            }}
            onLabelled={history.replace}
            onAuthors={history.addAuthors}
            onRestored={(message) => {
              setNotice(message)
              setSelected(null)
              history.reload()
            }}
          />
        ) : (
          <VersionList
            versions={history.versions}
            authors={history.authors}
            loading={history.loading}
            error={history.error}
            hasMore={history.hasMore}
            onLoadMore={() => void history.loadMore()}
            onSelect={(id) => {
              setNotice(null)
              setSelected(id)
            }}
          />
        )}
      </SheetContent>
    </Sheet>
  )
}

function AuthorChip({
  authors,
  id,
}: {
  authors: ReadonlyMap<string, VersionAuthor>
  id: string | null
}) {
  const colors = authorColors(id)
  return (
    <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
      <span
        aria-hidden
        className="inline-block size-2 shrink-0 rounded-full"
        style={{ backgroundColor: colors.color }}
      />
      {authorName(authors, id)}
    </span>
  )
}

function VersionList({
  versions,
  authors,
  loading,
  error,
  hasMore,
  onLoadMore,
  onSelect,
}: {
  versions: readonly ProjectVersion[]
  authors: ReadonlyMap<string, VersionAuthor>
  loading: boolean
  error: string | null
  hasMore: boolean
  onLoadMore: () => void
  onSelect: (id: string) => void
}) {
  const groups = useMemo(() => groupByDay(versions), [versions])
  if (versions.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center text-muted-foreground">
        {loading ? <Spinner /> : <HistoryIcon className="size-6" />}
        <p className="text-sm">
          {error ??
            (loading
              ? 'Chargement de l’historique…'
              : 'Aucune version pour l’instant. Une version est créée après deux minutes sans modification et à chaque compilation.')}
        </p>
      </div>
    )
  }
  return (
    <div className="flex-1 overflow-y-auto px-2 py-3" data-testid="history-list">
      {error ? <p className="px-2 pb-2 text-xs text-destructive">{error}</p> : null}
      {groups.map((group) => (
        <section key={group.day} className="mb-3">
          <h3 className="px-2 pb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground first-letter:uppercase">
            {dayLabel(group.day)}
          </h3>
          <ul>
            {group.versions.map((version) => (
              <li key={version.id}>
                <button
                  type="button"
                  className="flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:bg-accent focus-visible:outline-none"
                  onClick={() => {
                    onSelect(version.id)
                  }}
                  data-testid="history-version"
                >
                  <span className="flex items-center gap-2 text-sm">
                    <span className="font-medium tabular-nums">{timeLabel(version.createdAt)}</span>
                    <span className="truncate text-muted-foreground">
                      {VERSION_KIND_LABELS[version.kind]}
                    </span>
                    {version.label ? (
                      <Badge variant="secondary" className="ml-auto max-w-40 truncate">
                        <TagIcon className="size-3" />
                        {version.label}
                      </Badge>
                    ) : null}
                  </span>
                  <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
                    {version.authorIds.map((id) => (
                      <AuthorChip key={id} authors={authors} id={id} />
                    ))}
                    <span className="text-xs text-muted-foreground">
                      {version.changedDocumentIds.length === 0
                        ? 'Arborescence ou fichiers'
                        : `${String(version.changedDocumentIds.length)} document${version.changedDocumentIds.length > 1 ? 's' : ''} modifié${version.changedDocumentIds.length > 1 ? 's' : ''}`}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {hasMore ? (
        <div className="flex justify-center py-2">
          <Button variant="ghost" size="sm" disabled={loading} onClick={onLoadMore}>
            {loading ? <Spinner /> : null}
            Versions plus anciennes
          </Button>
        </div>
      ) : null}
    </div>
  )
}

function entryIcon(entry: VersionEntry) {
  if (entry.type === 'document') return <FileTextIcon className="size-4 shrink-0" />
  return entry.mimeType?.startsWith('image/') === true ? (
    <ImageIcon className="size-4 shrink-0" />
  ) : (
    <FileIcon className="size-4 shrink-0" />
  )
}

function VersionView({
  projectId,
  version,
  authors,
  canEdit,
  onBack,
  onLabelled,
  onAuthors,
  onRestored,
}: {
  projectId: string
  version: ProjectVersion
  authors: ReadonlyMap<string, VersionAuthor>
  canEdit: boolean
  onBack: () => void
  onLabelled: (version: ProjectVersion) => void
  onAuthors: (authors: readonly VersionAuthor[]) => void
  onRestored: (message: string) => void
}) {
  const [detail, setDetail] = useState<VersionDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [entryId, setEntryId] = useState<string | null>(null)
  const [showAll, setShowAll] = useState(false)
  const [restoring, setRestoring] = useState<{ scope: 'project' } | { entry: VersionEntry } | null>(
    null,
  )

  useEffect(() => {
    let cancelled = false
    api.version(projectId, version.id).then(
      (loaded) => {
        if (cancelled) return
        setDetail(loaded)
        onAuthors(loaded.authors)
        const first = changedEntries(loaded.entries)[0] ?? loaded.entries[0]
        setEntryId(first?.id ?? null)
      },
      (caught: unknown) => {
        if (!cancelled) setError(historyErrorMessage(caught))
      },
    )
    return () => {
      cancelled = true
    }
  }, [projectId, version.id, onAuthors])

  const entries = useMemo(() => {
    if (!detail) return []
    return showAll ? detail.entries : changedEntries(detail.entries)
  }, [detail, showAll])
  const entry = detail?.entries.find((candidate) => candidate.id === entryId) ?? null

  const download = () => {
    api.versionDownloadUrl(projectId, version.id).then(
      ({ url }) => {
        window.location.assign(url)
      },
      (caught: unknown) => {
        setError(historyErrorMessage(caught))
      },
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="history-version-view">
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
        <Button variant="ghost" size="icon-sm" onClick={onBack} aria-label="Retour aux versions">
          <ArrowLeftIcon />
        </Button>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium first-letter:uppercase">
            {dayLabel(dayKey(version.createdAt))},{timeLabel(version.createdAt)} ·{' '}
            {VERSION_KIND_LABELS[version.kind]}
          </p>
          <span className="flex flex-wrap gap-x-3">
            {version.authorIds.map((id) => (
              <AuthorChip key={id} authors={authors} id={id} />
            ))}
          </span>
        </div>
        <Button variant="outline" size="sm" onClick={download}>
          <DownloadIcon />
          Zip
        </Button>
        {canEdit ? (
          <Button
            size="sm"
            onClick={() => {
              setRestoring({ scope: 'project' })
            }}
            data-testid="history-restore-project"
          >
            <RotateCcwIcon />
            Restaurer cette version
          </Button>
        ) : null}
      </div>
      <LabelEditor
        projectId={projectId}
        version={version}
        canEdit={canEdit}
        onLabelled={onLabelled}
      />
      {error ? <p className="px-4 py-2 text-sm text-destructive">{error}</p> : null}
      {!detail && !error ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : null}
      {detail ? (
        <div className="flex min-h-0 flex-1 flex-col sm:flex-row">
          <div className="max-h-48 shrink-0 overflow-y-auto border-b sm:max-h-none sm:w-64 sm:border-r sm:border-b-0">
            <ul className="py-1">
              {entries.length === 0 ? (
                <li className="px-4 py-2 text-xs text-muted-foreground">
                  Aucun fichier modifié (dossiers ou document principal).
                </li>
              ) : null}
              {entries.map((candidate) => (
                <li key={`${candidate.id}:${candidate.status}`}>
                  <button
                    type="button"
                    className={cn(
                      'flex w-full items-center gap-2 px-4 py-1.5 text-left text-sm hover:bg-accent',
                      candidate.id === entryId && 'bg-accent',
                    )}
                    onClick={() => {
                      setEntryId(candidate.id)
                    }}
                  >
                    {entryIcon(candidate)}
                    <span className="min-w-0 flex-1">
                      <span
                        className={cn(
                          'block truncate',
                          candidate.status === 'deleted' && 'line-through',
                        )}
                      >
                        {candidate.path}
                      </span>
                      {candidate.previousPath ? (
                        <span className="block truncate text-xs text-muted-foreground">
                          avant : {candidate.previousPath}
                        </span>
                      ) : null}
                    </span>
                    {candidate.status === 'unchanged' ? null : (
                      <Badge
                        variant={
                          candidate.status === 'added'
                            ? 'success'
                            : candidate.status === 'deleted'
                              ? 'destructive'
                              : 'secondary'
                        }
                      >
                        {ENTRY_STATUS_LABELS[candidate.status]}
                      </Badge>
                    )}
                  </button>
                </li>
              ))}
            </ul>
            <div className="px-4 pb-3">
              <Button
                variant="link"
                size="xs"
                className="px-0"
                onClick={() => {
                  setShowAll((value) => !value)
                }}
              >
                {showAll ? 'Seulement les fichiers modifiés' : 'Tous les fichiers de la version'}
              </Button>
            </div>
          </div>
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {entry ? (
              <EntryView
                projectId={projectId}
                versionId={version.id}
                entry={entry}
                authors={authors}
                canEdit={canEdit}
                onRestore={() => {
                  setRestoring({ entry })
                }}
              />
            ) : (
              <p className="p-4 text-sm text-muted-foreground">
                Choisissez un fichier pour voir ses changements.
              </p>
            )}
          </div>
        </div>
      ) : null}
      <RestoreDialog
        projectId={projectId}
        version={version}
        versionEntries={detail?.entries ?? null}
        target={restoring}
        onClose={() => {
          setRestoring(null)
        }}
        onRestored={onRestored}
      />
    </div>
  )
}

function LabelEditor({
  projectId,
  version,
  canEdit,
  onLabelled,
}: {
  projectId: string
  version: ProjectVersion
  canEdit: boolean
  onLabelled: (version: ProjectVersion) => void
}) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(version.label ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async (label: string | null) => {
    setSaving(true)
    try {
      onLabelled(await api.labelVersion(projectId, version.id, label))
      setEditing(false)
      setError(null)
    } catch (caught) {
      setError(historyErrorMessage(caught))
    } finally {
      setSaving(false)
    }
  }
  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault()
    const label = value.trim()
    void save(label === '' ? null : label)
  }

  if (!editing) {
    return (
      <div className="flex items-center gap-2 border-b px-4 py-1.5 text-sm">
        <TagIcon className="size-3.5 text-muted-foreground" />
        <span className={cn('truncate', !version.label && 'text-muted-foreground')}>
          {version.label ?? 'Sans nom (une version nommée n’est jamais purgée)'}
        </span>
        {canEdit ? (
          <Button
            variant="link"
            size="xs"
            className="ml-auto"
            onClick={() => {
              setValue(version.label ?? '')
              setEditing(true)
            }}
          >
            {version.label ? 'Renommer' : 'Nommer'}
          </Button>
        ) : null}
      </div>
    )
  }
  return (
    <form onSubmit={submit} className="flex items-center gap-2 border-b px-4 py-1.5">
      <Input
        autoFocus
        value={value}
        maxLength={100}
        placeholder="Nom de la version (ex. : soumission v1)"
        aria-label="Nom de la version"
        className="h-8"
        onChange={(event) => {
          setValue(event.target.value)
        }}
      />
      <Button type="submit" size="sm" disabled={saving}>
        Enregistrer
      </Button>
      {version.label ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={saving}
          onClick={() => void save(null)}
        >
          Retirer
        </Button>
      ) : null}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          setEditing(false)
        }}
      >
        Annuler
      </Button>
      {error ? <span className="text-xs text-destructive">{error}</span> : null}
    </form>
  )
}

function EntryView({
  projectId,
  versionId,
  entry,
  authors,
  canEdit,
  onRestore,
}: {
  projectId: string
  versionId: string
  entry: VersionEntry
  authors: ReadonlyMap<string, VersionAuthor>
  canEdit: boolean
  onRestore: () => void
}) {
  return (
    <>
      <div className="flex items-center gap-2 border-b px-4 py-2 text-sm">
        <span className="min-w-0 flex-1 truncate font-medium">{entry.path}</span>
        {canEdit && entry.status !== 'deleted' ? (
          <Button variant="outline" size="xs" onClick={onRestore}>
            <RotateCcwIcon />
            Restaurer ce fichier
          </Button>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {entry.type === 'document' ? (
          <DiffView
            projectId={projectId}
            versionId={versionId}
            documentId={entry.id}
            authors={authors}
          />
        ) : (
          <BinaryView projectId={projectId} versionId={versionId} entry={entry} />
        )}
      </div>
    </>
  )
}

function DiffView({
  projectId,
  versionId,
  documentId,
  authors,
}: {
  projectId: string
  versionId: string
  documentId: string
  authors: ReadonlyMap<string, VersionAuthor>
}) {
  const [diff, setDiff] = useState<{ key: string; value: DocumentDiffResponse } | null>(null)
  const [error, setError] = useState<{ key: string; message: string } | null>(null)
  const key = `${versionId}:${documentId}`

  useEffect(() => {
    let cancelled = false
    api.versionDiff(projectId, versionId, documentId).then(
      (value) => {
        if (!cancelled) setDiff({ key: `${versionId}:${documentId}`, value })
      },
      (caught: unknown) => {
        if (!cancelled)
          setError({ key: `${versionId}:${documentId}`, message: historyErrorMessage(caught) })
      },
    )
    return () => {
      cancelled = true
    }
  }, [projectId, versionId, documentId])

  const current = diff?.key === key ? diff.value : null
  const lines = useMemo(() => (current ? diffLines(current.segments) : []), [current])
  const stats = useMemo(() => (current ? diffStats(current.segments) : []), [current])

  if (error?.key === key) return <p className="p-4 text-sm text-destructive">{error.message}</p>
  if (!current) {
    return (
      <div className="flex justify-center p-6">
        <Spinner />
      </div>
    )
  }
  return (
    <div data-testid="history-diff">
      {stats.length > 0 ? (
        <div className="flex flex-wrap gap-x-4 gap-y-1 border-b px-4 py-2">
          {stats.map((stat) => (
            <span key={stat.authorId ?? 'unknown'} className="inline-flex items-center gap-2">
              <AuthorChip authors={authors} id={stat.authorId} />
              <span className="text-xs tabular-nums text-muted-foreground">
                +{stat.inserted} −{stat.deleted}
              </span>
            </span>
          ))}
        </div>
      ) : (
        <p className="border-b px-4 py-2 text-xs text-muted-foreground">
          Aucun changement dans ce document pour cette version.
        </p>
      )}
      <pre className="min-w-max py-2 font-mono text-xs leading-5">
        {lines.map((line, index) =>
          line === null ? (
            <div key={`fold-${String(index)}`} className="px-4 text-muted-foreground select-none">
              ⋯
            </div>
          ) : (
            <div key={line.number} className="flex">
              <span className="w-12 shrink-0 pr-3 text-right text-muted-foreground select-none">
                {line.number}
              </span>
              <span className="whitespace-pre pr-4">
                {line.parts.map((part, partIndex) => {
                  if (part.op === 'equal') return <span key={partIndex}>{part.text}</span>
                  const colors = authorColors(part.authorId)
                  return (
                    <span
                      key={partIndex}
                      title={`${part.op === 'insert' ? 'Ajouté' : 'Supprimé'} par ${authorName(authors, part.authorId)}`}
                      className={cn(
                        'rounded-sm',
                        part.op === 'delete' && 'line-through decoration-2',
                      )}
                      style={
                        part.op === 'insert'
                          ? {
                              backgroundColor: colors.background,
                              boxShadow: `inset 0 -2px 0 ${colors.color}`,
                            }
                          : { color: colors.color, textDecorationColor: colors.color }
                      }
                    >
                      {part.text}
                    </span>
                  )
                })}
              </span>
            </div>
          ),
        )}
      </pre>
    </div>
  )
}

function BinaryView({
  projectId,
  versionId,
  entry,
}: {
  projectId: string
  versionId: string
  entry: VersionEntry
}) {
  const [url, setUrl] = useState<{ key: string; value: string } | null>(null)
  const isImage =
    entry.mimeType?.startsWith('image/') === true && entry.mimeType !== 'image/svg+xml'
  const key = `${versionId}:${entry.id}`

  useEffect(() => {
    if (!isImage || entry.status === 'deleted') return
    let cancelled = false
    api.versionFileUrl(projectId, versionId, entry.id).then(
      ({ url: value }) => {
        if (!cancelled) setUrl({ key: `${versionId}:${entry.id}`, value })
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [projectId, versionId, entry.id, entry.status, isImage])

  return (
    <div className="flex flex-col items-center gap-3 p-6 text-sm text-muted-foreground">
      {url?.key === key ? (
        // URL présignée du stockage objet, valable quelques minutes : pas d'optimisation Next.js.
        <Image
          src={url.value}
          alt={entry.path}
          width={800}
          height={600}
          unoptimized
          className="h-auto max-h-96 w-auto max-w-full rounded border object-contain"
        />
      ) : (
        <FileIcon className="size-8" />
      )}
      <p>
        {ENTRY_STATUS_LABELS[entry.status]} · {entry.mimeType ?? 'fichier'} ·{' '}
        {formatBytes(entry.sizeBytes ?? 0)}
      </p>
    </div>
  )
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} o`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Kio`
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mio`
}

/** Ce que la restauration retirera de l'arborescence actuelle, relu à l'ouverture du dialogue. */
function useRestoreRemovals(
  projectId: string,
  target: { scope: 'project' } | { entry: VersionEntry } | null,
  versionEntries: readonly VersionEntry[] | null,
) {
  const [removals, setRemovals] = useState<{
    target: object
    value: { paths: string[]; threads: number }
  } | null>(null)
  useEffect(() => {
    if (!target || !versionEntries) return
    let cancelled = false
    Promise.all([api.tree(projectId), api.commentThreads(projectId)]).then(
      ([tree, threads]) => {
        if (!cancelled)
          setRemovals({ target, value: restoreRemovals(target, versionEntries, tree, threads) })
      },
      () => undefined,
    )
    return () => {
      cancelled = true
    }
  }, [projectId, target, versionEntries])
  return removals?.target === target ? removals.value : null
}

/** Nombre maximal de chemins retirés cités dans le dialogue de restauration. */
const REMOVED_PATHS_SHOWN = 5

function RestoreDialog({
  projectId,
  version,
  versionEntries,
  target,
  onClose,
  onRestored,
}: {
  projectId: string
  version: ProjectVersion
  versionEntries: readonly VersionEntry[] | null
  target: { scope: 'project' } | { entry: VersionEntry } | null
  onClose: () => void
  onRestored: (message: string) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const entry = target && 'entry' in target ? target.entry : null
  const removals = useRestoreRemovals(projectId, target, versionEntries)

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await api.restoreVersion(
        projectId,
        version.id,
        entry ? { scope: 'entry', entryId: entry.id } : { scope: 'project' },
      )
      onClose()
      onRestored(
        entry
          ? `${entry.path} a été restauré. L’état précédent est enregistré dans l’historique.`
          : 'La version a été restaurée. L’état précédent est enregistré dans l’historique.',
      )
    } catch (caught) {
      setError(historyErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog
      open={target !== null}
      onOpenChange={(next) => {
        if (!next && !busy) {
          setError(null)
          onClose()
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {entry ? `Restaurer ${entry.path} ?` : 'Restaurer cette version ?'}
          </DialogTitle>
          <DialogDescription>
            {entry
              ? 'Le fichier reprend son contenu de cette version (recréé à son emplacement s’il a été supprimé, à la place de l’élément qui occupe ce chemin).'
              : 'Tout le projet reprend l’état de cette version : texte, images et arborescence.'}{' '}
            Une version de l’état actuel est d’abord enregistrée : rien n’est perdu. Les
            collaborateurs connectés voient le changement aussitôt.
          </DialogDescription>
        </DialogHeader>
        {removals && removals.paths.length > 0 ? (
          <div
            className="rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-sm"
            data-testid="history-restore-removals"
          >
            <p>
              {entry
                ? `Remplacé (gardé dans la version de sauvegarde) : ${removals.paths.join(', ')}.`
                : `Retirés du projet (gardés dans la version de sauvegarde) : ${removals.paths
                    .slice(0, REMOVED_PATHS_SHOWN)
                    .join(', ')}${
                    removals.paths.length > REMOVED_PATHS_SHOWN
                      ? ` et ${String(removals.paths.length - REMOVED_PATHS_SHOWN)} autre(s)`
                      : ''
                  }.`}
            </p>
            {removals.threads > 0 ? (
              <p className="mt-1 font-medium">
                {removals.threads === 1
                  ? '1 fil de commentaires sur ces fichiers sera supprimé définitivement : les commentaires ne sont pas enregistrés dans les versions.'
                  : `${String(removals.threads)} fils de commentaires sur ces fichiers seront supprimés définitivement : les commentaires ne sont pas enregistrés dans les versions.`}
              </p>
            ) : null}
          </div>
        ) : null}
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={onClose}>
            Annuler
          </Button>
          <Button
            disabled={busy}
            onClick={() => void confirm()}
            data-testid="history-restore-confirm"
          >
            {busy ? <Spinner /> : <RotateCcwIcon />}
            Restaurer
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
