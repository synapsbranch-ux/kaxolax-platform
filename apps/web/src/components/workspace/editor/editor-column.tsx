'use client'

import type { HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import type { ResolvedAnchor } from '@kaxolax/collab'
import type { PresenceUser, Theme } from '@kaxolax/contracts'
import { Button, SimpleTooltip, Spinner, cn } from '@kaxolax/ui'
import { EyeIcon, HistoryIcon, MessageSquareTextIcon, WrenchIcon } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { api, type ProjectTree, type TreeFile } from '@/lib/api'
import { type ChatMember, chatMembers } from '@/lib/chat'
import { commentErrorMessage, threadFromSearch } from '@/lib/comments'
import { AskSlot } from './ask-slot'
import { CodeEditor, type EditorHandle, type SyncState } from './code-editor'
import { EditorTabs, type OpenTab } from './editor-tabs'
import { FilePreview } from './file-preview'
import { HistoryDrawer } from '../panels/history-drawer'
import { type CommentDraft, ReviewPanel } from '../panels/review-panel'
import { useProjectComments } from '../use-project-comments'
import { useEditorActions } from '../workspace-actions'
import { ToolsBar } from './tools-bar'

const SYNC_LABELS: Record<SyncState, string> = {
  connecting: 'Connexion…',
  synced: 'Enregistré',
  saving: 'Enregistrement…',
  offline: 'Hors ligne, reconnexion…',
  closed: 'Document fermé',
}

const NO_POSITIONS: ReadonlyMap<string, ResolvedAnchor> = new Map()

/**
 * Colonne centrale : onglets des fichiers ouverts, boutons Review et Historique (emplacement de
 * la tâche 8), bouton Tools et sa barre d'outils, éditeur CodeMirror (ou aperçu d'un fichier
 * binaire), panneau Review (commentaires ancrés) et zone réservée à l'assistant.
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
  canComment,
  selfId,
  membersVersion,
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
  onAutoCompile,
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
  /** Rôle qui commente (owner, editor, reviewer) ; le lecteur lit les commentaires. */
  canComment: boolean
  selfId: string | null
  /** Incrémenté à chaque événement de membre : les membres à mentionner sont relus. */
  membersVersion: number
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
  /** Auto-compilation (pause de frappe) : sans version dans l'historique. */
  onAutoCompile: () => void
  onEditorReady: (handle: EditorHandle | null) => void
  onSyncState: (state: SyncState) => void
}) {
  const { registry, host } = useEditorActions()
  const [reviewOpen, setReviewOpen] = useState(false)
  const [historyOpen, setHistoryOpen] = useState(false)
  const review = useReview({
    projectId,
    activeDocumentId: activeTab?.kind === 'document' ? activeTab.id : null,
    reviewOpen,
    membersVersion,
    onOpenReview: () => {
      setReviewOpen(true)
    },
    onActivate,
    tree,
  })
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
              onAutoCompile={onAutoCompile}
              onReady={(handle) => {
                review.attachEditor(handle)
                onEditorReady(handle)
              }}
              onSyncState={onSyncState}
              comments={review.documentThreads}
              activeCommentId={review.selectedId}
              revealComment={review.reveal}
              onCommentPositions={review.setPositions}
              onCommentSelect={review.selectFromEditor}
              onCommentShortcut={canComment ? review.startDraft : undefined}
              onCommentRevealed={review.revealed}
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
            tree={tree}
            threads={review.comments.threads}
            status={review.comments.status}
            error={review.comments.error}
            onRetry={review.comments.retry}
            positions={review.positions}
            activeDocumentId={activeTab?.kind === 'document' ? activeTab.id : null}
            selectedId={review.selectedId}
            onSelect={review.select}
            canComment={canComment}
            selfId={selfId}
            members={review.members}
            draft={review.draft}
            notice={review.notice}
            onStartDraft={review.startDraft}
            onCancelDraft={review.cancelDraft}
            onCreate={review.create}
            onReply={review.comments.reply}
            onEdit={review.comments.edit}
            onDelete={review.remove}
            onResolve={review.resolve}
            onClose={() => {
              setReviewOpen(false)
            }}
          />
        ) : null}
      </div>
      <AskSlot />
      <HistoryDrawer
        projectId={projectId}
        open={historyOpen}
        canEdit={canEdit}
        onOpenChange={setHistoryOpen}
      />
    </section>
  )
}

/**
 * État du panneau Review partagé avec l'éditeur : fils du projet, fil sélectionné et saut vers
 * son texte (ouverture du document au besoin), brouillon d'un nouveau fil sur la sélection,
 * positions des fils dans le document actif, membres à mentionner.
 */
function useReview({
  projectId,
  activeDocumentId,
  reviewOpen,
  membersVersion,
  onOpenReview,
  onActivate,
  tree,
}: {
  projectId: string
  activeDocumentId: string | null
  reviewOpen: boolean
  membersVersion: number
  onOpenReview: () => void
  onActivate: (id: string) => void
  tree: ProjectTree | null
}) {
  const comments = useProjectComments(projectId, tree)
  const editor = useRef<EditorHandle | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [reveal, setReveal] = useState<{ threadId: string; serial: number } | null>(null)
  const revealSerial = useRef(0)
  const [draft, setDraft] = useState<CommentDraft | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [positionState, setPositionState] = useState<{
    documentId: string | null
    positions: ReadonlyMap<string, ResolvedAnchor>
  }>({ documentId: null, positions: NO_POSITIONS })
  const [members, setMembers] = useState<ChatMember[]>([])

  const documentThreads = useMemo(
    () => comments.threads.filter((thread) => thread.documentId === activeDocumentId),
    [comments.threads, activeDocumentId],
  )
  // Positions remontées par l'éditeur du document actif (celles d'un document refermé sont ignorées).
  const positions =
    positionState.documentId === activeDocumentId ? positionState.positions : NO_POSITIONS
  const setPositions = useCallback(
    (next: ReadonlyMap<string, ResolvedAnchor>) => {
      setPositionState({ documentId: activeDocumentId, positions: next })
    },
    [activeDocumentId],
  )

  // Membres à mentionner : lus à l'ouverture du panneau et après chaque événement de membre.
  useEffect(() => {
    if (!reviewOpen) return
    const state = { active: true }
    api.members(projectId).then(
      ({ members: loaded }) => {
        if (state.active) setMembers(chatMembers(loaded))
      },
      () => undefined,
    )
    return () => {
      state.active = false
    }
  }, [projectId, reviewOpen, membersVersion])

  // Message court du panneau, effacé après quelques secondes.
  useEffect(() => {
    if (notice === null) return
    const timer = setTimeout(() => {
      setNotice(null)
    }, 5_000)
    return () => {
      clearTimeout(timer)
    }
  }, [notice])

  /** Sélectionne un fil et saute à son texte (le document est ouvert s'il ne l'est pas). */
  const select = useCallback(
    (threadId: string) => {
      const thread = comments.threads.find((candidate) => candidate.id === threadId)
      if (!thread) return
      setSelectedId(threadId)
      revealSerial.current += 1
      setReveal({ threadId, serial: revealSerial.current })
      if (thread.documentId !== activeDocumentId) onActivate(thread.documentId)
    },
    [comments.threads, activeDocumentId, onActivate],
  )

  // Clic dans un texte commenté : le panneau s'ouvre sur son fil, sans déplacer le curseur.
  const selectFromEditor = useCallback(
    (threadId: string) => {
      setSelectedId(threadId)
      onOpenReview()
    },
    [onOpenReview],
  )

  // Lien de l'email de mention (`?comment=<id>`) : le fil s'ouvre une fois les fils chargés.
  const linked = useRef<string | null | undefined>(undefined)
  useEffect(() => {
    linked.current ??= threadFromSearch(window.location.search)
    const threadId = linked.current
    if (threadId === null || comments.status !== 'ready') return
    linked.current = null
    if (comments.threads.some((thread) => thread.id === threadId)) {
      onOpenReview()
      select(threadId)
    }
  }, [comments.status, comments.threads, onOpenReview, select])

  const startDraft = useCallback(() => {
    onOpenReview()
    const handle = editor.current
    const selection = handle?.commentDraft() ?? null
    if (handle === null || selection === null) {
      setNotice('Sélectionnez du texte dans l’éditeur pour le commenter.')
      return
    }
    setNotice(null)
    setDraft({ documentId: handle.documentId, ...selection })
  }, [onOpenReview])

  const create = useCallback(
    async (body: string) => {
      if (draft === null) return
      const thread = await comments.create({ ...draft, body })
      setDraft(null)
      setSelectedId(thread.id)
    },
    [draft, comments],
  )

  const report = useCallback(async (action: Promise<void>) => {
    try {
      await action
    } catch (caught) {
      setNotice(commentErrorMessage(caught))
    }
  }, [])

  return {
    comments,
    /** Éditeur courant (brouillon d'un fil sur sa sélection). */
    attachEditor: (handle: EditorHandle | null) => {
      editor.current = handle
    },
    selectedId,
    reveal,
    draft,
    notice,
    members,
    documentThreads,
    positions,
    setPositions,
    select,
    selectFromEditor,
    startDraft,
    cancelDraft: () => {
      setDraft(null)
    },
    /** Saut effectué : il ne se rejoue pas au retour sur le document. */
    revealed: () => {
      setReveal(null)
    },
    create,
    remove: (threadId: string, commentId: string) => report(comments.remove(threadId, commentId)),
    resolve: (threadId: string, resolved: boolean) =>
      report(comments.setResolved(threadId, resolved)),
  }
}
