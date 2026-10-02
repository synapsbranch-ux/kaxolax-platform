'use client'

import type { Compiler, CompileResult, PdfPosition, ProjectSearchMatch } from '@kaxolax/contracts'
import type { ActionHost } from '@kaxolax/editor'
import { Alert, Button, Skeleton } from '@kaxolax/ui'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useRequiredUser } from '@/components/auth/session'
import { usePreferences } from '@/components/preferences/preferences-provider'
import { api, ApiError, errorMessage, type Project, type ProjectTree } from '@/lib/api'
import {
  closeTab,
  EMPTY_TABS,
  openTab,
  pruneTabs,
  restoreTabs,
  type TabsState,
  tabsEntry,
} from '@/lib/preferences'
import { documentByPath } from '@/lib/tree'
import type { EditorHandle, SyncState } from './editor/code-editor'
import { EditorColumn } from './editor/editor-column'
import type { OpenTab } from './editor/editor-tabs'
import { FileActionsProvider } from './file-actions'
import type { CompileSettings } from './pdf/compile-status'
import { PdfColumn } from './pdf/pdf-column'
import { OutlineTree } from './sidebar/outline-tree'
import { Sidebar } from './sidebar/sidebar'
import { useCompile } from './use-compile'
import { useDocumentOutline } from './use-outline'
import { useRealtimeSocket } from './use-realtime'
import { WorkspaceActionsProvider } from './workspace-actions'
import { type NarrowView, WorkspaceLayout } from './workspace-layout'

/** Durée d'affichage d'un message court (actions de la barre Tools). */
const NOTICE_MS = 5_000

/**
 * Page projet : charge le projet, l'arborescence et la dernière compilation, tient les onglets
 * ouverts (mémorisés par projet dans les préférences), la compilation et SyncTeX, et compose la
 * sidebar, l'éditeur et le PDF dans `WorkspaceLayout`.
 */
export function WorkspacePage({ projectId }: { projectId: string }) {
  const user = useRequiredUser()
  const { preferences, loaded: preferencesLoaded, update: updatePreferences } = usePreferences()
  const [project, setProject] = useState<Project | null>(null)
  const [tree, setTree] = useState<ProjectTree | null>(null)
  // Dernière compilation lue au chargement, avec sa date de réception (liens présignés datés).
  const [lastCompile, setLastCompile] = useState<{
    result: CompileResult | null
    receivedAt: number
  }>({ result: null, receivedAt: 0 })
  const [notFound, setNotFound] = useState(false)
  // Échec du chargement initial (réseau, API) : page d'erreur avec nouvel essai.
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<{ message: string; level: string } | null>(null)
  const [tabs, setTabs] = useState<TabsState | null>(null)
  const [syncState, setSyncState] = useState<SyncState>('connecting')
  const [highlight, setHighlight] = useState<PdfPosition | null>(null)
  const [narrowView, setNarrowView] = useState<NarrowView>('editor')
  const [search, setSearch] = useState<{ query: string; serial: number } | null>(null)
  // Demandes d'affichage de la sidebar (repliée ou en tiroir) : recherche dans le projet.
  const [revealSidebar, setRevealSidebar] = useState(0)
  // Navigations vers un fichier (arbre, plan, recherche, logs) : le tiroir de la sidebar se ferme.
  const [navigations, setNavigations] = useState(0)
  const showEditor = useCallback(() => {
    setNarrowView('editor')
    setNavigations((count) => count + 1)
  }, [])
  const editor = useRef<EditorHandle | null>(null)
  // Éditeur courant, aussi en état : le plan du document se met à jour quand il change.
  const [editorHandle, setEditorHandle] = useState<EditorHandle | null>(null)
  // Position à atteindre une fois le document visé ouvert (log, SyncTeX, plan, recherche) : elle ne
  // s'applique qu'à l'éditeur de ce document.
  const pendingTarget = useRef<{ documentId: string; target: Target } | null>(null)
  const { socket, error: socketError } = useRealtimeSocket(projectId)

  const canEdit = project?.role === 'owner' || project?.role === 'editor'

  const compileState = useCompile({
    projectId,
    flush: async () => {
      await editor.current?.flush()
    },
    options: preferences.compile,
    onError: setError,
  })
  const { compile } = compileState
  const result = compileState.result ?? lastCompile.result
  const resultReceivedAt =
    compileState.result !== null ? compileState.receivedAt : lastCompile.receivedAt

  const refreshTree = useCallback(async () => {
    const next = await api.tree(projectId)
    setTree(next)
    setProject((current) =>
      current ? { ...current, mainDocumentId: next.mainDocumentId } : current,
    )
  }, [projectId])

  // Chargement : projet, arbre et dernière compilation (le PDF s'affiche dès l'ouverture).
  useEffect(() => {
    if (!user) return
    // Objet plutôt que variable : TypeScript ne garde pas le rétrécissement après un await.
    const state = { active: true }
    void (async () => {
      try {
        const [{ project: loaded }, loadedTree, last] = await Promise.all([
          api.project(projectId),
          api.tree(projectId),
          api.lastCompile(projectId),
        ])
        if (!state.active) return
        setProject(loaded)
        setTree(loadedTree)
        setLastCompile({ result: last.compile, receivedAt: Date.now() })
      } catch (caught) {
        if (!state.active) return
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true)
        else setLoadError(errorMessage(caught))
      }
    })()
    return () => {
      state.active = false
    }
  }, [user, projectId])

  // Onglets : ceux mémorisés dans les préférences (sinon le document principal) tant que
  // l'utilisateur n'y a pas touché, puis l'état local ; ceux des fichiers supprimés disparaissent.
  const exists = useCallback(
    (id: string) =>
      tree !== null &&
      (tree.documents.some((document) => document.id === id) ||
        tree.files.some((file) => file.id === id)),
    [tree],
  )
  const savedTabs = preferences.openTabs[projectId]
  const currentTabs = useMemo<TabsState | null>(() => {
    if (tree === null || !preferencesLoaded) return null
    if (tabs !== null) return pruneTabs(tabs, exists)
    return restoreTabs(savedTabs, exists, tree.mainDocumentId ?? tree.documents[0]?.id ?? null)
  }, [tree, preferencesLoaded, tabs, savedTabs, exists])

  /** Change les onglets et les mémorise (préférences, envoi groupé). */
  const changeTabs = useCallback(
    (change: (current: TabsState) => TabsState) => {
      const current = currentTabs ?? EMPTY_TABS
      const next = change(current)
      if (next === current) return
      setTabs(next)
      updatePreferences({ openTabs: { [projectId]: tabsEntry(next) } })
    },
    [currentTabs, projectId, updatePreferences],
  )
  const open = useCallback(
    (id: string) => {
      changeTabs((current) => openTab(current, id))
      showEditor()
    },
    [changeTabs, showEditor],
  )

  const activeId = currentTabs?.active ?? null
  const activeDocument = tree?.documents.find((document) => document.id === activeId) ?? null
  const activeFile = tree?.files.find((file) => file.id === activeId) ?? null
  const openTabs = useMemo<OpenTab[]>(
    () =>
      (currentTabs?.ids ?? []).flatMap((id): OpenTab[] => {
        const document = tree?.documents.find((candidate) => candidate.id === id)
        if (document) return [{ id, name: document.name, path: document.path, kind: 'document' }]
        const file = tree?.files.find((candidate) => candidate.id === id)
        return file
          ? [{ id, name: file.name, path: file.path, kind: 'file', mimeType: file.mimeType }]
          : []
      }),
    [currentTabs, tree],
  )
  const activeTab = openTabs.find((tab) => tab.id === activeId) ?? null

  // Nouveau PDF : le surlignage SyncTeX précédent n'a plus de sens.
  const runCompile = useCallback(() => {
    setHighlight(null)
    void compile()
  }, [compile])

  /** Ouvre la recherche dans le projet (sidebar affichée), préremplie avec `query`. */
  const searchProject = useCallback((query: string) => {
    setSearch((current) => ({ query, serial: (current?.serial ?? 0) + 1 }))
    setRevealSidebar((count) => count + 1)
  }, [])

  // Ctrl+Entrée et Ctrl+Maj+F partout dans la page (l'éditeur a ses propres raccourcis, qui
  // marquent l'événement).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || !(event.ctrlKey || event.metaKey)) return
      if (event.key === 'Enter') {
        event.preventDefault()
        runCompile()
      } else if (event.shiftKey && event.key.toLowerCase() === 'f') {
        event.preventDefault()
        searchProject('')
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [runCompile, searchProject])

  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => {
      setNotice(null)
    }, NOTICE_MS)
    return () => {
      clearTimeout(timer)
    }
  }, [notice])

  /** Ouvre un document du projet (chemin) et place le curseur, ou sélectionne une occurrence. */
  const openTarget = useCallback(
    (file: string, target: Target) => {
      if (!tree) return
      const document = documentByPath(tree, file)
      if (!document) {
        setError(`${file} n'est pas un document du projet.`)
        return
      }
      showEditor()
      if (activeId === document.id && editor.current) {
        goTo(editor.current, target)
      } else {
        pendingTarget.current = { documentId: document.id, target }
        changeTabs((current) => openTab(current, document.id))
      }
    },
    [tree, activeId, changeTabs, showEditor],
  )
  const openLocation = useCallback(
    (file: string, line: number) => {
      openTarget(file, { line })
    },
    [openTarget],
  )
  const openMatch = useCallback(
    (match: ProjectSearchMatch) => {
      openTarget(match.path, match)
    },
    [openTarget],
  )

  const onEditorReady = useCallback((handle: EditorHandle | null) => {
    editor.current = handle
    setEditorHandle(handle)
    const pending = pendingTarget.current
    if (handle === null || pending === null) return
    // Un autre document activé entre-temps abandonne la position visée.
    if (handle.documentId === pending.documentId) goTo(handle, pending.target)
    pendingTarget.current = null
  }, [])

  const outline = useDocumentOutline({
    projectId,
    socket,
    tree,
    mainDocumentId: project?.mainDocumentId ?? null,
    document: activeDocument,
    editor: editorHandle,
  })

  const codeToPdf = useCallback(async () => {
    if (!activeDocument || !editor.current) return
    try {
      const { pdf } = await api.synctexCode(
        projectId,
        activeDocument.path,
        editor.current.cursorLine(),
      )
      if (pdf[0]) {
        setHighlight({ ...pdf[0] })
        setNarrowView('pdf')
      } else setError('Aucune zone du PDF ne correspond à cette ligne.')
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }, [activeDocument, projectId])

  const pdfToCode = useCallback(
    async (page: number, h: number, v: number) => {
      try {
        const { code } = await api.synctexPdf(projectId, page, h, v)
        if (code[0]) openLocation(code[0].file, code[0].line)
      } catch (caught) {
        setError(errorMessage(caught))
      }
    },
    [projectId, openLocation],
  )

  const changeCompiler = useCallback(
    async (compiler: Compiler) => {
      try {
        setProject((await api.updateProject(projectId, { compiler })).project)
      } catch (caught) {
        setError(errorMessage(caught))
      }
    },
    [projectId],
  )

  const downloadZip = useCallback(() => {
    // Lien signé de 60 s : une navigation ne porte pas le jeton Clerk.
    api.downloadUrl(projectId).then(
      ({ url }) => {
        window.location.assign(url)
      },
      (caught: unknown) => {
        setError(errorMessage(caught))
      },
    )
  }, [projectId])

  const notify = useCallback<NonNullable<ActionHost['notify']>>((message, level = 'info') => {
    if (level === 'error') setError(message)
    else setNotice({ message, level })
  }, [])

  const settings: CompileSettings = {
    compiler: project?.compiler ?? 'pdflatex',
    autoCompile: preferences.autoCompile,
    draft: preferences.compile.draft,
    haltOnFirstError: preferences.compile.haltOnFirstError,
  }

  if (notFound) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3">
        <p className="text-lg font-semibold">Projet introuvable</p>
        <Button asChild variant="outline">
          <a href="/dashboard">Retour aux projets</a>
        </Button>
      </main>
    )
  }

  if (loadError !== null) {
    return (
      <main className="flex min-h-screen flex-col items-center justify-center gap-3 px-4 text-center">
        <p className="text-lg font-semibold">Impossible d'ouvrir le projet</p>
        <p className="text-sm text-muted-foreground" role="alert">
          {loadError}
        </p>
        <div className="flex gap-2">
          <Button
            onClick={() => {
              window.location.reload()
            }}
          >
            Réessayer
          </Button>
          <Button asChild variant="outline">
            <a href="/dashboard">Retour aux projets</a>
          </Button>
        </div>
      </main>
    )
  }

  // Les tailles mémorisées des colonnes ne s'appliquent qu'au montage : on attend les préférences.
  if (!preferencesLoaded) {
    return (
      <div className="flex h-dvh">
        <Skeleton className="h-full w-[18%] rounded-none bg-sidebar" />
        <Skeleton className="h-full flex-1 rounded-none bg-editor" />
        <Skeleton className="h-full flex-1 rounded-none bg-pdf" />
      </div>
    )
  }

  return (
    <FileActionsProvider
      projectId={projectId}
      tree={tree}
      canEdit={canEdit}
      onChanged={refreshTree}
      onOpen={open}
      onSetMain={async (documentId) => {
        setProject((await api.updateProject(projectId, { mainDocumentId: documentId })).project)
      }}
      onError={setError}
    >
      <WorkspaceActionsProvider
        canEdit={canEdit}
        compile={runCompile}
        downloadZip={downloadZip}
        searchProject={searchProject}
        notify={notify}
        editor={editor}
      >
        <WorkspaceLayout
          layout={preferences.layout}
          onLayoutChange={updatePreferences}
          narrowView={narrowView}
          onNarrowViewChange={setNarrowView}
          revealSidebar={revealSidebar}
          dismissDrawer={navigations}
          sidebar={({ onCollapse, collapseLabel }) => (
            <Sidebar
              project={project}
              tree={tree}
              user={user}
              activeId={activeId}
              onOpen={open}
              onCollapse={onCollapse}
              collapseLabel={collapseLabel}
              search={search}
              onSearchProject={searchProject}
              onCloseSearch={() => {
                setSearch(null)
              }}
              onOpenMatch={openMatch}
              outline={
                <OutlineTree
                  nodes={outline.nodes}
                  current={outline.current}
                  activePath={activeDocument?.path ?? null}
                  onSelect={openLocation}
                />
              }
            />
          )}
          editor={(leading) => (
            <EditorColumn
              projectId={projectId}
              tree={tree}
              tabs={openTabs}
              activeTab={activeTab}
              file={activeFile}
              socket={socket}
              connectionError={socketError}
              loading={currentTabs === null}
              canEdit={canEdit}
              theme={preferences.theme}
              autoCompile={preferences.autoCompile}
              toolsVisible={preferences.toolsVisible}
              syncState={syncState}
              leading={leading}
              notice={
                <>
                  {error ? (
                    <Alert
                      variant="destructive"
                      className="rounded-none border-x-0 border-t-0 py-2"
                      data-testid="workspace-error"
                    >
                      {error}
                      <button
                        type="button"
                        className="ml-3 underline"
                        onClick={() => {
                          setError(null)
                        }}
                      >
                        Fermer
                      </button>
                    </Alert>
                  ) : null}
                  {notice ? (
                    <Alert className="rounded-none border-x-0 border-t-0 py-2" role="status">
                      {notice.message}
                    </Alert>
                  ) : null}
                </>
              }
              onActivate={open}
              onClose={(id) => {
                changeTabs((current) => closeTab(current, id))
              }}
              onToggleTools={() => {
                updatePreferences({ toolsVisible: !preferences.toolsVisible })
              }}
              onCompile={runCompile}
              onEditorReady={onEditorReady}
              onSyncState={setSyncState}
            />
          )}
          pdf={(leading) => (
            <PdfColumn
              result={result}
              resultReceivedAt={resultReceivedAt}
              compiling={compileState.compiling}
              settings={settings}
              canEdit={canEdit}
              fileName={`${project?.name ?? 'output'}.pdf`}
              highlight={highlight}
              canGoToPdf={activeDocument !== null}
              leading={leading}
              onCompile={runCompile}
              onStop={() => void compileState.stop()}
              onClearCache={compileState.clearCache}
              onSettingsChange={(change) => {
                if (change.compiler !== undefined) void changeCompiler(change.compiler)
                if (change.autoCompile !== undefined)
                  updatePreferences({ autoCompile: change.autoCompile })
                if (change.draft !== undefined || change.haltOnFirstError !== undefined)
                  updatePreferences({
                    compile: { draft: change.draft, haltOnFirstError: change.haltOnFirstError },
                  })
              }}
              onOpenLocation={openLocation}
              onPdfDoubleClick={(page, h, v) => void pdfToCode(page, h, v)}
              onGoToPdf={() => void codeToPdf()}
              onUndo={() => editor.current?.undo()}
              onRedo={() => editor.current?.redo()}
              onDownloadZip={downloadZip}
              onRefreshOutputs={async () => (await api.lastCompile(projectId)).compile}
              onError={setError}
            />
          )}
        />
      </WorkspaceActionsProvider>
    </FileActionsProvider>
  )
}

/** Position à atteindre dans un document : ligne, ou occurrence (colonne et longueur). */
interface Target {
  line: number
  column?: number
  length?: number
}

function goTo(handle: EditorHandle, target: Target): void {
  if (target.column !== undefined && target.length !== undefined)
    handle.select(target.line, target.column, target.length)
  else handle.goToLine(target.line)
}
