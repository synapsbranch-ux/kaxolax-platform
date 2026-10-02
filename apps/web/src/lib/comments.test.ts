import type { ResolvedAnchor } from '@kaxolax/collab'
import { COMMENT_QUOTE_MAX_LENGTH, type CommentThread } from '@kaxolax/contracts'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, type ProjectTree } from './api'
import {
  adjacentThread,
  anchorNotice,
  canChangeComment,
  commentErrorMessage,
  filterThreads,
  mentionsToText,
  orderThreads,
  quoteOf,
  threadCounts,
  threadFromSearch,
  threadsInTree,
  upsertThread,
} from './comments'
import { commentFeed, eventEffect } from './project-events'

const MAIN = '00000000-0000-4000-8000-00000000000a'
const ANNEX = '00000000-0000-4000-8000-00000000000b'
const SELF = '00000000-0000-4000-8000-0000000000aa'

function thread(
  id: string,
  documentId: string,
  createdAt: string,
  resolved = false,
): CommentThread {
  return {
    id,
    documentId,
    anchor: 'AQ==',
    quotedText: id,
    createdAt,
    resolvedAt: resolved ? createdAt : null,
    resolvedBy: resolved ? { id: SELF, fullName: null, avatarUrl: null } : null,
    comments: [
      {
        id: `${id}-c`,
        author: { id: SELF, fullName: 'Ada', avatarUrl: null },
        body: 'texte',
        createdAt,
        editedAt: null,
        deletedAt: null,
      },
    ],
  }
}

const tree: ProjectTree = {
  mainDocumentId: MAIN,
  folders: [],
  files: [],
  documents: [
    { id: MAIN, folderId: null, name: 'main.tex', path: 'main.tex' },
    { id: ANNEX, folderId: null, name: 'annexe.tex', path: 'annexe.tex' },
  ],
}

describe('review panel logic', () => {
  const a = thread('a', MAIN, '2026-10-01T10:00:00.000Z')
  const b = thread('b', MAIN, '2026-10-01T11:00:00.000Z')
  const c = thread('c', ANNEX, '2026-10-01T09:00:00.000Z')
  const d = thread('d', MAIN, '2026-10-01T08:00:00.000Z', true)
  const e = thread('e', MAIN, '2026-10-01T07:00:00.000Z')

  it('splits open and resolved threads', () => {
    expect(filterThreads([a, d], 'open')).toEqual([a])
    expect(filterThreads([a, d], 'resolved')).toEqual([d])
    expect(threadCounts([a, b, d])).toEqual({ open: 2, resolved: 1 })
  })

  it('orders the active document by text position, then other documents', () => {
    const positions = new Map<string, ResolvedAnchor>([
      ['a', { status: 'attached', from: 40, to: 45 }],
      ['b', { status: 'detached', at: 10 }],
      ['e', { status: 'unknown' }],
    ])
    const ordered = orderThreads([a, b, c, e], { tree, activeDocumentId: MAIN, positions })
    expect(ordered.map((entry) => entry.id)).toEqual(['b', 'a', 'e', 'c'])
    // Autre document actif : ses fils d'abord, puis les autres par chemin et par date.
    const other = orderThreads([a, b, c, e], { tree, activeDocumentId: ANNEX, positions })
    expect(other.map((entry) => entry.id)).toEqual(['c', 'e', 'a', 'b'])
  })

  it('navigates to the next and previous thread, wrapping around', () => {
    const list = [a, b, c]
    expect(adjacentThread(list, null, 1)).toBe('a')
    expect(adjacentThread(list, null, -1)).toBe('c')
    expect(adjacentThread(list, 'a', 1)).toBe('b')
    expect(adjacentThread(list, 'c', 1)).toBe('a')
    expect(adjacentThread(list, 'a', -1)).toBe('c')
    expect(adjacentThread(list, 'gone', 1)).toBe('a')
    expect(adjacentThread([], null, 1)).toBeNull()
  })

  it('merges a reread thread and removes a deleted one', () => {
    const changed = { ...a, quotedText: 'nouveau' }
    expect(upsertThread([a, b], 'a', changed)).toEqual([changed, b])
    expect(upsertThread([a], 'b', b)).toEqual([a, b])
    expect(upsertThread([a, b], 'a', null)).toEqual([b])
  })

  it('lets only the author with a commenting role change a comment', () => {
    const [comment] = a.comments
    if (!comment) throw new Error('comment expected')
    expect(canChangeComment(comment, SELF, true)).toBe(true)
    expect(canChangeComment(comment, SELF, false)).toBe(false)
    expect(canChangeComment(comment, 'autre', true)).toBe(false)
    expect(canChangeComment({ ...comment, deletedAt: comment.createdAt }, SELF, true)).toBe(false)
  })

  it('bounds the quote and describes a missing anchored text', () => {
    expect(quoteOf('court')).toBe('court')
    const long = quoteOf('x'.repeat(COMMENT_QUOTE_MAX_LENGTH + 10))
    expect(long).toHaveLength(COMMENT_QUOTE_MAX_LENGTH)
    expect(long.endsWith('…')).toBe(true)
    expect(anchorNotice({ status: 'attached', from: 0, to: 1 })).toBeNull()
    expect(anchorNotice(undefined)).toBeNull()
    expect(anchorNotice({ status: 'detached', at: 3 })).toBe('Texte commenté supprimé')
  })

  it('turns stored mentions back into editable names, and back again', async () => {
    const { encodeMentions } = await import('./chat')
    const members = [{ id: SELF, name: 'Ada', avatarUrl: null, color: '#000' }]
    const gone = '00000000-0000-4000-8000-0000000000bb'
    const body = `Relis <@${SELF}> et <@${gone}>`
    const { text, picked } = mentionsToText(body, members)
    expect(text).toBe(`Relis @Ada et <@${gone}>`)
    expect(encodeMentions(text, picked, members)).toBe(body)
  })

  it('reads the thread to open from the mention email link', () => {
    expect(threadFromSearch(`?comment=${MAIN.toUpperCase()}`)).toBe(MAIN)
    expect(threadFromSearch('?comment=xyz')).toBeNull()
    expect(threadFromSearch('')).toBeNull()
  })

  it('routes comment events to the comment feed', () => {
    const event = {
      type: 'comment.thread-updated' as const,
      threadId: MAIN,
      documentId: ANNEX,
      change: 'resolved' as const,
      actorId: SELF,
    }
    const effect = eventEffect(event, SELF)
    expect(effect).toEqual({ kind: 'comment', event })
    const listener = vi.fn()
    const unsubscribe = commentFeed.subscribe(listener)
    commentFeed.publish(event)
    unsubscribe()
    commentFeed.publish(event)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('threads of deleted documents and errors', () => {
  it('hides the threads of a document no longer in the tree', () => {
    const threads = [
      thread('a', MAIN, '2026-10-01T10:00:00Z'),
      thread('b', '00000000-0000-4000-8000-0000000000ff', '2026-10-01T10:00:00Z'),
    ]
    expect(threadsInTree(threads, tree).map((entry) => entry.id)).toEqual(['a'])
    expect(threadsInTree(threads, null)).toHaveLength(2)
  })

  it('shows API errors in French', () => {
    expect(
      commentErrorMessage(
        new ApiError(403, 'E_COMMENT_NOT_AUTHOR', 'Only the author can change this comment'),
      ),
    ).toBe('Seul l’auteur peut modifier ou supprimer ce message.')
    expect(commentErrorMessage(new ApiError(500, 'E_UNKNOWN', 'Boom'))).toBe(
      'Une erreur est survenue. Réessayez dans un instant.',
    )
  })
})
