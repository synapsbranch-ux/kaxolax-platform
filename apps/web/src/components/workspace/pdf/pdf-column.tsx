'use client'

import type { CompileResult, OutputDownload, PdfPosition } from '@kaxolax/contracts'
import { Button, Sheet, SheetContent, SheetTitle, SimpleTooltip, cn } from '@kaxolax/ui'
import { FileWarningIcon, PlayIcon, RotateCwIcon, ScrollTextIcon } from 'lucide-react'
import { type ReactNode, useCallback, useRef, useState } from 'react'
import { PlanLimitNotice } from '@/components/billing/plan-limit-notice'
import { type CompilePhase, phaseLabel } from '@/lib/builds'
import { CompileStatus, type CompileSettings } from './compile-status'
import { type FixPackage, LogPanel } from './log-panel'
import { PdfActions, PdfFloatingBar, ZoomMenu } from './pdf-controls'
import type { PdfZoom } from '@/lib/pdf'
import { PdfViewer, type PdfViewerHandle } from './pdf-viewer'

/**
 * Âge maximal des liens présignés reçus avec un résultat de compilation avant de les redemander à
 * l'API (`GET /compile/last`) : marge sous leur durée de validité côté API (une heure).
 */
const OUTPUT_URLS_MAX_AGE_MS = 45 * 60 * 1000

interface OutputLinks {
  pdfUrl: string | null
  outputFiles: readonly OutputDownload[]
}

/** Récupère le PDF (URL présignée d'une autre origine) en blob local ; null si le lien a expiré. */
async function pdfBlobUrl(url: string): Promise<string | null> {
  const response = await fetch(url)
  // Lien expiré ou objet absent : S3 répond par une page d'erreur XML, jamais enregistrée en PDF.
  if (!response.ok) return null
  return URL.createObjectURL(await response.blob())
}

/** Déclenche le téléchargement d'une URL (blob local ou lien présigné en pièce jointe). */
function triggerDownload(url: string, fileName: string): void {
  const link = document.createElement('a')
  link.href = url
  link.download = fileName
  link.click()
}

/**
 * Colonne PDF, toujours claire : en-tête (pastille de statut, logs, zoom, téléchargement, menu ⋯),
 * aperçu et ses états (chargement, jamais compilé, erreur), tiroir des logs au-dessus du PDF et
 * barre flottante (annuler, pages, SyncTeX).
 */
export function PdfColumn({
  result,
  resultReceivedAt,
  compiling,
  phase = null,
  settings,
  canEdit,
  fileName,
  highlight,
  canGoToPdf,
  leading,
  onCompile,
  onStop,
  onClearCache,
  onSettingsChange,
  onOpenLocation,
  onFixPackage,
  onPdfDoubleClick,
  onGoToPdf,
  onUndo,
  onRedo,
  onDownloadZip,
  onRefreshOutputs,
  onError,
}: {
  result: CompileResult | null
  /** Date de réception de `result` : âge de ses liens présignés. */
  resultReceivedAt: number
  compiling: boolean
  /** Étape de la compilation en cours (compilation asynchrone : préparation, file d'attente). */
  phase?: CompilePhase | null
  settings: CompileSettings
  canEdit: boolean
  /** Nom du PDF téléchargé. */
  fileName: string
  highlight: PdfPosition | null
  /** Un document est ouvert dans l'éditeur (SyncTeX, annuler et rétablir). */
  canGoToPdf: boolean
  /** Début de l'en-tête (onglets Éditeur/PDF sur un écran étroit). */
  leading?: ReactNode
  onCompile: () => void
  onStop: () => void
  onClearCache: () => Promise<void>
  onSettingsChange: (change: Partial<CompileSettings>) => void
  onOpenLocation: (file: string, line: number) => void
  /** Corrige un package introuvable dans le document (absent : correction impossible). */
  onFixPackage?: FixPackage
  onPdfDoubleClick: (page: number, h: number, v: number) => void
  onGoToPdf: () => void
  onUndo: () => void
  onRedo: () => void
  onDownloadZip: () => void
  /** Redemande la dernière compilation à l'API, avec des liens présignés neufs. */
  onRefreshOutputs: () => Promise<CompileResult | null>
  onError: (message: string) => void
}) {
  const [zoom, setZoom] = useState<PdfZoom>('page-width')
  const [logsOpen, setLogsOpen] = useState(false)
  const [position, setPosition] = useState({ page: 0, pages: 0 })
  const viewer = useRef<PdfViewerHandle | null>(null)
  // Zone de l'aperçu : elle accueille le tiroir des logs (au-dessus du PDF, pas de la page).
  const [previewArea, setPreviewArea] = useState<HTMLDivElement | null>(null)
  const pdfUrl = result?.pdfUrl ?? null

  const onPageChange = useCallback((page: number, pages: number) => {
    setPosition((current) =>
      current.page === page && current.pages === pages ? current : { page, pages },
    )
  }, [])
  const setViewer = useCallback((handle: PdfViewerHandle | null) => {
    viewer.current = handle
  }, [])

  // Liens présignés des sorties : ils expirent (une heure) alors que la page peut rester ouverte bien
  // plus longtemps sans recompiler. Ceux du résultat sont datés à sa réception (`resultReceivedAt`,
  // pas au montage de la colonne, qui est remontée au passage des 1024 px) ; ceux redemandés à l'API
  // remplacent ceux du même résultat.
  const refreshed = useRef<{
    source: CompileResult | null
    value: OutputLinks
    receivedAt: number
  } | null>(null)

  /** Liens des sorties, redemandés à l'API s'ils sont anciens (ou si `force`). */
  const outputLinks = async (force = false): Promise<OutputLinks> => {
    const fresh = refreshed.current?.source === result ? refreshed.current : null
    const current = fresh ?? {
      value: { pdfUrl: result?.pdfUrl ?? null, outputFiles: result?.outputFiles ?? [] },
      receivedAt: resultReceivedAt,
    }
    if (!force && Date.now() - current.receivedAt < OUTPUT_URLS_MAX_AGE_MS) return current.value
    const source = result
    const latest = await onRefreshOutputs()
    const value = { pdfUrl: latest?.pdfUrl ?? null, outputFiles: latest?.outputFiles ?? [] }
    refreshed.current = { source, value, receivedAt: Date.now() }
    return value
  }

  // Lien de l'aperçu redemandé après un échec de chargement (lien expiré) du PDF `source` ;
  // `attempt` remonte la visionneuse à chaque rechargement demandé.
  const [reloaded, setReloaded] = useState<{
    source: string
    url: string | null
    attempt: number
  } | null>(null)
  // PDF pour lequel le nouvel essai automatique a déjà eu lieu (un seul par PDF).
  const autoRetried = useRef<string | null>(null)
  const viewerUrl = pdfUrl !== null && reloaded?.source === pdfUrl ? reloaded.url : pdfUrl

  const report = (caught: unknown) => {
    onError(caught instanceof Error ? caught.message : String(caught))
  }

  /** Redemande le lien du PDF et recharge l'aperçu (automatiquement une fois, puis sur demande). */
  const reloadPreview = (manual: boolean) => {
    if (pdfUrl === null) return
    const source = pdfUrl
    if (!manual) {
      if (autoRetried.current === source) return
      autoRetried.current = source
    }
    outputLinks(true).then(
      ({ pdfUrl: url }) => {
        setReloaded((previous) => ({
          source,
          url,
          attempt: (previous?.source === source ? previous.attempt : 0) + 1,
        }))
      },
      (caught: unknown) => {
        report(caught)
      },
    )
  }
  const showLogs = () => {
    setLogsOpen(true)
  }
  const previewErrorActions = (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          reloadPreview(true)
        }}
      >
        <RotateCwIcon /> Recharger
      </Button>
      <Button size="sm" variant="outline" onClick={showLogs}>
        Voir les logs
      </Button>
    </>
  )

  /** Copie locale du PDF ; un lien refusé (expiré) est redemandé une fois à l'API. */
  const withPdf = (action: (blobUrl: string) => void) => {
    if (pdfUrl === null) return
    void (async () => {
      let url = (await outputLinks()).pdfUrl
      let blobUrl = url === null ? null : await pdfBlobUrl(url)
      if (blobUrl === null) {
        url = (await outputLinks(true)).pdfUrl
        blobUrl = url === null ? null : await pdfBlobUrl(url)
      }
      if (blobUrl === null) throw new Error('Le PDF n’est plus disponible : recompilez le projet.')
      action(blobUrl)
    })().catch(report)
  }

  return (
    <section
      data-theme="light"
      aria-label="Aperçu PDF"
      className="flex h-full min-w-0 flex-col bg-pdf text-pdf-foreground"
    >
      <header className="flex h-bar shrink-0 items-center gap-1.5 overflow-x-auto border-b border-pdf-border bg-pdf-toolbar px-2 text-pdf-toolbar-foreground">
        {leading}
        <CompileStatus
          result={result}
          compiling={compiling}
          phase={phase}
          settings={settings}
          canEdit={canEdit}
          onCompile={onCompile}
          onStop={onStop}
          onClearCache={() => void onClearCache()}
          onShowLogs={() => {
            setLogsOpen(true)
          }}
          onChange={onSettingsChange}
        />
        <SimpleTooltip label={logsOpen ? 'Masquer les logs' : 'Voir les logs'}>
          <Button
            variant="ghost"
            size="xs"
            aria-pressed={logsOpen}
            className={cn(
              'text-pdf-toolbar-foreground hover:bg-pdf-accent',
              logsOpen && 'bg-pdf-accent',
            )}
            onClick={() => {
              setLogsOpen((open) => !open)
            }}
            aria-label="Logs"
            data-testid="panel-logs"
          >
            <ScrollTextIcon /> <span className="hidden sm:inline">Logs</span>
          </Button>
        </SimpleTooltip>
        <div className="ml-auto flex items-center gap-0.5">
          <ZoomMenu zoom={zoom} disabled={pdfUrl === null} onChange={setZoom} />
          <PdfActions
            hasPdf={pdfUrl !== null}
            outputFiles={result?.outputFiles ?? []}
            onDownloadPdf={() => {
              withPdf((blobUrl) => {
                triggerDownload(blobUrl, fileName)
                // Libération différée : certains navigateurs annulent un téléchargement dont
                // l'URL est révoquée aussitôt après le clic.
                setTimeout(() => {
                  URL.revokeObjectURL(blobUrl)
                }, 60_000)
              })
            }}
            onDownloadOutput={(name) => {
              void (async () => {
                const file = (await outputLinks()).outputFiles.find(
                  (output) => output.name === name,
                )
                if (file === undefined) throw new Error(`Fichier de sortie introuvable : ${name}.`)
                triggerDownload(file.url, name)
              })().catch(report)
            }}
            onDownloadZip={onDownloadZip}
            onOpenInNewTab={() => {
              // Onglet ouvert pendant le clic (sinon bloqué comme fenêtre surgissante), puis
              // dirigé vers un lien valide.
              const tab = window.open('about:blank', '_blank')
              if (tab === null) return
              tab.opener = null
              void outputLinks().then(
                ({ pdfUrl: url }) => {
                  if (url === null) {
                    tab.close()
                    onError('Le PDF n’est plus disponible : recompilez le projet.')
                  } else tab.location.href = url
                },
                (caught: unknown) => {
                  tab.close()
                  report(caught)
                },
              )
            }}
            onPrint={() => {
              // Impression depuis un cadre caché qui charge une copie locale du PDF.
              withPdf((blobUrl) => {
                const frame = document.createElement('iframe')
                frame.style.display = 'none'
                frame.src = blobUrl
                frame.onload = () => {
                  frame.contentWindow?.print()
                  setTimeout(() => {
                    frame.remove()
                    URL.revokeObjectURL(blobUrl)
                  }, 60_000)
                }
                document.body.append(frame)
              })
            }}
          />
        </div>
      </header>

      <div ref={setPreviewArea} className="relative min-h-0 flex-1 overflow-hidden">
        {viewerUrl !== null ? (
          <PdfViewer
            key={reloaded?.source === pdfUrl ? reloaded.attempt : 0}
            url={viewerUrl}
            zoom={zoom}
            highlight={highlight}
            onDoubleClick={onPdfDoubleClick}
            onPageChange={onPageChange}
            handleRef={setViewer}
            onLoadError={() => {
              reloadPreview(false)
            }}
            errorActions={previewErrorActions}
          />
        ) : pdfUrl !== null ? (
          // Le PDF de ce résultat n'existe plus côté stockage (lien redemandé sans succès).
          <div
            className="mt-16 flex flex-col items-center gap-3 px-6 text-center"
            data-testid="pdf-viewer"
          >
            <FileWarningIcon className="size-8 text-destructive" />
            <p className="text-sm font-medium">
              Le PDF n’est plus disponible : recompilez le projet.
            </p>
            <div className="flex gap-2">{previewErrorActions}</div>
          </div>
        ) : (
          <PdfEmptyState
            result={result}
            compiling={compiling}
            phase={phase}
            onCompile={onCompile}
            onShowLogs={showLogs}
          />
        )}

        {/* Tiroir non modal : l'éditeur reste utilisable (clic sur une erreur, puis frappe). */}
        <Sheet open={logsOpen && previewArea !== null} onOpenChange={setLogsOpen} modal={false}>
          <SheetContent
            side="top"
            container={previewArea}
            showOverlay={false}
            showCloseButton={false}
            aria-describedby={undefined}
            className="z-20 h-[min(65%,32rem)] max-h-none gap-0 border-pdf-border p-0"
            onInteractOutside={(event) => {
              event.preventDefault()
            }}
            onOpenAutoFocus={(event) => {
              event.preventDefault()
            }}
            data-testid="log-drawer"
          >
            <SheetTitle className="sr-only">Logs de compilation</SheetTitle>
            <LogPanel
              result={result}
              onOpenLocation={onOpenLocation}
              onFixPackage={onFixPackage}
              onClearCache={onClearCache}
              onClose={() => {
                setLogsOpen(false)
              }}
            />
          </SheetContent>
        </Sheet>

        <PdfFloatingBar
          page={pdfUrl === null ? 0 : position.page}
          pages={pdfUrl === null ? 0 : position.pages}
          canUndo={canGoToPdf && canEdit}
          canGoToPdf={canGoToPdf && pdfUrl !== null}
          onUndo={onUndo}
          onRedo={onRedo}
          onPage={(page) => {
            viewer.current?.goToPage(page)
          }}
          onGoToPdf={onGoToPdf}
        />
      </div>
    </section>
  )
}

/** Aperçu sans PDF : compilation en cours, projet jamais compilé, ou échec (lien vers les logs). */
function PdfEmptyState({
  result,
  compiling,
  phase,
  onCompile,
  onShowLogs,
}: {
  result: CompileResult | null
  compiling: boolean
  phase: CompilePhase | null
  onCompile: () => void
  onShowLogs: () => void
}) {
  if (compiling) {
    return (
      <p
        className="mt-16 text-center text-sm text-pdf-muted-foreground"
        role="status"
        data-testid="pdf-viewer"
      >
        {phase === 'preparing' || phase === 'queued' ? phaseLabel(phase) : 'Compilation en cours…'}
      </p>
    )
  }
  if (result === null) {
    return (
      <div
        className="mt-16 flex flex-col items-center gap-3 px-6 text-center"
        data-testid="pdf-viewer"
      >
        <p className="text-sm font-medium">Ce projet n'a pas encore été compilé.</p>
        <p className="text-sm text-pdf-muted-foreground">
          Compilez-le pour voir le PDF (Ctrl+Entrée).
        </p>
        <Button size="sm" onClick={onCompile}>
          <PlayIcon /> Compiler
        </Button>
      </div>
    )
  }
  return (
    <div
      className="mt-16 flex flex-col items-center gap-3 px-6 text-center"
      data-testid="pdf-viewer"
    >
      <FileWarningIcon className="size-8 text-destructive" />
      <p className="text-sm font-medium">
        {result.status === 'timeout'
          ? 'La compilation a dépassé le temps autorisé.'
          : 'La compilation n’a produit aucun PDF.'}
      </p>
      {/* Durée maximale du plan du propriétaire atteinte : un plan supérieur la lève. */}
      {result.planLimit ? (
        <PlanLimitNotice error={result.planLimit} compact className="max-w-sm text-left" />
      ) : null}
      <Button size="sm" variant="outline" onClick={onShowLogs}>
        Voir les logs
      </Button>
    </div>
  )
}
