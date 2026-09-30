'use client'

import type { PdfPosition } from '@kaxolax/contracts'
import { Button } from '@kaxolax/ui'
import { DownloadIcon, ZoomInIcon, ZoomOutIcon } from 'lucide-react'
import type * as PdfJsModule from 'pdfjs-dist/legacy/build/pdf.mjs'
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { useCallback, useEffect, useRef, useState } from 'react'

const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3]

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
      className="relative mx-auto mb-4 bg-white shadow"
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

export function PdfViewer({
  url,
  fileName,
  highlight,
  onDoubleClick,
}: {
  url: string | null
  fileName: string
  highlight: PdfPosition | null
  onDoubleClick: (page: number, h: number, v: number) => void
}) {
  const scroller = useRef<HTMLDivElement>(null)
  // Document chargé et erreur, gardés avec l'URL dont ils viennent : rien à réinitialiser quand elle change.
  const [loaded, setLoaded] = useState<{
    url: string
    pdf: PDFDocumentProxy
    sizes: PageSize[]
  } | null>(null)
  const [failure, setFailure] = useState<{ url: string; message: string } | null>(null)
  const [scale, setScale] = useState<number | null>(null)
  const current = url !== null && loaded?.url === url ? loaded : null
  const pdf = current?.pdf ?? null
  const sizes = current?.sizes ?? []
  const error = url !== null && failure?.url === url ? failure.message : null

  useEffect(() => {
    if (url === null) return
    const state: { cancelled: boolean; document: PDFDocumentProxy | null } = {
      cancelled: false,
      document: null,
    }
    void (async () => {
      try {
        const pdfjs = await loadPdfJs()
        const document = await pdfjs.getDocument({ url }).promise
        state.document = document
        const pageSizes: PageSize[] = []
        for (let number = 1; number <= document.numPages; number++) {
          const viewport = (await document.getPage(number)).getViewport({ scale: 1 })
          pageSizes.push({ width: viewport.width, height: viewport.height })
        }
        if (state.cancelled) return
        setLoaded({ url, pdf: document, sizes: pageSizes })
        // Première ouverture : largeur de la page ajustée au panneau.
        setScale((previous) => {
          if (previous !== null) return previous
          const available = (scroller.current?.clientWidth ?? 800) - 32
          return Math.min(2, Math.max(0.5, available / (pageSizes[0]?.width ?? 612)))
        })
      } catch (caught) {
        if (!state.cancelled)
          setFailure({ url, message: caught instanceof Error ? caught.message : String(caught) })
      }
    })()
    return () => {
      state.cancelled = true
      void state.document?.loadingTask.destroy()
    }
  }, [url])

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

  const zoom = useCallback((direction: 1 | -1) => {
    setScale((current) => {
      const value = current ?? 1
      const next =
        direction === 1
          ? ZOOM_STEPS.find((step) => step > value + 0.01)
          : [...ZOOM_STEPS].reverse().find((step) => step < value - 0.01)
      return next ?? value
    })
  }, [])

  const download = useCallback(async () => {
    if (url === null) return
    // L'URL présignée est sur une autre origine : l'attribut download n'y suffit pas.
    const blob = await (await fetch(url)).blob()
    const link = document.createElement('a')
    link.href = URL.createObjectURL(blob)
    link.download = fileName
    link.click()
    URL.revokeObjectURL(link.href)
  }, [url, fileName])

  return (
    <div className="flex h-full flex-col bg-muted">
      <div className="flex h-10 shrink-0 items-center gap-1 border-b bg-background px-2">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            zoom(-1)
          }}
          disabled={pdf === null}
          aria-label="Zoom arrière"
        >
          <ZoomOutIcon />
        </Button>
        <span className="w-12 text-center text-xs tabular-nums" data-testid="zoom-level">
          {scale === null ? '–' : `${String(Math.round(scale * 100))} %`}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => {
            zoom(1)
          }}
          disabled={pdf === null}
          aria-label="Zoom avant"
        >
          <ZoomInIcon />
        </Button>
        <span className="ml-2 text-xs text-muted-foreground">
          {pdf ? `${String(pdf.numPages)} page(s)` : ''}
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          disabled={url === null}
          onClick={() => void download()}
        >
          <DownloadIcon /> PDF
        </Button>
      </div>
      <div ref={scroller} className="relative flex-1 overflow-auto p-4" data-testid="pdf-viewer">
        {error ? (
          <p className="text-sm text-destructive">Impossible d'afficher le PDF : {error}</p>
        ) : null}
        {url === null ? (
          <p className="mt-8 text-center text-sm text-muted-foreground">
            Compilez le projet pour voir le PDF.
          </p>
        ) : null}
        {pdf && scale !== null
          ? sizes.map((size, index) => (
              <PdfPage
                key={`${url}-${String(index)}`}
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
    </div>
  )
}
