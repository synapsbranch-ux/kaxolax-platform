'use client'

import type { Compiler, CompileResult, PdfPosition } from '@kaxolax/contracts'
import {
  Alert,
  Badge,
  Button,
  NativeSelect,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  cn,
} from '@kaxolax/ui'
import { CrosshairIcon, DownloadIcon, LoaderIcon, PlayIcon, SquareIcon } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { AppHeader } from '@/components/app-header'
import { useRequiredUser } from '@/components/auth/session'
import { api, ApiError, errorMessage, type Project, type ProjectTree } from '@/lib/api'
import { documentByPath } from '@/lib/tree'
import { CodeEditor, type EditorHandle, type SyncState } from './code-editor'
import { FilePreview } from './file-preview'
import { FileTree, type Selection } from './file-tree'
import { LogPanel } from './log-panel'
import { PdfViewer } from './pdf-viewer'
import { useRealtimeSocket } from './use-realtime'

const SYNC_LABELS: Record<SyncState, string> = {
  connecting: 'Connexion…',
  synced: 'Enregistré',
  saving: 'Enregistrement…',
  offline: 'Hors ligne, reconnexion…',
  closed: 'Document fermé',
}

export function EditorPage({ projectId }: { projectId: string }) {
  const user = useRequiredUser()
  const [project, setProject] = useState<Project | null>(null)
  const [tree, setTree] = useState<ProjectTree | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selection, setSelection] = useState<Selection>(null)
  const [syncState, setSyncState] = useState<SyncState>('connecting')
  const [compiling, setCompiling] = useState(false)
  const [result, setResult] = useState<CompileResult | null>(null)
  const [rightPanel, setRightPanel] = useState<'pdf' | 'logs'>('pdf')
  const [highlight, setHighlight] = useState<PdfPosition | null>(null)
  const editor = useRef<EditorHandle | null>(null)
  const pendingLine = useRef<number | null>(null)
  const compileRequest = useRef(0)
  const socket = useRealtimeSocket(projectId)

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
    void (async () => {
      try {
        const [{ project: loaded }, loadedTree, last] = await Promise.all([
          api.project(projectId),
          api.tree(projectId),
          api.lastCompile(projectId),
        ])
        setProject(loaded)
        setTree(loadedTree)
        setResult(last.compile)
        const first = loaded.mainDocumentId ?? loadedTree.documents[0]?.id
        if (first) setSelection({ type: 'document', id: first })
      } catch (caught) {
        if (caught instanceof ApiError && caught.status === 404) setNotFound(true)
        else setError(errorMessage(caught))
      }
    })()
  }, [user, projectId])

  const canEdit = project?.role === 'owner' || project?.role === 'editor'
  const openDocument = tree?.documents.find(
    (document) => selection?.type === 'document' && document.id === selection.id,
  )
  const openFile = tree?.files.find(
    (file) => selection?.type === 'file' && file.id === selection.id,
  )
  const errorCount = result?.entries.filter((entry) => entry.level === 'error').length ?? 0

  const compile = useCallback(async () => {
    // Un nouveau clic arrête la compilation précédente (côté serveur) ; seule la dernière réponse compte.
    const request = ++compileRequest.current
    setCompiling(true)
    setError(null)
    try {
      await editor.current?.flush()
      const compiled = await api.compile(projectId)
      if (request !== compileRequest.current) return
      setResult(compiled)
      setHighlight(null)
      if (compiled.pdfUrl === null) setRightPanel('logs')
    } catch (caught) {
      if (request === compileRequest.current) setError(errorMessage(caught))
    } finally {
      if (request === compileRequest.current) setCompiling(false)
    }
  }, [projectId])

  // Ctrl+Entrée partout dans la page (l'éditeur a son propre raccourci).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault()
        void compile()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [compile])

  const openLocation = useCallback(
    (file: string, line: number) => {
      if (!tree) return
      const document = documentByPath(tree, file)
      if (!document) {
        setError(`${file} n'est pas un document du projet.`)
        return
      }
      if (selection?.type === 'document' && selection.id === document.id && editor.current) {
        editor.current.goToLine(line)
      } else {
        pendingLine.current = line
        setSelection({ type: 'document', id: document.id })
      }
    },
    [tree, selection],
  )

  const onEditorReady = useCallback((handle: EditorHandle | null) => {
    editor.current = handle
    if (handle && pendingLine.current !== null) {
      handle.goToLine(pendingLine.current)
      pendingLine.current = null
    }
  }, [])

  async function codeToPdf() {
    if (!openDocument || !editor.current) return
    try {
      const { pdf } = await api.synctexCode(
        projectId,
        openDocument.path,
        editor.current.cursorLine(),
      )
      if (pdf[0]) {
        setRightPanel('pdf')
        setHighlight({ ...pdf[0] })
      } else setError('Aucune zone du PDF ne correspond à cette ligne.')
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function pdfToCode(page: number, h: number, v: number) {
    try {
      const { code } = await api.synctexPdf(projectId, page, h, v)
      if (code[0]) openLocation(code[0].file, code[0].line)
    } catch (caught) {
      setError(errorMessage(caught))
    }
  }

  async function changeCompiler(compiler: Compiler) {
    try {
      setProject((await api.updateProject(projectId, { compiler })).project)
    } catch (caught) {
      setError(errorMessage(caught))
    }
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

  return (
    <div className="flex h-screen flex-col">
      <AppHeader user={user}>
        <span className="truncate font-medium" data-testid="project-name">
          {project?.name ?? ''}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <NativeSelect
            aria-label="Compilateur"
            value={project?.compiler ?? 'pdflatex'}
            disabled={!canEdit}
            onChange={(event) => void changeCompiler(event.target.value as Compiler)}
          >
            <option value="pdflatex">pdfLaTeX</option>
            <option value="xelatex">XeLaTeX</option>
            <option value="lualatex">LuaLaTeX</option>
          </NativeSelect>
          <Button
            size="sm"
            onClick={() => void compile()}
            title="Recompiler (Ctrl+Entrée)"
            data-testid="recompile"
          >
            {compiling ? <LoaderIcon className="animate-spin" /> : <PlayIcon />}
            Recompiler
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={!compiling}
            onClick={() => void api.stopCompile(projectId)}
            aria-label="Arrêter la compilation"
          >
            <SquareIcon />
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void codeToPdf()}
            disabled={!openDocument}
            title="Du code vers le PDF (SyncTeX)"
            data-testid="synctex-to-pdf"
          >
            <CrosshairIcon />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            title="Télécharger le projet (zip)"
            data-testid="download-zip"
            onClick={() => {
              // Lien signé de 60 s : une navigation ne porte pas le jeton Clerk.
              api.downloadUrl(projectId).then(
                ({ url }) => {
                  window.location.assign(url)
                },
                (caught: unknown) => {
                  setError(errorMessage(caught))
                },
              )
            }}
          >
            <DownloadIcon /> Zip
          </Button>
        </div>
      </AppHeader>

      {error ? (
        <Alert variant="destructive" className="rounded-none border-x-0 border-t-0 py-2">
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

      <ResizablePanelGroup orientation="horizontal" className="min-h-0 flex-1">
        <ResizablePanel defaultSize="18" minSize="10">
          {tree && project ? (
            <FileTree
              projectId={projectId}
              tree={tree}
              mainDocumentId={project.mainDocumentId}
              selection={selection}
              canEdit={canEdit}
              onSelect={setSelection}
              onChanged={refreshTree}
              onSetMain={async (documentId) => {
                setProject(
                  (await api.updateProject(projectId, { mainDocumentId: documentId })).project,
                )
              }}
              onError={setError}
            />
          ) : null}
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="42" minSize="20">
          <div className="flex h-full flex-col">
            <div className="flex h-10 shrink-0 items-center gap-2 border-b px-3 text-sm">
              <span className="truncate font-mono text-xs">
                {openDocument?.path ?? openFile?.path ?? ''}
              </span>
              {openDocument ? (
                <span className="ml-auto text-xs text-muted-foreground" data-testid="sync-state">
                  {SYNC_LABELS[syncState]}
                </span>
              ) : null}
            </div>
            <div className="min-h-0 flex-1">
              {openDocument && socket ? (
                <CodeEditor
                  key={openDocument.id}
                  projectId={projectId}
                  documentId={openDocument.id}
                  socket={socket}
                  readOnly={!canEdit}
                  onCompile={() => void compile()}
                  onReady={onEditorReady}
                  onSyncState={setSyncState}
                />
              ) : null}
              {openFile ? (
                <FilePreview key={openFile.id} projectId={projectId} file={openFile} />
              ) : null}
              {!openDocument && !openFile ? (
                <p className="p-6 text-sm text-muted-foreground">
                  Choisissez un fichier dans l'arborescence.
                </p>
              ) : null}
            </div>
          </div>
        </ResizablePanel>
        <ResizableHandle />
        <ResizablePanel defaultSize="40" minSize="20">
          <div className="flex h-full flex-col">
            <div className="flex h-10 shrink-0 items-center gap-1 border-b px-2">
              {(['pdf', 'logs'] as const).map((panel) => (
                <button
                  key={panel}
                  type="button"
                  onClick={() => {
                    setRightPanel(panel)
                  }}
                  data-testid={`panel-${panel}`}
                  className={cn(
                    'flex items-center gap-1.5 rounded px-3 py-1 text-sm',
                    rightPanel === panel
                      ? 'bg-accent font-medium'
                      : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  {panel === 'pdf' ? 'PDF' : 'Logs'}
                  {panel === 'logs' && errorCount > 0 ? (
                    <Badge variant="destructive" data-testid="error-count">
                      {errorCount}
                    </Badge>
                  ) : null}
                </button>
              ))}
            </div>
            <div className="min-h-0 flex-1">
              {rightPanel === 'pdf' ? (
                <PdfViewer
                  url={result?.pdfUrl ?? null}
                  fileName={`${project?.name ?? 'output'}.pdf`}
                  highlight={highlight}
                  onDoubleClick={(page, h, v) => void pdfToCode(page, h, v)}
                />
              ) : (
                <LogPanel
                  result={result}
                  onOpenLocation={openLocation}
                  onClearCache={async () => {
                    await api.clearCache(projectId)
                  }}
                />
              )}
            </div>
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
    </div>
  )
}
