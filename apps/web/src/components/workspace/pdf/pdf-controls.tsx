'use client'

import { DOWNLOADABLE_OUTPUTS, type OutputDownload } from '@kaxolax/contracts'
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
  SimpleTooltip,
} from '@kaxolax/ui'
import {
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  CrosshairIcon,
  DownloadIcon,
  EllipsisIcon,
  ExternalLinkIcon,
  FileArchiveIcon,
  FolderOutputIcon,
  PrinterIcon,
  Redo2Icon,
  Undo2Icon,
} from 'lucide-react'
import { type PdfZoom, ZOOM_LEVELS } from '@/lib/pdf'

/** Libellé d'un zoom (« Ajuster à la page », « 125 % »). */
export function zoomLabel(zoom: PdfZoom): string {
  if (zoom === 'page-fit') return 'Ajuster à la page'
  if (zoom === 'page-width') return 'Ajuster à la largeur'
  return `${String(Math.round(zoom * 100))} %`
}

/** Menu de zoom : ajusté à la page ou à la largeur, ou niveau fixe de 50 à 400 %. */
export function ZoomMenu({
  zoom,
  disabled,
  onChange,
}: {
  zoom: PdfZoom
  disabled: boolean
  onChange: (zoom: PdfZoom) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="xs"
          disabled={disabled}
          className="text-pdf-toolbar-foreground hover:bg-pdf-accent"
          aria-label="Zoom"
        >
          <span data-testid="zoom-level">{zoomLabel(zoom)}</span>
          <ChevronDownIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuRadioGroup
          value={String(zoom)}
          onValueChange={(value) => {
            onChange(value === 'page-fit' || value === 'page-width' ? value : Number(value))
          }}
        >
          <DropdownMenuRadioItem value="page-fit">Ajuster à la page</DropdownMenuRadioItem>
          <DropdownMenuRadioItem value="page-width">Ajuster à la largeur</DropdownMenuRadioItem>
          <DropdownMenuSeparator />
          {ZOOM_LEVELS.map((level) => (
            <DropdownMenuRadioItem key={level} value={String(level)}>
              {zoomLabel(level)}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

/** Téléchargement du PDF, et menu ⋯ : zip des sources, fichiers de sortie, nouvel onglet, impression. */
export function PdfActions({
  hasPdf,
  outputFiles,
  onDownloadPdf,
  onDownloadOutput,
  onDownloadZip,
  onOpenInNewTab,
  onPrint,
}: {
  hasPdf: boolean
  /** Fichiers de sortie de la dernière compilation (log, SyncTeX, .bbl…). */
  outputFiles: readonly OutputDownload[]
  onDownloadPdf: () => void
  /** Télécharge un fichier de sortie par son nom (lien présigné vérifié au moment du clic). */
  onDownloadOutput: (name: string) => void
  onDownloadZip: () => void
  onOpenInNewTab: () => void
  onPrint: () => void
}) {
  return (
    <>
      <SimpleTooltip label="Télécharger le PDF">
        <Button
          variant="ghost"
          size="icon-sm"
          disabled={!hasPdf}
          className="text-pdf-toolbar-foreground hover:bg-pdf-accent"
          aria-label="Télécharger le PDF"
          data-testid="download-pdf"
          onClick={onDownloadPdf}
        >
          <DownloadIcon />
        </Button>
      </SimpleTooltip>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-pdf-toolbar-foreground hover:bg-pdf-accent"
            aria-label="Plus d'actions"
            data-testid="pdf-more-menu"
          >
            <EllipsisIcon />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={onDownloadZip} data-testid="download-zip">
            <FileArchiveIcon /> Sources du projet (zip)
          </DropdownMenuItem>
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={outputFiles.length === 0}>
              <FolderOutputIcon /> Fichiers de sortie
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {outputFiles.map((file) => (
                <DropdownMenuItem
                  key={file.name}
                  onSelect={() => {
                    onDownloadOutput(file.name)
                  }}
                  data-testid={`output-${file.name}`}
                >
                  {DOWNLOADABLE_OUTPUTS.find((output) => output.name === file.name)?.label ??
                    file.name}
                  <span className="ml-auto pl-4 font-mono text-xs text-muted-foreground">
                    {file.name}
                  </span>
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          <DropdownMenuSeparator />
          <DropdownMenuItem disabled={!hasPdf} onSelect={onOpenInNewTab}>
            <ExternalLinkIcon /> Ouvrir le PDF dans un nouvel onglet
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!hasPdf} onSelect={onPrint}>
            <PrinterIcon /> Imprimer
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </>
  )
}

/**
 * Barre flottante en bas du PDF : annuler et rétablir (éditeur), page précédente et suivante,
 * et « Aller au PDF » (SyncTeX depuis la ligne du curseur).
 */
export function PdfFloatingBar({
  page,
  pages,
  canUndo,
  canGoToPdf,
  onUndo,
  onRedo,
  onPage,
  onGoToPdf,
}: {
  page: number
  pages: number
  canUndo: boolean
  canGoToPdf: boolean
  onUndo: () => void
  onRedo: () => void
  onPage: (page: number) => void
  onGoToPdf: () => void
}) {
  const buttonClass = 'text-pdf-floating-foreground hover:bg-pdf-accent'
  return (
    <div className="absolute bottom-4 left-1/2 z-10 flex -translate-x-1/2 items-center gap-0.5 rounded-lg border border-pdf-border bg-pdf-floating p-1 text-pdf-floating-foreground shadow-floating">
      <SimpleTooltip label="Annuler" shortcut="Mod-z">
        <Button
          variant="ghost"
          size="icon-sm"
          className={buttonClass}
          disabled={!canUndo}
          aria-label="Annuler"
          onClick={onUndo}
        >
          <Undo2Icon />
        </Button>
      </SimpleTooltip>
      <SimpleTooltip label="Rétablir" shortcut="Mod-y">
        <Button
          variant="ghost"
          size="icon-sm"
          className={buttonClass}
          disabled={!canUndo}
          aria-label="Rétablir"
          onClick={onRedo}
        >
          <Redo2Icon />
        </Button>
      </SimpleTooltip>
      <span className="mx-1 h-5 w-px bg-pdf-border" />
      <Button
        variant="ghost"
        size="icon-sm"
        className={buttonClass}
        disabled={pages === 0 || page <= 1}
        aria-label="Page précédente"
        onClick={() => {
          onPage(page - 1)
        }}
      >
        <ChevronLeftIcon />
      </Button>
      <span className="min-w-14 text-center text-xs tabular-nums" aria-live="polite">
        {pages === 0 ? '–' : page} / <span data-testid="pdf-page-count">{pages}</span>
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        className={buttonClass}
        disabled={pages === 0 || page >= pages}
        aria-label="Page suivante"
        onClick={() => {
          onPage(page + 1)
        }}
      >
        <ChevronRightIcon />
      </Button>
      <span className="mx-1 h-5 w-px bg-pdf-border" />
      <SimpleTooltip label="Du code vers le PDF (SyncTeX)">
        <Button
          variant="ghost"
          size="xs"
          className={buttonClass}
          disabled={!canGoToPdf}
          onClick={onGoToPdf}
          data-testid="synctex-to-pdf"
        >
          <CrosshairIcon /> Aller au PDF
        </Button>
      </SimpleTooltip>
    </div>
  )
}
