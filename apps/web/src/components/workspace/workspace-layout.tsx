'use client'

import type { ResolvedPreferences, UserPreferences } from '@kaxolax/contracts'
import {
  Button,
  type ResizableGroupHandle,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  type ResizablePanelHandle,
  Sheet,
  SheetContent,
  SheetTitle,
  SimpleTooltip,
  cn,
} from '@kaxolax/ui'
import { MenuIcon, PanelLeftOpenIcon } from 'lucide-react'
import type { ReactNode } from 'react'
import { useEffect, useRef, useState } from 'react'
import { useIsNarrow } from '@/hooks/use-media-query'
import { moveTabFocus } from '@/lib/keyboard'
import { columnsLayout, layoutPatch, PANEL_IDS, SIDEBAR_MAX, SIDEBAR_MIN } from '@/lib/layout'

/** Vue affichée sur un écran étroit (l'éditeur et le PDF passent en onglets). */
export type NarrowView = 'editor' | 'pdf'

export interface SidebarSlotProps {
  onCollapse: () => void
  collapseLabel: string
}

/**
 * Mise en page de la page projet. Au moins 1024 px : trois colonnes redimensionnables, sidebar
 * repliable, tailles et repli mémorisés dans les préférences (`layout`). En dessous : sidebar en
 * tiroir, éditeur et PDF en onglets.
 */
export function WorkspaceLayout({
  layout,
  onLayoutChange,
  narrowView,
  onNarrowViewChange,
  revealSidebar = 0,
  dismissDrawer = 0,
  openSidebarOnMount = false,
  onSidebarShownChange,
  sidebarUnread = false,
  sidebar,
  editor,
  pdf,
}: {
  layout: ResolvedPreferences['layout']
  onLayoutChange: (patch: UserPreferences) => void
  narrowView: NarrowView
  onNarrowViewChange: (view: NarrowView) => void
  /** Compteur : chaque incrément affiche la sidebar (dépliée, ou tiroir ouvert sur écran étroit). */
  revealSidebar?: number
  /** Compteur : chaque incrément ferme le tiroir de la sidebar (fichier ouvert depuis celle-ci). */
  dismissDrawer?: number
  /** Sidebar affichée dès le montage (lien `?panel=chat` de l'email de mention). */
  openSidebarOnMount?: boolean
  /** Sidebar réellement visible (dépliée, ou tiroir ouvert sur écran étroit). */
  onSidebarShownChange?: (shown: boolean) => void
  /** Pastille de non-lus sur les boutons qui affichent une sidebar masquée. */
  sidebarUnread?: boolean
  sidebar: (slot: SidebarSlotProps) => ReactNode
  /** `leading` : boutons à placer en tête de la barre d'onglets de l'éditeur. */
  editor: (leading: ReactNode) => ReactNode
  /** `leading` : boutons à placer en tête de l'en-tête du PDF (écran étroit). */
  pdf: (leading: ReactNode) => ReactNode
}) {
  const narrow = useIsNarrow()
  const [drawerOpen, setDrawerOpen] = useState(openSidebarOnMount)
  // Poignées impératives gardées en état (et non en ref) : utilisables pendant le rendu.
  const [group, setGroup] = useState<ResizableGroupHandle | null>(null)
  const [sidebarPanel, setSidebarPanel] = useState<ResizablePanelHandle | null>(null)
  const [revealed, setRevealed] = useState(revealSidebar)
  const [dismissed, setDismissed] = useState(dismissDrawer)

  const expanded = useRef(revealSidebar)
  // Dépliage demandé au montage, appliqué dès que le groupe est prêt.
  const openOnMount = useRef(openSidebarOnMount)

  const shown = narrow ? drawerOpen : !layout.sidebarCollapsed
  useEffect(() => {
    onSidebarShownChange?.(shown)
  }, [shown, onSidebarShownChange])

  // Demande d'affichage de la sidebar : tiroir ouvert sur écran étroit (ajustement d'état pendant
  // le rendu), colonne dépliée sinon (API impérative du groupe, dans un effet).
  if (revealed !== revealSidebar) {
    setRevealed(revealSidebar)
    if (narrow) setDrawerOpen(true)
  }
  if (dismissed !== dismissDrawer) {
    setDismissed(dismissDrawer)
    setDrawerOpen(false)
  }
  useEffect(() => {
    if ((expanded.current === revealSidebar && !openOnMount.current) || group === null) return
    expanded.current = revealSidebar
    openOnMount.current = false
    if (narrow || !layout.sidebarCollapsed) return
    group.setLayout(columnsLayout({ ...layout, sidebarCollapsed: false }))
    onLayoutChange({ layout: { sidebarCollapsed: false } })
  }, [revealSidebar, narrow, group, layout, onLayoutChange])

  if (narrow) {
    const switcher = (
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="ghost"
          size="icon-sm"
          className="relative"
          aria-label={
            sidebarUnread
              ? 'Ouvrir la barre latérale (messages non lus)'
              : 'Ouvrir la barre latérale'
          }
          onClick={() => {
            setDrawerOpen(true)
          }}
        >
          <MenuIcon />
          {sidebarUnread ? <UnreadDot /> : null}
        </Button>
        <div
          role="tablist"
          aria-label="Vue"
          className="flex rounded-md border p-0.5 text-xs"
          onKeyDown={(event) => {
            // Activation automatique : la vue suit le focus (deux vues seulement).
            if (!moveTabFocus(event)) return
            const view = document.activeElement?.getAttribute('data-view')
            if (view === 'editor' || view === 'pdf') onNarrowViewChange(view)
          }}
        >
          {(['editor', 'pdf'] as const).map((view) => (
            <button
              key={view}
              type="button"
              role="tab"
              aria-selected={narrowView === view}
              tabIndex={narrowView === view ? 0 : -1}
              data-view={view}
              data-testid={`view-${view}`}
              className={cn(
                'rounded-sm px-2 py-0.5 font-medium outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50',
                narrowView === view ? 'bg-tools text-tools-foreground' : 'opacity-70',
              )}
              onClick={() => {
                onNarrowViewChange(view)
              }}
            >
              {view === 'editor' ? 'Éditeur' : 'PDF'}
            </button>
          ))}
        </div>
      </div>
    )
    return (
      <div className="flex h-dvh flex-col">
        <Sheet open={drawerOpen} onOpenChange={setDrawerOpen}>
          <SheetContent
            side="left"
            showCloseButton={false}
            className="w-80 max-w-[85vw] gap-0 border-sidebar-border p-0"
          >
            <SheetTitle className="sr-only">Barre latérale</SheetTitle>
            {sidebar({
              onCollapse: () => {
                setDrawerOpen(false)
              },
              collapseLabel: 'Fermer la barre latérale',
            })}
          </SheetContent>
        </Sheet>
        {/* Les deux vues restent montées : l'éditeur garde sa connexion et le PDF son rendu. */}
        <div className={cn('min-h-0 flex-1', narrowView !== 'editor' && 'hidden')}>
          {editor(switcher)}
        </div>
        <div className={cn('min-h-0 flex-1', narrowView !== 'pdf' && 'hidden')}>
          {pdf(switcher)}
        </div>
      </div>
    )
  }

  // Le bouton cliqué disparaît : le focus passe au bouton inverse, une fois rendu.
  const focusSoon = (testId: string) => {
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-testid="${testId}"]`)?.focus()
    })
  }
  const collapse = () => {
    sidebarPanel?.collapse()
    onLayoutChange({ layout: { sidebarCollapsed: true } })
    focusSoon('sidebar-expand')
  }
  const expand = () => {
    group?.setLayout(columnsLayout({ ...layout, sidebarCollapsed: false }))
    onLayoutChange({ layout: { sidebarCollapsed: false } })
    focusSoon('sidebar-collapse')
  }

  return (
    <ResizablePanelGroup
      orientation="horizontal"
      className="h-dvh"
      groupRef={setGroup}
      defaultLayout={columnsLayout(layout)}
      onLayoutChanged={(next, meta) => {
        // Seuls les redimensionnements de l'utilisateur sont mémorisés (pas le montage).
        if (meta.isUserInteraction) onLayoutChange(layoutPatch(meta.requestedLayout ?? next))
      }}
    >
      <ResizablePanel
        id={PANEL_IDS.sidebar}
        panelRef={setSidebarPanel}
        collapsible
        collapsedSize="0"
        minSize={String(SIDEBAR_MIN)}
        maxSize={String(SIDEBAR_MAX)}
      >
        {/* Repliée (largeur nulle), la sidebar sort de l'ordre de tabulation. */}
        <div className="h-full" inert={layout.sidebarCollapsed}>
          {sidebar({ onCollapse: collapse, collapseLabel: 'Replier la barre latérale' })}
        </div>
      </ResizablePanel>
      <ResizableHandle withHandle={false} className="bg-sidebar-border" />
      <ResizablePanel id={PANEL_IDS.editor} minSize="20">
        {editor(
          layout.sidebarCollapsed ? (
            <SimpleTooltip label="Déplier la barre latérale">
              <Button
                variant="ghost"
                size="icon-xs"
                className="relative shrink-0 text-editor-tab-foreground hover:bg-editor-tab-active"
                aria-label={
                  sidebarUnread
                    ? 'Déplier la barre latérale (messages non lus)'
                    : 'Déplier la barre latérale'
                }
                data-testid="sidebar-expand"
                onClick={expand}
              >
                <PanelLeftOpenIcon />
                {sidebarUnread ? <UnreadDot /> : null}
              </Button>
            </SimpleTooltip>
          ) : null,
        )}
      </ResizablePanel>
      <ResizableHandle withHandle={false} className="bg-editor-border" />
      <ResizablePanel id={PANEL_IDS.pdf} minSize="20">
        {pdf(null)}
      </ResizablePanel>
    </ResizablePanelGroup>
  )
}

/** Pastille des messages du chat non lus, sur un bouton qui affiche la sidebar. */
function UnreadDot() {
  return (
    <span
      aria-hidden="true"
      data-testid="sidebar-unread-dot"
      className="absolute top-0.5 right-0.5 size-2 rounded-full bg-sidebar-primary"
    />
  )
}
