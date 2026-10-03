'use client'

import type {
  ZoteroCollection,
  ZoteroConnectionResponse,
  ZoteroExportFormat,
  ZoteroLibrary,
  ZoteroLink,
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
  Label,
  NativeSelect,
  Spinner,
} from '@kaxolax/ui'
import { RefreshCwIcon } from 'lucide-react'
import Link from 'next/link'
import { useEffect, useId, useRef, useState } from 'react'
import { useNow } from '@/hooks/use-now'
import { api, type TreeDocument } from '@/lib/api'
import {
  collectionTree,
  zoteroApi,
  zoteroErrorMessage,
  zoteroFeed,
  zoteroLinkStatus,
  zoteroSourceLabel,
} from '@/lib/zotero'
import type { ActionDialogProps } from '../action-dialogs'
import { useWorkspaceTools } from '../workspace-tools'
import { focusEditorOnClose } from '../writing/writing-common'

interface Loaded {
  available: boolean
  link: ZoteroLink | null
  connection: ZoteroConnectionResponse['connection']
}

/** Valeur « nouveau fichier » du choix du `.bib` cible. */
const NEW_FILE = 'new'
const ALL_LIBRARY = ''

/**
 * Panneau Zotero du projet (menu Fichier) : bibliothèque ou collection liée, fichier `.bib`
 * alimenté, état et date de la dernière synchronisation, erreurs ; synchroniser, modifier ou
 * retirer le lien (éditeurs et propriétaire). La synchronisation utilise la clé Zotero du membre
 * qui a lié le projet ; tout éditeur peut la relancer.
 */
export default function ZoteroDialog({ context, onClose }: ActionDialogProps) {
  const tools = useWorkspaceTools()
  const { projectId, canEdit } = tools
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const now = useNow(15_000)

  useEffect(() => {
    const state = { live: true }
    Promise.all([zoteroApi.project(projectId), zoteroApi.connection()]).then(
      ([project, account]) => {
        if (!state.live) return
        setLoaded({
          available: project.available,
          link: project.link,
          connection: account.connection,
        })
      },
      (caught: unknown) => {
        if (state.live) setError(zoteroErrorMessage(caught))
      },
    )
    const unsubscribe = zoteroFeed.subscribe((event) => {
      setLoaded((current) => (current ? { ...current, link: event.link } : current))
    })
    return () => {
      state.live = false
      unsubscribe()
    }
  }, [projectId])

  const link = loaded?.link ?? null
  const run = async (task: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try {
      await task()
    } catch (caught) {
      setError(zoteroErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  const sync = () =>
    run(async () => {
      const result = await zoteroApi.sync(projectId, 'manual')
      setLoaded((current) => (current ? { ...current, link: result.link } : current))
    }).then(async () => {
      // Erreur de Zotero : le lien relu porte l'erreur enregistrée.
      const fresh = await zoteroApi.project(projectId).catch(() => null)
      if (fresh) setLoaded((current) => (current ? { ...current, link: fresh.link } : current))
    })

  const unlink = () =>
    run(async () => {
      await zoteroApi.unlink(projectId)
      setLoaded((current) => (current ? { ...current, link: null } : current))
    })

  const status = link === null ? null : zoteroLinkStatus(link, now)

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="max-h-[92dvh] overflow-y-auto sm:max-w-xl"
        onCloseAutoFocus={(event) => {
          focusEditorOnClose(event, context)
        }}
        data-testid="zotero-panel"
      >
        <DialogHeader>
          <DialogTitle>Zotero</DialogTitle>
          <DialogDescription>
            Bibliographie du projet synchronisée depuis une bibliothèque ou une collection Zotero
            (sous-collections comprises).
          </DialogDescription>
        </DialogHeader>
        {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
        {loaded === null ? (
          error === null ? (
            <div className="flex justify-center py-6">
              <Spinner />
            </div>
          ) : null
        ) : !loaded.available ? (
          <Alert>L’intégration Zotero n’est pas configurée sur ce service.</Alert>
        ) : editing || link === null ? (
          canEdit ? (
            loaded.connection === null ? (
              <Alert>
                Pour lier ce projet, connectez d’abord votre compte Zotero dans{' '}
                <Link className="underline" href="/account/integrations">
                  Compte → Intégrations
                </Link>
                .
              </Alert>
            ) : (
              <LinkForm
                projectId={projectId}
                link={link}
                onCancel={
                  link === null
                    ? undefined
                    : () => {
                        setEditing(false)
                      }
                }
                onLinked={(linked) => {
                  setLoaded({ ...loaded, link: linked })
                  setEditing(false)
                }}
              />
            )
          ) : (
            <p className="text-sm text-muted-foreground">
              Ce projet n’est lié à aucune bibliothèque Zotero. Un éditeur peut le lier.
            </p>
          )
        ) : (
          <div className="flex flex-col gap-3 text-sm" data-testid="zotero-link">
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1">
              <dt className="text-muted-foreground">Source</dt>
              <dd>{zoteroSourceLabel(link)}</dd>
              <dt className="text-muted-foreground">Fichier</dt>
              <dd className="font-mono">{link.documentPath ?? 'supprimé : refaites le lien'}</dd>
              <dt className="text-muted-foreground">Format</dt>
              <dd>{link.exportFormat === 'biblatex' ? 'BibLaTeX' : 'BibTeX'}</dd>
              <dt className="text-muted-foreground">Clé utilisée</dt>
              <dd>celle de {link.ownerName ?? 'l’auteur du lien'}</dd>
            </dl>
            {status ? (
              <div className="flex flex-wrap items-center gap-2" data-testid="zotero-status">
                <Badge
                  variant={
                    status.tone === 'ok'
                      ? 'success'
                      : status.tone === 'error'
                        ? 'destructive'
                        : status.tone === 'waiting'
                          ? 'warning'
                          : 'secondary'
                  }
                >
                  {status.tone === 'ok'
                    ? 'À jour'
                    : status.tone === 'busy'
                      ? 'En cours'
                      : status.tone === 'waiting'
                        ? 'En pause'
                        : 'Erreur'}
                </Badge>
                <span className="text-muted-foreground">{status.label}</span>
              </div>
            ) : null}
            {status?.error ? <Alert variant="warning">{status.error}</Alert> : null}
            <p className="text-xs text-muted-foreground">
              Le fichier est réécrit à chaque synchronisation (modifications manuelles remplacées,
              versions gardées dans l’historique). Synchronisé à l’ouverture du projet au plus tous
              les quarts d’heure, ou à la demande par tout éditeur.
            </p>
          </div>
        )}
        {link !== null && !editing && canEdit && loaded?.available ? (
          <DialogFooter className="gap-2 sm:justify-between">
            <div className="flex gap-2">
              <Button variant="outline" disabled={busy} onClick={() => void unlink()}>
                Retirer le lien
              </Button>
              {loaded.connection !== null ? (
                <Button
                  variant="outline"
                  disabled={busy}
                  onClick={() => {
                    setEditing(true)
                  }}
                >
                  Modifier
                </Button>
              ) : null}
            </div>
            <Button disabled={busy || !link.hasKey} onClick={() => void sync()}>
              {busy ? <Spinner /> : <RefreshCwIcon aria-hidden />}
              Synchroniser
            </Button>
          </DialogFooter>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

/** Choix de la bibliothèque, de la collection, du `.bib` et du format, puis lien. */
function LinkForm({
  projectId,
  link,
  onCancel,
  onLinked,
}: {
  projectId: string
  link: ZoteroLink | null
  onCancel: (() => void) | undefined
  onLinked: (link: ZoteroLink | null) => void
}) {
  const ids = useId()
  const [libraries, setLibraries] = useState<ZoteroLibrary[] | null>(null)
  const [bibFiles, setBibFiles] = useState<TreeDocument[]>([])
  const [library, setLibrary] = useState(link ? `${link.libraryType}:${link.libraryId}` : '')
  // Collections lues pour une bibliothèque (`library`) ; null tant qu'elles ne sont pas lues.
  const [loadedCollections, setLoadedCollections] = useState<{
    library: string
    list: ZoteroCollection[]
  } | null>(null)
  const collections = loadedCollections?.library === library ? loadedCollections.list : null
  const [collection, setCollection] = useState(link?.collectionKey ?? ALL_LIBRARY)
  const [target, setTarget] = useState(link?.documentId ?? NEW_FILE)
  const [fileName, setFileName] = useState('references.bib')
  const [format, setFormat] = useState<ZoteroExportFormat>(link?.exportFormat ?? 'biblatex')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // Lien à l'ouverture du formulaire : les choix sont initialisés une seule fois d'après lui (un
  // `zotero.updated` reçu pendant la saisie ne relance pas le chargement ni n'efface les choix).
  const initialLink = useRef(link)

  useEffect(() => {
    const state = { live: true }
    const initial = initialLink.current
    Promise.all([zoteroApi.libraries(), api.tree(projectId)]).then(
      ([list, tree]) => {
        if (!state.live) return
        setLibraries(list)
        // Bibliothèque du lien absente de ce compte (lien fait par un autre membre, groupe dont
        // on n'est pas membre, accès retiré à la clé) : la première, toute la bibliothèque.
        const linked = initial === null ? '' : `${initial.libraryType}:${initial.libraryId}`
        if (!list.some((entry) => `${entry.type}:${entry.id}` === linked)) {
          setLibrary(list[0] ? `${list[0].type}:${list[0].id}` : '')
          setCollection(ALL_LIBRARY)
        }
        const bibs = tree.documents.filter((document) =>
          document.path.toLowerCase().endsWith('.bib'),
        )
        setBibFiles(bibs)
        if (initial === null && bibs[0]) setTarget(bibs[0].id)
      },
      (caught: unknown) => {
        if (state.live) setError(zoteroErrorMessage(caught))
      },
    )
    return () => {
      state.live = false
    }
  }, [projectId])

  const [libraryType, libraryId] = library.split(':') as [string, string | undefined]
  useEffect(() => {
    if (libraryId === undefined || (libraryType !== 'user' && libraryType !== 'group')) return
    const state = { live: true }
    const key = `${libraryType}:${libraryId}`
    zoteroApi.collections(libraryType, libraryId).then(
      (list) => {
        if (state.live) setLoadedCollections({ library: key, list })
      },
      (caught: unknown) => {
        if (state.live) setError(zoteroErrorMessage(caught))
      },
    )
    return () => {
      state.live = false
    }
  }, [libraryType, libraryId])

  // « Nouveau fichier » dont le nom est déjà pris à la racine : refusé par l'API.
  const nameTaken =
    target === NEW_FILE &&
    bibFiles.some((document) => document.path.toLowerCase() === fileName.trim().toLowerCase())

  const submit = async () => {
    if (libraryId === undefined || (libraryType !== 'user' && libraryType !== 'group')) return
    setBusy(true)
    setError(null)
    try {
      const result = await zoteroApi.link(projectId, {
        libraryType,
        libraryId,
        collectionKey: collection === ALL_LIBRARY ? null : collection,
        target:
          target === NEW_FILE
            ? { kind: 'new', name: fileName.trim(), folderId: null }
            : { kind: 'existing', documentId: target },
        exportFormat: format,
      })
      onLinked(result.link)
    } catch (caught) {
      setError(zoteroErrorMessage(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      data-testid="zotero-link-form"
      onSubmit={(event) => {
        event.preventDefault()
        void submit()
      }}
    >
      {error !== null ? <Alert variant="destructive">{error}</Alert> : null}
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${ids}-library`}>Bibliothèque</Label>
        <NativeSelect
          id={`${ids}-library`}
          value={library}
          disabled={libraries === null}
          onChange={(event) => {
            setLibrary(event.target.value)
            setCollection(ALL_LIBRARY)
          }}
        >
          {(libraries ?? []).map((entry) => (
            <option key={`${entry.type}:${entry.id}`} value={`${entry.type}:${entry.id}`}>
              {entry.type === 'group' ? `Groupe : ${entry.name}` : entry.name}
            </option>
          ))}
        </NativeSelect>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${ids}-collection`}>Collection</Label>
        <NativeSelect
          id={`${ids}-collection`}
          value={collection}
          disabled={collections === null}
          onChange={(event) => {
            setCollection(event.target.value)
          }}
        >
          <option value={ALL_LIBRARY}>Toute la bibliothèque</option>
          {collectionTree(collections ?? []).map(({ collection: entry, depth }) => (
            <option key={entry.key} value={entry.key}>
              {`${' '.repeat(depth)}${entry.name}`}
            </option>
          ))}
        </NativeSelect>
        <p className="text-xs text-muted-foreground" data-testid="zotero-scope-note">
          {collection === ALL_LIBRARY
            ? 'Tout éditeur du projet pourra chercher et citer toute cette bibliothèque avec votre clé Zotero.'
            : 'Sous-collections comprises. Les autres éditeurs du projet pourront chercher et citer les références de cette collection avec votre clé ; vous seul pourrez ajouter des références prises ailleurs dans la bibliothèque.'}
        </p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${ids}-target`}>Fichier .bib du projet</Label>
        <NativeSelect
          id={`${ids}-target`}
          value={target}
          onChange={(event) => {
            setTarget(event.target.value)
          }}
        >
          {bibFiles.map((document) => (
            <option key={document.id} value={document.id}>
              {document.path}
            </option>
          ))}
          <option value={NEW_FILE}>Nouveau fichier…</option>
        </NativeSelect>
        {target === NEW_FILE ? (
          <>
            <Input
              aria-label="Nom du nouveau fichier"
              value={fileName}
              onChange={(event) => {
                setFileName(event.target.value)
              }}
            />
            {nameTaken ? (
              <p className="text-xs text-destructive" data-testid="zotero-name-taken">
                Un fichier de ce nom existe déjà : choisissez-le dans la liste (son contenu sera
                remplacé par l’export) ou donnez un autre nom.
              </p>
            ) : null}
          </>
        ) : (
          <p className="text-xs text-muted-foreground">
            Son contenu sera remplacé par l’export de Zotero (l’historique garde l’ancien).
          </p>
        )}
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`${ids}-format`}>Format</Label>
        <NativeSelect
          id={`${ids}-format`}
          value={format}
          onChange={(event) => {
            setFormat(event.target.value === 'bibtex' ? 'bibtex' : 'biblatex')
          }}
        >
          <option value="biblatex">BibLaTeX (biber)</option>
          <option value="bibtex">BibTeX</option>
        </NativeSelect>
      </div>
      <DialogFooter className="gap-2">
        {onCancel ? (
          <Button type="button" variant="outline" onClick={onCancel}>
            Annuler
          </Button>
        ) : null}
        <Button
          type="submit"
          disabled={
            busy ||
            libraries === null ||
            nameTaken ||
            (target === NEW_FILE && !fileName.trim().toLowerCase().endsWith('.bib'))
          }
        >
          {busy ? <Spinner /> : null}
          Lier et synchroniser
        </Button>
      </DialogFooter>
    </form>
  )
}
