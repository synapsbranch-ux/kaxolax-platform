'use client'

import type { HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import type { PresenceUser, Theme } from '@kaxolax/contracts'
import { Button, SimpleTooltip, Spinner, cn } from '@kaxolax/ui'
import { EyeIcon, HistoryIcon, MessageSquareTextIcon, WrenchIcon } from 'lucide-react'
import { type ReactNode, useState } from 'react'
import type { ProjectTree, TreeFile } from '@/lib/api'
import { AskSlot } from './ask-slot'
import { CodeEditor, type EditorHandle, type SyncState } from './code-editor'
import { EditorTabs, type OpenTab } from './editor-tabs'
import { FilePreview } from './file-preview'
import { HistoryDrawer } from '../panels/history-drawer'
import { ReviewPanel } from '../panels/review-panel'
import { useEditorActions } from '../workspace-actions'
import { ToolsBar } from './tools-bar'

const SYNC_LABELS: Record<SyncState, string> = {
  connecting: 'Connexion…',
  synced: 'Enregistré',
  saving: 'Enregistrement…',
  offline: 'Hors ligne, reconnexion…',
  closed: 'Document fermé',
}

/**
 * Colonne centrale : onglets des fichiers ouverts, boutons Review et Historique (emplacements des
 * tâches 7 et 8), bouton Tools et sa barre d'outils, éditeur CodeMirror (ou aperçu d'un fichier
 * binaire), panneau Review et zone réservée à l'assistant.
 */
export function EditorColumn({
  projectId,
  tree,
  tabs,
  activeTab,
  file,
  socket,
  connectionError,
  loading,
  canEdit,
  theme,
  autoCompile,
  toolsVisible,
  syncState,
  leading,
  notice,
  self,
  following,
  onStopFollowing,
  onActivate,
  onClose,
  onToggleTools,
  onCompile,
  onEditorReady,
  onSyncState,
}: {
  projectId: string
  tree: ProjectTree | null
  tabs: readonly OpenTab[]
  activeTab: OpenTab | null
  /** Fichier binaire de l'onglet actif (aperçu). */
  file: TreeFile | null
  socket: HocuspocusProviderWebsocket | null
  /** Connexion au service temps réel impossible (premier jeton refusé). */
  connectionError: string | null
  /** Projet et onglets en cours de chargement. */
  loading: boolean
  canEdit: boolean
  theme: Theme
  autoCompile: boolean
  toolsVisible: boolean
  syncState: SyncState
  /** Début de la barre d'onglets (rouvrir la sidebar, tiroir sur écran étroit). */
  leading?: ReactNode
  /** Message court sous les onglets (actions de la barre Tools). */
  notice?: ReactNode
  /** Sa propre identité de présence. */
  self: PresenceUser | null
  /** Collaborateur suivi (indicateur « Vous suivez … » et défilement jusqu'à son curseur). */
  following: { userId: string; name: string; color: string } | null
  /** Fin du suivi : bouton Arrêter, ou frappe dans l'éditeur. */
  onStopFollowing: () => void
  onActivate: (id: string) => void
  onClose: (id: string) => void
  onToggleTools: () => void
  onCompile: () => void
  onEditorReady: (handle: EditorHandle | null) => void
  onSyncState: (state: SyncState) => void
}) {
  const { registry, host } = useEditorActions()
  const [reviewOpen, setReviewOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const iconButton = 'text-editor-tab-foreground hover:bg-editor-tab-active'
  const documentOpen = activeTab?.kind === 'document'
  return (
    <section
      aria-label="Éditeur"
      className="flex h-full min-w-0 flex-col bg-editor text-editor-foreground"
    >
      <EditorTabs
        tabs={tabs}
        activeId={activeTab?.id ?? null}
        tree={tree}
        onActivate={onActivate}
        onClose={onClose}
        leading={leading}
        trailing={
          <>
            {documentOpen ? (
              <span
                className="hidden text-xs text-editor-tab-foreground sm:inline"
                data-testid="sync-state"
                aria-live="polite"
              >
                {SYNC_LABELS[syncState]}
              </span>
            ) : null}
            <SimpleTooltip label="Review (commentaires)">
              <Button
                variant="ghost"
                size="icon-xs"
                className={cn(iconButton, reviewOpen && 'bg-editor-tab-active')}
                aria-label="Review"
                aria-pressed={reviewOpen}
                onClick={() => {
                  setReviewOpen((open) => !open)
                }}
                data-testid="review-toggle"
              >
                <MessageSquareTextIcon />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label="Historique">
              <Button
                variant="ghost"
                size="icon-xs"
                className={iconButton}
                aria-label="Historique"
                onClick={() => {
                  setHistoryOpen(true)
                }}
                data-testid="history-button"
              >
                <HistoryIcon />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label={toolsVisible ? 'Masquer les outils' : 'Afficher les outils'}>
              <Button
                variant="accent"
                size="xs"
                aria-pressed={toolsVisible}
                aria-label="Outils"
                className={cn(toolsVisible && 'ring-2 ring-tools/40')}
                onClick={onToggleTools}
                data-testid="tools-toggle"
              >
                <WrenchIcon /> <span className="hidden sm:inline">Outils</span>
              </Button>
            </SimpleTooltip>
          </>
        }
      />
      {toolsVisible ? <ToolsBar /> : null}
      {following ? (
        <div
          role="status"
          className="flex shrink-0 items-center gap-2 border-b-2 px-3 py-1 text-xs"
          style={{ borderColor: following.color }}
          data-testid="following-indicator"
        >
          <EyeIcon className="size-3.5 shrink-0" style={{ color: following.color }} aria-hidden />
          <span className="min-w-0 truncate">
            Vous suivez <strong>{following.name}</strong> jusqu'à votre prochaine frappe.
          </span>
          <Button
            variant="ghost"
            size="xs"
            className="ml-auto text-editor-tab-foreground hover:bg-editor-tab-active"
            onClick={onStopFollowing}
            data-testid="stop-following"
          >
            Arrêter de suivre
          </Button>
        </div>
      ) : null}
      {notice}
      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1">
          {activeTab?.kind === 'document' && connectionError !== null ? (
            <p className="p-6 text-sm text-destructive" role="alert">
              Connexion au service d'édition impossible : {connectionError}
            </p>
          ) : null}
          {activeTab?.kind === 'document' && socket === null && connectionError === null ? (
            <p className="flex items-center gap-2 p-6 text-sm text-editor-gutter-foreground">
              <Spinner label="" /> Connexion au service d'édition…
            </p>
          ) : null}
          {activeTab?.kind === 'document' && socket ? (
            <CodeEditor
              key={activeTab.id}
              projectId={projectId}
              documentId={activeTab.id}
              socket={socket}
              readOnly={!canEdit}
              theme={theme}
              registry={registry}
              host={host}
              autoCompile={autoCompile}
              self={self}
              follow={following?.userId ?? null}
              onKeystroke={() => {
                if (following) onStopFollowing()
              }}
              onCompile={onCompile}
              onReady={onEditorReady}
              onSyncState={onSyncState}
            />
          ) : null}
          {file ? <FilePreview key={file.id} projectId={projectId} file={file} /> : null}
          {loading ? (
            <p className="flex items-center gap-2 p-6 text-sm text-editor-gutter-foreground">
              <Spinner label="" /> Chargement du projet…
            </p>
          ) : activeTab === null ? (
            <p className="p-6 text-sm text-editor-gutter-foreground">
              Choisissez un fichier dans l'arborescence.
            </p>
          ) : null}
        </div>
        {reviewOpen ? (
          <ReviewPanel
            onClose={() => {
              setReviewOpen(false)
            }}
          />
        ) : null}
      </div>
      <AskSlot />
      <HistoryDrawer open={historyOpen} onOpenChange={setHistoryOpen} />
    </section>
  )
}
