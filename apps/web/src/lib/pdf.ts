/** Aperçu PDF et pastille de statut : calculs sans interface (testés unitairement). */
import type { CompileResult } from '@kaxolax/contracts'

/** Zoom du PDF : ajusté à la page, à la largeur, ou facteur fixe (1 = 100 %). */
export type PdfZoom = 'page-fit' | 'page-width' | number

/** Niveaux proposés par le menu de zoom, de 50 à 400 %. */
export const ZOOM_LEVELS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4]

/** Marge autour des pages (padding du conteneur), en pixels. */
const PAGE_MARGIN = 32

/** Facteur d'échelle d'un zoom pour une page et une zone d'affichage données. */
export function zoomScale(
  zoom: PdfZoom,
  page: { width: number; height: number },
  area: { width: number; height: number },
): number {
  if (typeof zoom === 'number') return zoom
  const byWidth = (area.width - PAGE_MARGIN) / page.width
  const scale =
    zoom === 'page-width' ? byWidth : Math.min(byWidth, (area.height - PAGE_MARGIN) / page.height)
  return Math.min(4, Math.max(0.25, scale))
}

/** État affiché par la pastille, déduit du dernier résultat. */
export type CompileStatusKind = 'never' | 'compiling' | 'success' | 'errors' | 'timeout' | 'failed'

export function compileStatusKind(
  result: CompileResult | null,
  compiling: boolean,
): CompileStatusKind {
  if (compiling) return 'compiling'
  if (result === null) return 'never'
  if (result.status === 'timeout') return 'timeout'
  if (result.entries.some((entry) => entry.level === 'error')) return 'errors'
  return result.status === 'success' ? 'success' : 'failed'
}
