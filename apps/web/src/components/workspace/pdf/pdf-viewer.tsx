'use client'

import type { PdfPosition } from '@kaxolax/contracts'
import { Spinner } from '@kaxolax/ui'
import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs'
import type {
  PDFDocumentLoadingTask,
  PDFDocumentProxy,
  PDFPageProxy,
} from 'pdfjs-dist/legacy/build/pdf.mjs'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import { type PdfZoom, zoomScale } from '@/lib/pdf'

/** Commandes de la visionneuse pour la barre flottante. */
export interface PdfViewerHandle {
  goToPage: (page: number) => void
}

type PdfJs = typeof PdfJsModule
let pdfjsPromise: Promise<PdfJs> | null = null

/**
 * pdf.js est chargé côté navigateur seulement, avec son worker. Build « legacy » : le build
 * moderne utilise des API trop récentes (Map.prototype.getOrInsertComputed) pour une partie des
 * navigateurs encore en service ; le legacy embarque les polyfills.
 */
function loadPdfJs(): Promise<PdfJs> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/legacy/build/pdf.worker.min.mjs',
      import.meta.url,
    ).toString()
    return pdfjs
  })
  return pdfjsPromise
}

interface PageSize {
  width: number
  height: number
}

/** Une page : rendue (canevas + couche texte) quand elle devient visible. */
function PdfPage({
  pdf,
  pageNumber,
  size,
  scale,
  highlight,
  onDoubleClick,
}: {
  pdf: PDFDocumentProxy
  pageNumber: number
  size: PageSize
  scale: number
  highlight: PdfPosition | null
  onDoubleClick: (page: number, h: number, v: number) => void
}) {
  const wrapper = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const textLayer = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    const element = wrapper.current
    if (!element) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) setVisible(true)
      },
      { rootMargin: '600px 0px' },
    )
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])

  useEffect(() => {
    if (!visible || !canvas.current || !textLayer.current) return
    const state = { cancelled: false }
    // Fonction plutôt que propriété : TypeScript ne garde pas le rétrécissement après un await.
    const cancelled = () => state.cancelled
    let renderTask: ReturnType<PDFPageProxy['render']> | null = null
    let text: { cancel: () => void } | null = null
    const target = canvas.current
    const layer = textLayer.current
    void (async () => {
      const pdfjs = await loadPdfJs()
      const page = await pdf.getPage(pageNumber)
      if (cancelled()) return
      const viewport = page.getViewport({ scale })
      const ratio = window.devicePixelRatio || 1
      target.width = Math.floor(viewport.width * ratio)
      target.height = Math.floor(viewport.height * ratio)
      renderTask = page.render({
        canvas: target,
        viewport,
        transform: ratio === 1 ? undefined : [ratio, 0, 0, ratio, 0, 0],
      })
      await renderTask.promise.catch(() => undefined)
      if (cancelled()) return
      layer.replaceChildren()
      layer.style.setProperty('--scale-factor', String(scale))
      const textLayerInstance = new pdfjs.TextLayer({
        textContentSource: page.streamTextContent(),
        container: layer,
        viewport,
      })
      text = textLayerInstance
      await textLayerInstance.render().catch(() => undefined)
    })()
    return () => {
      state.cancelled = true
      renderTask?.cancel()
      text?.cancel()
    }
  }, [visible, pdf, pageNumber, scale])

  const onPageDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    // Coordonnées PDF en points, origine en haut à gauche (convention de synctex edit).
    onDoubleClick(pageNumber, (event.clientX - box.left) / scale, (event.clientY - box.top) / scale)
  }

  return (
    <div
      ref={wrapper}
      data-page-number={pageNumber}
      className="relative mx-auto mb-4 bg-pdf-page shadow-md"
      style={{ width: size.width * scale, height: size.height * scale }}
      onDoubleClick={onPageDoubleClick}
    >
      <canvas ref={canvas} className="absolute inset-0 h-full w-full" />
      <div ref={textLayer} className="textLayer" />
      {highlight?.page === pageNumber ? (
        <div
          data-testid="synctex-highlight"
          className="pointer-events-none absolute animate-pulse rounded-sm bg-amber-300/40 ring-2 ring-amber-500"
          style={{
            left: highlight.h * scale,
            top: (highlight.v - highlight.height) * scale,
            width: Math.max(highlight.width, 20) * scale,
            height: Math.max(highlight.height, 8) * scale,
          }}
        />
      ) : null}
    </div>
  )
}

/**
 * Visionneuse PDF (pdf.js) : défilement continu, pages rendues à la demande, couche texte,
 * surlignage SyncTeX et double-clic vers le code. Le zoom est piloté par la colonne PDF ; la page
 * courante lui est signalée par `onPageChange`.
 */
export function PdfViewer({
  url,
  zoom,
  highlight,
  onDoubleClick,
  onPageChange,
  handleRef,
  onLoadError,
  errorActions,
}: {
  url: string
  zoom: PdfZoom
  highlight: PdfPosition | null
  onDoubleClick: (page: number, h: number, v: number) => void
  /** Page courante (la plus visible) et nombre de pages. */
  onPageChange: (page: number, pages: number) => void
  handleRef?: (handle: PdfViewerHandle | null) => void
  /** Échec du chargement de `url` (lien présigné expiré, par exemple). */
  onLoadError?: () => void
  /** Actions affichées sous le message d'erreur (recharger, voir les logs). */
  errorActions?: ReactNode
}) {
  const scroller = useRef<HTMLDivElement>(null)
  // Document chargé et erreur, gardés avec l'URL dont ils viennent : rien à réinitialiser quand elle change.
  const [loaded, setLoaded] = useState<{
    url: string
    pdf: PDFDocumentProxy
    sizes: PageSize[]
  } | null>(null)
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null)
  const [area, setArea] = useState<{ width: number; height: number } | null>(null)
  // Après une recompilation, l'ancien PDF reste affiché jusqu'au chargement du nouveau.
  const pdf = loaded?.pdf ?? null
  const sizes = useMemo(() => loaded?.sizes ?? [], [loaded])
  const error = failure?.url === url ? failure.message : null
  const firstPage = sizes[0]
  const scale = firstPage !== undefined && area !== null ? zoomScale(zoom, firstPage, area) : null
  const callbacks = useRef({ onPageChange, onLoadError })

  useEffect(() => {
    callbacks.current = { onPageChange, onLoadError }
  })

  useEffect(() => {
    const state = { cancelled: false, shown: false }
    // Fonction plutôt que propriété : TypeScript ne garde pas le rétrécissement après un await.
    const cancelled = () => state.cancelled
    // Tâche gardée dès sa création : un changement d'URL pendant le chargement la détruit, document
    // compris, même si `getDocument` n'a pas encore abouti.
    let loadingTask: PDFDocumentLoadingTask | null = null
    void (async () => {
      try {
        const pdfjs = await loadPdfJs()
        if (cancelled()) return
        loadingTask = pdfjs.getDocument({ url })
        const document = await loadingTask.promise
        const pageSizes: PageSize[] = []
        for (let number = 1; number <= document.numPages; number++) {
          const viewport = (await document.getPage(number)).getViewport({ scale: 1 })
          pageSizes.push({ width: viewport.width, height: viewport.height })
        }
        if (cancelled()) return
        state.shown = true
        setLoaded({ url, pdf: document, sizes: pageSizes })
      } catch (caught) {
        if (cancelled()) return
        setFailure({ url, message: caught instanceof Error ? caught.message : String(caught) })
        callbacks.current.onLoadError?.()
      }
    })()
    return () => {
      state.cancelled = true
      // Un document affiché reste utilisable jusqu'à l'arrivée du suivant (effet ci-dessous).
      if (!state.shown) void loadingTask?.destroy()
    }
  }, [url])

  // Document remplacé par le suivant, ou visionneuse démontée : ses ressources sont libérées.
  useEffect(() => {
    const shown = loaded?.pdf
    return () => {
      void shown?.loadingTask.destroy()
    }
  }, [loaded])

  // Taille de la zone d'affichage : zooms « page » et « largeur » recalculés au redimensionnement.
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    const observer = new ResizeObserver(() => {
      setArea((previous) =>
        previous?.width === element.clientWidth && previous.height === element.clientHeight
          ? previous
          : { width: element.clientWidth, height: element.clientHeight },
      )
    })
    observer.observe(element)
    return () => {
      observer.disconnect()
    }
  }, [])

  // Page courante : celle qui occupe le tiers haut de la zone d'affichage.
  useEffect(() => {
    const element = scroller.current
    if (!element || sizes.length === 0) return
    const report = () => {
      const probe = element.scrollTop + element.clientHeight / 3
      let page = 1
      for (const child of element.querySelectorAll<HTMLElement>('[data-page-number]')) {
        if (child.offsetTop <= probe) page = Number(child.dataset.pageNumber)
      }
      callbacks.current.onPageChange(page, sizes.length)
    }
    report()
    element.addEventListener('scroll', report, { passive: true })
    return () => {
      element.removeEventListener('scroll', report)
    }
  }, [sizes, scale])

  useEffect(() => {
    if (!handleRef) return
    handleRef({
      goToPage: (page) => {
        const element = scroller.current?.querySelector<HTMLElement>(
          `[data-page-number="${String(page)}"]`,
        )
        if (element && scroller.current)
          scroller.current.scrollTo({ top: element.offsetTop - 16, behavior: 'smooth' })
      },
    })
    return () => {
      handleRef(null)
    }
  }, [handleRef])

  // Zone SyncTeX : la page correspondante défile jusqu'au surlignage.
  useEffect(() => {
    if (highlight === null || scale === null || !scroller.current) return
    const page = scroller.current.querySelector<HTMLElement>(
      `[data-page-number="${String(highlight.page)}"]`,
    )
    if (page)
      scroller.current.scrollTo({
        top: page.offsetTop + (highlight.v - highlight.height) * scale - 120,
        behavior: 'smooth',
      })
  }, [highlight, scale])

  return (
    <div
      ref={scroller}
      className="relative h-full overflow-auto p-4 pb-20"
      data-testid="pdf-viewer"
    >
      {error ? (
        <div className="mt-8 flex flex-col items-center gap-3 px-6 text-center">
          <p className="text-sm text-destructive">Impossible d'afficher le PDF : {error}</p>
          {errorActions ? <div className="flex gap-2">{errorActions}</div> : null}
        </div>
      ) : null}
      {!error && (pdf === null || scale === null) ? (
        <p className="mt-8 flex items-center justify-center gap-2 text-sm text-pdf-muted-foreground">
          <Spinner label="" /> Chargement de l'aperçu PDF…
        </p>
      ) : null}
      {pdf && scale !== null
        ? sizes.map((size, index) => (
            <PdfPage
              key={`${loaded?.url ?? url}-${String(index)}`}
              pdf={pdf}
              pageNumber={index + 1}
              size={size}
              scale={scale}
              highlight={highlight}
              onDoubleClick={onDoubleClick}
            />
          ))
        : null}
    </div>
  )
}
