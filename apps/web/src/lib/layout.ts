import type { ResolvedPreferences, UserPreferences } from '@kaxolax/contracts'

/** Identifiants des trois colonnes (react-resizable-panels). */
export const PANEL_IDS = { sidebar: 'sidebar-panel', editor: 'editor-panel', pdf: 'pdf-panel' }

/** Bornes de la sidebar dépliée, en pourcentage de la largeur. */
export const SIDEBAR_MIN = 12
export const SIDEBAR_MAX = 35

type LayoutPreferences = ResolvedPreferences['layout']
/** Tailles des colonnes par identifiant de panneau, en pourcentage (somme 100). */
export type ColumnsLayout = Record<string, number>

const round = (value: number) => Math.round(value * 100) / 100

/**
 * Tailles des colonnes à partir des préférences : sidebar bornée (0 si repliée), éditeur et PDF
 * se partagent le reste dans leur proportion mémorisée.
 */
export function columnsLayout(layout: LayoutPreferences): ColumnsLayout {
  const sidebar = layout.sidebarCollapsed
    ? 0
    : Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, layout.sidebarSize))
  const rest = 100 - sidebar
  const total = layout.editorSize + layout.pdfSize
  const editor = total > 0 ? round((rest * layout.editorSize) / total) : round(rest / 2)
  return {
    [PANEL_IDS.sidebar]: sidebar,
    [PANEL_IDS.editor]: editor,
    [PANEL_IDS.pdf]: round(rest - editor),
  }
}

/**
 * Préférences à enregistrer après un redimensionnement par l'utilisateur. Sidebar repliée (taille
 * nulle) : sa dernière taille dépliée est gardée.
 */
export function layoutPatch(layout: ColumnsLayout): UserPreferences {
  const sidebar = layout[PANEL_IDS.sidebar] ?? 0
  const editorSize = round(layout[PANEL_IDS.editor] ?? 0)
  const pdfSize = round(layout[PANEL_IDS.pdf] ?? 0)
  if (sidebar < 1) return { layout: { sidebarCollapsed: true, editorSize, pdfSize } }
  return { layout: { sidebarCollapsed: false, sidebarSize: round(sidebar), editorSize, pdfSize } }
}
