'use client'

import type { ResolvedAnchor } from '@kaxolax/collab'
import type { Comment, CommentThread } from '@kaxolax/contracts'
import {
  Avatar,
  AvatarFallback,
  AvatarImage,
  Button,
  cn,
  initialsOf,
  SimpleTooltip,
  Spinner,
  Tabs,
  TabsList,
  TabsTrigger,
} from '@kaxolax/ui'
import {
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  MessageSquarePlusIcon,
  MessageSquareTextIcon,
  PencilIcon,
  RotateCcwIcon,
  Trash2Icon,
  XIcon,
} from 'lucide-react'
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectTree } from '@/lib/api'
import { type ChatMember, chatMember, displaySegments } from '@/lib/chat'
import {
  adjacentThread,
  anchorNotice,
  canChangeComment,
  filterThreads,
  mentionsToText,
  orderThreads,
  type ReviewFilter,
  threadCounts,
} from '@/lib/comments'
import { CommentComposer } from './comment-composer'

/** Section du panneau : commentaires ou suggestions (suivi des modifications). */
export type ReviewSection = 'comments' | 'suggestions'

/** Brouillon d'un nouveau fil : sélection ancrée dans le document actif. */
export interface CommentDraft {
  documentId: string
  anchor: string
  quotedText: string
}

function dateLabel(iso: string): string {
  return new Date(iso).toLocaleString('fr-FR', {
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  })
}

/**
 * Panneau Review, à droite de l'éditeur, en deux sections : Commentaires et Suggestions (suivi
 * des modifications, `suggestions-section.tsx`, fourni par `suggestions`).
 *
 * Commentaires : fils de commentaires du projet, ouverts ou résolus,
 * dans l'ordre du texte du document actif puis par document. Un clic sur un fil (ou la navigation
 * au suivant, au précédent) saute au texte commenté dans l'éditeur. Les rôles qui commentent
 * (owner, editor, reviewer) ouvrent un fil sur la sélection, répondent, résolvent et rouvrent ;
 * chacun modifie ou supprime ses propres messages. Le lecteur lit seulement.
 */
export function ReviewPanel({
  tree,
  threads,
  status,
  error,
  onRetry,
  positions,
  activeDocumentId,
  selectedId,
  onSelect,
  canComment,
  selfId,
  members,
  draft,
  notice,
  onStartDraft,
  onCancelDraft,
  onCreate,
  onReply,
  onEdit,
  onDelete,
  onResolve,
  onClose,
  section,
  onSectionChange,
  suggestionCount,
  suggestions,
}: {
  tree: ProjectTree | null
  threads: readonly CommentThread[]
  status: 'loading' | 'ready' | 'error'
  error: string | null
  onRetry: () => void
  /** Positions des fils du document actif (résolues dans l'éditeur). */
  positions: ReadonlyMap<string, ResolvedAnchor>
  activeDocumentId: string | null
  selectedId: string | null
  /** Sélectionne un fil et saute à son texte dans l'éditeur. */
  onSelect: (threadId: string) => void
  canComment: boolean
  selfId: string | null
  members: readonly ChatMember[]
  draft: CommentDraft | null
  /** Message court : brouillon impossible (pas de sélection), échec d'une action. */
  notice: string | null
  onStartDraft: () => void
  onCancelDraft: () => void
  onCreate: (body: string) => Promise<void>
  onReply: (threadId: string, body: string) => Promise<void>
  onEdit: (threadId: string, commentId: string, body: string) => Promise<void>
  onDelete: (threadId: string, commentId: string) => Promise<void>
  onResolve: (threadId: string, resolved: boolean) => Promise<void>
  onClose: () => void
  section: ReviewSection
  onSectionChange: (section: ReviewSection) => void
  /** Suggestions ouvertes du projet (onglet de la section). */
  suggestionCount: number
  /** Contenu de la section Suggestions. */
  suggestions: ReactNode
}) {
  const [filter, setFilter] = useState<ReviewFilter>('open')
  // Fil sélectionné de l'autre onglet (lien d'email, clic dans l'éditeur) : l'onglet suit.
  const [followedSelection, setFollowedSelection] = useState(selectedId)
  if (followedSelection !== selectedId) {
    setFollowedSelection(selectedId)
    const selected = threads.find((thread) => thread.id === selectedId)
    if (selected) setFilter(selected.resolvedAt === null ? 'open' : 'resolved')
  }

  const counts = threadCounts(threads)
  const ordered = useMemo(
    () => orderThreads(filterThreads(threads, filter), { tree, activeDocumentId, positions }),
    [threads, filter, tree, activeDocumentId, positions],
  )
  const memberMap = useMemo(() => new Map(members.map((member) => [member.id, member])), [members])

  // Le fil sélectionné reste visible dans la liste.
  const list = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    if (selectedId === null) return
    list.current
      ?.querySelector(`[data-thread-id="${selectedId}"]`)
      ?.scrollIntoView({ block: 'nearest' })
  }, [selectedId, filter])

  const navigate = (direction: 1 | -1) => {
    const next = adjacentThread(ordered, selectedId, direction)
    if (next !== null) onSelect(next)
  }

  return (
    <aside
      aria-label="Review"
      className="flex w-80 shrink-0 flex-col border-l border-editor-border bg-editor-toolbar text-editor-toolbar-foreground"
      data-testid="review-panel"
    >
      <div className="flex h-tab shrink-0 items-center gap-1 border-b border-editor-border px-3 text-sm font-medium">
        <span className="mr-auto">Review</span>
        {section === 'comments' ? (
          <>
            <SimpleTooltip label="Commentaire précédent">
              <Button
                variant="ghost"
                size="icon-xs"
                className="hover:bg-editor-tab-active"
                aria-label="Commentaire précédent"
                disabled={ordered.length === 0}
                onClick={() => {
                  navigate(-1)
                }}
                data-testid="review-previous"
              >
                <ChevronUpIcon />
              </Button>
            </SimpleTooltip>
            <SimpleTooltip label="Commentaire suivant">
              <Button
                variant="ghost"
                size="icon-xs"
                className="hover:bg-editor-tab-active"
                aria-label="Commentaire suivant"
                disabled={ordered.length === 0}
                onClick={() => {
                  navigate(1)
                }}
                data-testid="review-next"
              >
                <ChevronDownIcon />
              </Button>
            </SimpleTooltip>
          </>
        ) : null}
        <Button
          variant="ghost"
          size="icon-xs"
          className="hover:bg-editor-tab-active"
          aria-label="Fermer le panneau Review"
          onClick={onClose}
        >
          <XIcon />
        </Button>
      </div>

      <div className="shrink-0 border-b border-editor-border px-3 py-2">
        <Tabs
          value={section}
          onValueChange={(value) => {
            onSectionChange(value === 'suggestions' ? 'suggestions' : 'comments')
          }}
        >
          <TabsList className="w-full">
            <TabsTrigger value="comments" data-testid="review-comments-tab">
              Commentaires ({counts.open})
            </TabsTrigger>
            <TabsTrigger value="suggestions" data-testid="review-suggestions-tab">
              Suggestions ({suggestionCount})
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {section === 'suggestions' ? (
        suggestions
      ) : (
        <>
          <div className="flex shrink-0 items-center gap-2 border-b border-editor-border px-3 py-2">
            <Tabs
              value={filter}
              onValueChange={(value) => {
                setFilter(value === 'resolved' ? 'resolved' : 'open')
              }}
            >
              <TabsList>
                <TabsTrigger value="open" data-testid="review-open-tab">
                  Ouverts ({counts.open})
                </TabsTrigger>
                <TabsTrigger value="resolved" data-testid="review-resolved-tab">
                  Résolus ({counts.resolved})
                </TabsTrigger>
              </TabsList>
            </Tabs>
            {canComment ? (
              <SimpleTooltip label="Commenter la sélection (Ctrl+Alt+M)">
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="ml-auto hover:bg-editor-tab-active"
                  aria-label="Commenter la sélection"
                  disabled={activeDocumentId === null || draft !== null}
                  onClick={onStartDraft}
                  data-testid="comment-selection"
                >
                  <MessageSquarePlusIcon />
                </Button>
              </SimpleTooltip>
            ) : null}
          </div>

          {notice !== null ? (
            <p className="shrink-0 px-3 pt-2 text-xs text-editor-gutter-foreground" role="status">
              {notice}
            </p>
          ) : null}

          {draft !== null ? (
            <div className="shrink-0 border-b border-editor-border p-3" data-testid="comment-draft">
              <Quote text={draft.quotedText} />
              <CommentComposer
                selfId={selfId}
                members={members}
                placeholder="Votre commentaire… (@ pour mentionner)"
                submitLabel="Commenter"
                autoFocus
                onSubmit={onCreate}
                onCancel={onCancelDraft}
              />
            </div>
          ) : null}

          <div ref={list} className="min-h-0 flex-1 overflow-y-auto p-2">
            {status === 'loading' ? (
              <p className="flex items-center justify-center gap-2 p-6 text-sm text-editor-gutter-foreground">
                <Spinner label="" /> Chargement des commentaires…
              </p>
            ) : status === 'error' ? (
              <div className="flex flex-col items-center gap-2 p-6 text-center text-sm">
                <p role="alert" className="text-destructive">
                  {error ?? 'Impossible de charger les commentaires.'}
                </p>
                <Button variant="outline" size="xs" onClick={onRetry}>
                  Réessayer
                </Button>
              </div>
            ) : ordered.length === 0 ? (
              <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-editor-gutter-foreground">
                <MessageSquareTextIcon className="size-6" />
                <p className="text-sm">
                  {filter === 'open'
                    ? canComment
                      ? 'Aucun commentaire ouvert. Sélectionnez du texte, puis commentez-le.'
                      : 'Aucun commentaire ouvert.'
                    : 'Aucun commentaire résolu.'}
                </p>
              </div>
            ) : (
              <ul className="flex flex-col gap-2">
                {ordered.map((thread) => (
                  <ThreadCard
                    key={thread.id}
                    thread={thread}
                    documentName={
                      thread.documentId === activeDocumentId
                        ? null
                        : (tree?.documents.find((document) => document.id === thread.documentId)
                            ?.path ?? 'Document')
                    }
                    position={
                      thread.documentId === activeDocumentId ? positions.get(thread.id) : undefined
                    }
                    selected={thread.id === selectedId}
                    tree={tree}
                    members={members}
                    memberMap={memberMap}
                    selfId={selfId}
                    canComment={canComment}
                    onSelect={() => {
                      onSelect(thread.id)
                    }}
                    onReply={(body) => onReply(thread.id, body)}
                    onEdit={(commentId, body) => onEdit(thread.id, commentId, body)}
                    onDelete={(commentId) => onDelete(thread.id, commentId)}
                    onResolve={(resolved) => onResolve(thread.id, resolved)}
                  />
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </aside>
  )
}

function Quote({ text, struck = false }: { text: string; struck?: boolean }) {
  return (
    <blockquote
      className={cn(
        'mb-2 line-clamp-3 border-l-2 border-yellow-500/70 pl-2 font-mono text-xs whitespace-pre-wrap text-editor-gutter-foreground',
        struck && 'line-through',
      )}
    >
      {text}
    </blockquote>
  )
}

function ThreadCard({
  thread,
  documentName,
  position,
  selected,
  tree,
  members,
  memberMap,
  selfId,
  canComment,
  onSelect,
  onReply,
  onEdit,
  onDelete,
  onResolve,
}: {
  thread: CommentThread
  /** Chemin du document s'il n'est pas le document actif. */
  documentName: string | null
  position: ResolvedAnchor | undefined
  selected: boolean
  tree: ProjectTree | null
  members: readonly ChatMember[]
  memberMap: ReadonlyMap<string, ChatMember>
  selfId: string | null
  canComment: boolean
  onSelect: () => void
  onReply: (body: string) => Promise<void>
  onEdit: (commentId: string, body: string) => Promise<void>
  onDelete: (commentId: string) => Promise<void>
  onResolve: (resolved: boolean) => Promise<void>
}) {
  const [busy, setBusy] = useState(false)
  const notice = anchorNotice(position)
  const resolved = thread.resolvedAt !== null
  return (
    <li
      data-thread-id={thread.id}
      data-testid="comment-thread"
      className={cn(
        'cursor-pointer rounded-md border border-editor-border bg-editor p-2 text-sm',
        selected && 'ring-2 ring-yellow-500/70',
      )}
      onClick={onSelect}
    >
      {documentName !== null ? (
        <p className="mb-1 truncate text-xs text-editor-gutter-foreground">{documentName}</p>
      ) : null}
      <Quote text={thread.quotedText} struck={position?.status === 'detached'} />
      {notice !== null ? (
        <p
          className="mb-2 text-xs text-editor-gutter-foreground italic"
          data-testid="anchor-notice"
        >
          {notice}
        </p>
      ) : null}
      <ol className="flex flex-col gap-2">
        {thread.comments.map((comment) => (
          <CommentItem
            key={comment.id}
            comment={comment}
            tree={tree}
            members={members}
            memberMap={memberMap}
            selfId={selfId}
            canChange={canChangeComment(comment, selfId, canComment)}
            onEdit={(body) => onEdit(comment.id, body)}
            onDelete={() => onDelete(comment.id)}
          />
        ))}
      </ol>
      {resolved && thread.resolvedBy !== null ? (
        <p className="mt-2 text-xs text-editor-gutter-foreground">
          Résolu par{' '}
          {
            chatMember(
              thread.resolvedBy.id,
              thread.resolvedBy.fullName,
              thread.resolvedBy.avatarUrl,
            ).name
          }
          {thread.resolvedAt !== null ? `, ${dateLabel(thread.resolvedAt)}` : ''}
        </p>
      ) : null}
      {canComment ? (
        <div className="mt-2 flex flex-col gap-2">
          {selected ? (
            <CommentComposer
              key={`reply-${thread.id}`}
              selfId={selfId}
              members={members}
              placeholder="Répondre… (@ pour mentionner)"
              submitLabel="Répondre"
              onSubmit={onReply}
            />
          ) : null}
          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="xs"
              className="hover:bg-editor-tab-active"
              disabled={busy}
              onClick={(event) => {
                event.stopPropagation()
                setBusy(true)
                void onResolve(!resolved).finally(() => {
                  setBusy(false)
                })
              }}
              data-testid={resolved ? 'comment-reopen' : 'comment-resolve'}
            >
              {resolved ? <RotateCcwIcon /> : <CheckIcon />}
              {resolved ? 'Rouvrir' : 'Résoudre'}
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  )
}

function CommentItem({
  comment,
  tree,
  members,
  memberMap,
  selfId,
  canChange,
  onEdit,
  onDelete,
}: {
  comment: Comment
  tree: ProjectTree | null
  members: readonly ChatMember[]
  memberMap: ReadonlyMap<string, ChatMember>
  selfId: string | null
  canChange: boolean
  onEdit: (body: string) => Promise<void>
  onDelete: () => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const author = chatMember(comment.author.id, comment.author.fullName, comment.author.avatarUrl)
  return (
    <li className="flex gap-2" data-testid="comment">
      <Avatar size="sm" className="mt-0.5">
        {author.avatarUrl ? <AvatarImage src={author.avatarUrl} alt="" /> : null}
        <AvatarFallback
          style={{ backgroundColor: author.color }}
          className="text-[10px] text-white"
        >
          {initialsOf(author.name)}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0 flex-1">
        <p className="flex items-baseline gap-1 text-xs">
          <span className="truncate font-medium">{author.name}</span>
          <span className="shrink-0 text-editor-gutter-foreground">
            {dateLabel(comment.createdAt)}
            {comment.editedAt !== null && comment.deletedAt === null ? ' (modifié)' : ''}
          </span>
          {canChange && !editing ? (
            <span className="ml-auto flex shrink-0 gap-0.5">
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-5 hover:bg-editor-tab-active"
                aria-label="Modifier le commentaire"
                onClick={(event) => {
                  event.stopPropagation()
                  setEditing(true)
                }}
              >
                <PencilIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon-xs"
                className="size-5 hover:bg-editor-tab-active"
                aria-label="Supprimer le commentaire"
                onClick={(event) => {
                  event.stopPropagation()
                  setConfirming(true)
                }}
              >
                <Trash2Icon />
              </Button>
            </span>
          ) : null}
        </p>
        {comment.body === null ? (
          <p className="text-xs text-editor-gutter-foreground italic">Message supprimé</p>
        ) : editing ? (
          <CommentComposer
            selfId={selfId}
            members={members}
            initial={mentionsToText(comment.body, members)}
            placeholder="Modifier le commentaire"
            submitLabel="Enregistrer"
            autoFocus
            onSubmit={async (body) => {
              await onEdit(body)
              setEditing(false)
            }}
            onCancel={() => {
              setEditing(false)
            }}
          />
        ) : (
          <p className="text-sm break-words whitespace-pre-wrap">
            {displaySegments(comment.body, tree, memberMap).map((segment, index) =>
              segment.kind === 'mention' ? (
                <span
                  key={index}
                  className={cn(
                    'rounded px-0.5 font-medium',
                    segment.userId === selfId ? 'bg-yellow-500/30' : 'bg-editor-tab-active',
                  )}
                >
                  @{segment.member?.name ?? 'ancien membre'}
                </span>
              ) : (
                <span key={index}>{segment.text}</span>
              ),
            )}
          </p>
        )}
        {confirming ? (
          <div
            className="mt-1 flex items-center gap-1 text-xs"
            role="alertdialog"
            aria-label="Confirmer la suppression"
            onClick={(event) => {
              event.stopPropagation()
            }}
          >
            <span className="mr-auto">Supprimer ce message ?</span>
            <Button
              variant="ghost"
              size="xs"
              className="hover:bg-editor-tab-active"
              onClick={() => {
                setConfirming(false)
              }}
            >
              Annuler
            </Button>
            <Button
              variant="destructive"
              size="xs"
              onClick={() => {
                setConfirming(false)
                void onDelete()
              }}
              data-testid="comment-delete-confirm"
            >
              Supprimer
            </Button>
          </div>
        ) : null}
      </div>
    </li>
  )
}
