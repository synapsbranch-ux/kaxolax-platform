'use client'

import { HocuspocusProvider, type HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import type { CommentThread, PresenceUser, Theme } from '@kaxolax/contracts'
import {
  anchorFromBase64,
  anchorToBase64,
  createCommentAnchor,
  documentName,
  type ResolvedAnchor,
  resolveCommentAnchor,
  TEXT_FIELD,
} from '@kaxolax/collab'
import {
  type ActionHost,
  type ActionRegistry,
  collaboratorCursorTheme,
  commentableSelection,
  commentHighlights,
  type CommentRange,
  goToLine,
  isActionTransaction,
  isLocalEdit,
  keystrokeListener,
  latexExtensions,
  reconfigureEditor,
  revealComment as revealCommentRange,
  revealPosition,
  setActiveComment,
  setCommentRanges,
} from '@kaxolax/editor'
import { Spinner } from '@kaxolax/ui'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { useEffect, useRef, useState } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { api } from '@/lib/api'
import { quoteOf } from '@/lib/comments'
import { cursorIndexOf } from '@/lib/presence'

const NO_COMMENTS: readonly CommentThread[] = []

/** Délai de regroupement des positions des commentaires remontées au panneau Review. */
const COMMENT_POSITIONS_DELAY_MS = 200

/** Positions des fils dans le document : tous les fils, résolus compris (ordre du panneau). */
function resolveThreads(
  ytext: Y.Text,
  threads: readonly CommentThread[],
): { positions: Map<string, ResolvedAnchor>; ranges: CommentRange[] } {
  const positions = new Map<string, ResolvedAnchor>()
  const ranges: CommentRange[] = []
  for (const thread of threads) {
    const bytes = anchorFromBase64(thread.anchor)
    const position: ResolvedAnchor =
      bytes === null ? { status: 'unknown' } : resolveCommentAnchor(ytext, bytes)
    positions.set(thread.id, position)
    // Seuls les fils ouverts sont surlignés.
    if (thread.resolvedAt === null && position.status === 'attached')
      ranges.push({ id: thread.id, from: position.from, to: position.to })
  }
  return { positions, ranges }
}

function samePositions(
  a: ReadonlyMap<string, ResolvedAnchor>,
  b: ReadonlyMap<string, ResolvedAnchor>,
): boolean {
  if (a.size !== b.size) return false
  for (const [id, position] of a) {
    if (JSON.stringify(position) !== JSON.stringify(b.get(id))) return false
  }
  return true
}

/** Commandes de l'éditeur utilisées par la page (logs, SyncTeX, compilation, barre Tools). */
export interface EditorHandle {
  /** Document édité : une poignée d'un autre document (changement d'onglet en cours) est ignorée. */
  documentId: string
  view: EditorView
  goToLine: (line: number) => void
  /**
   * Sélectionne `length` caractères à partir de `column` (unités UTF-16, 0 = début) sur la ligne
   * `line` (1 = première), puis fait défiler jusqu'à la sélection (résultat de recherche).
   */
  select: (line: number, column: number, length: number) => void
  /** Prévient après chaque modification du texte ou déplacement du curseur (plan du document). */
  subscribe: (listener: () => void) => () => void
  /** Ligne du curseur (1 = première). */
  cursorLine: () => number
  /** Attend que les dernières frappes soient arrivées au serveur (avant une compilation). */
  flush: () => Promise<void>
  /** Annuler et rétablir (historique partagé de Yjs, limité aux modifications locales). */
  undo: () => void
  redo: () => void
  /**
   * Ancre (positions relatives Yjs en base64) et citation de la sélection, pour un nouveau
   * commentaire ; null sans sélection.
   */
  commentDraft: () => { anchor: string; quotedText: string } | null
}

export type SyncState = 'connecting' | 'synced' | 'saving' | 'offline' | 'closed'

export function CodeEditor({
  projectId,
  documentId,
  socket,
  readOnly,
  theme,
  registry,
  host,
  autoCompile,
  self,
  follow,
  onKeystroke,
  onCompile,
  onAutoCompile,
  onReady,
  onSyncState,
  comments = NO_COMMENTS,
  activeCommentId = null,
  revealComment = null,
  onCommentPositions,
  onCommentSelect,
  onCommentShortcut,
  onCommentRevealed,
}: {
  projectId: string
  documentId: string
  socket: HocuspocusProviderWebsocket
  /**
   * Lecture seule (rôle sans édition). Le passage en lecture seule reconfigure l'éditeur ; le
   * retour en écriture rouvre le document (les frappes refusées pendant la lecture seule
   * bloqueraient les suivantes).
   */
  readOnly: boolean
  theme: Theme
  /** Registre d'actions dont les raccourcis sont liés à l'éditeur. */
  registry: ActionRegistry
  /** Callbacks de l'application pour les actions (lus à chaque exécution). */
  host: ActionHost
  /** Compilation automatique après une pause de frappe (préférence lue à chaque frappe). */
  autoCompile: boolean
  /** Sa propre identité de présence (curseur vu par les autres ; le serveur l'impose). */
  self: PresenceUser | null
  /** Collaborateur suivi (id) : l'éditeur défile jusqu'à son curseur. */
  follow: string | null
  /** Frappe dans l'éditeur (fin du suivi d'un collaborateur). */
  onKeystroke: () => void
  onCompile: () => void
  /** Auto-compilation (sans version dans l'historique) ; à défaut, `onCompile`. */
  onAutoCompile?: () => void
  onReady: (handle: EditorHandle | null) => void
  onSyncState: (state: SyncState) => void
  /** Fils de commentaires de ce document : les ouverts sont surlignés. */
  comments?: readonly CommentThread[]
  /** Fil sélectionné dans le panneau Review (surlignage renforcé). */
  activeCommentId?: string | null
  /** Demande de saut vers un fil de ce document (`serial` change à chaque demande). */
  revealComment?: { threadId: string; serial: number } | null
  /** Positions des fils dans le texte courant, après chaque modification (regroupées). */
  onCommentPositions?: (positions: ReadonlyMap<string, ResolvedAnchor>) => void
  /** Clic dans un texte commenté. */
  onCommentSelect?: (threadId: string) => void
  /** Raccourci « Commenter la sélection » (Ctrl+Alt+M, Cmd+Option+M sur macOS). */
  onCommentShortcut?: () => void
  /** La demande de saut a été traitée (le fil est dans ce document). */
  onCommentRevealed?: () => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const callbacks = useRef({
    onCompile,
    onAutoCompile,
    onReady,
    onSyncState,
    onKeystroke,
    host,
    autoCompile,
    onCommentPositions,
    onCommentSelect,
    onCommentShortcut,
    onCommentRevealed,
  })
  // Valeurs lues à la création de l'éditeur et par ses écouteurs.
  const latest = useRef({ readOnly, self, follow, comments })
  // Recalcul des plages commentées depuis Yjs (null tant que l'éditeur n'existe pas).
  const refreshComments = useRef<(() => void) | null>(null)
  // Texte partagé et éditeur courants (saut vers un commentaire).
  const shared = useRef<{ ytext: Y.Text; editor: EditorView } | null>(null)
  const view = useRef<EditorView | null>(null)
  // Défilement jusqu'au curseur du collaborateur suivi (null tant que l'éditeur n'existe pas).
  const revealFollowed = useRef<(() => void) | null>(null)
  const [ready, setReady] = useState(false)
  // Thème à la création ; ses changements passent ensuite par reconfigureEditor.
  const initialTheme = useRef(theme)
  // Ouverture courante du document : incrémentée au retour en écriture pour le rouvrir (état
  // dérivé pendant le rendu, plutôt qu'un effet qui relancerait un rendu).
  const [opening, setOpening] = useState({ readOnly, serial: 0 })
  if (opening.readOnly !== readOnly) {
    setOpening({ readOnly, serial: readOnly ? opening.serial : opening.serial + 1 })
  }
  const openingSerial = opening.serial

  useEffect(() => {
    callbacks.current = {
      onCompile,
      onAutoCompile,
      onReady,
      onSyncState,
      onKeystroke,
      host,
      autoCompile,
      onCommentPositions,
      onCommentSelect,
      onCommentShortcut,
      onCommentRevealed,
    }
    latest.current = { readOnly, self, follow, comments }
  })

  // Fils modifiés (création, résolution, relecture) : plages recalculées.
  useEffect(() => {
    refreshComments.current?.()
  }, [comments, ready])

  useEffect(() => {
    if (ready) view.current?.dispatch({ effects: setActiveComment.of(activeCommentId) })
  }, [activeCommentId, ready])

  // Saut vers un fil : sa plage est sélectionnée, ou l'endroit où se trouvait le texte supprimé.
  const revealSerial = revealComment?.serial ?? null
  const revealThreadId = revealComment?.threadId ?? null
  useEffect(() => {
    const current = shared.current
    if (!ready || revealThreadId === null || current === null) return
    const thread = latest.current.comments.find((candidate) => candidate.id === revealThreadId)
    const bytes = thread ? anchorFromBase64(thread.anchor) : null
    if (bytes === null) return
    callbacks.current.onCommentRevealed?.()
    const position = resolveCommentAnchor(current.ytext, bytes)
    if (position.status === 'attached')
      revealCommentRange(current.editor, position.from, position.to)
    else if (position.status === 'detached')
      revealCommentRange(current.editor, position.at, position.at)
  }, [ready, revealThreadId, revealSerial])

  useEffect(() => {
    if (view.current) reconfigureEditor(view.current, { theme })
  }, [theme])

  // Passage en lecture seule sans recréer l'éditeur (le retour en écriture le rouvre).
  useEffect(() => {
    if (view.current && readOnly) reconfigureEditor(view.current, { readOnly: true })
  }, [readOnly])

  // Nouveau collaborateur suivi : on rejoint aussitôt son curseur.
  useEffect(() => {
    if (follow !== null) revealFollowed.current?.()
  }, [follow])

  useEffect(() => {
    const element = container.current
    if (!element) return
    const doc = new Y.Doc()
    const ytext = doc.getText(TEXT_FIELD)
    const provider = new HocuspocusProvider({
      websocketProvider: socket,
      name: documentName(projectId, documentId),
      document: doc,
      // Routage par session : un document refermé puis rouvert aussitôt sur la même connexion
      // (changement de fichier, double montage de React) reste modifiable.
      sessionAwareness: true,
      // Jeton frais (5 minutes) à chaque authentification, reconnexions comprises.
      token: async () => (await api.realtimeToken(projectId)).token,
    })
    provider.attach()
    // Identité pour l'affichage local ; le service temps réel impose la sienne aux autres.
    if (latest.current.self) provider.awareness?.setLocalStateField('user', latest.current.self)

    const report = () => {
      if (!provider.isSynced) callbacks.current.onSyncState('connecting')
      else callbacks.current.onSyncState(provider.hasUnsyncedChanges ? 'saving' : 'synced')
    }
    provider.on('unsyncedChanges', report)
    provider.on('disconnect', () => {
      callbacks.current.onSyncState('offline')
    })
    // Document supprimé ou accès retiré : le serveur ferme la connexion.
    provider.on('close', () => {
      callbacks.current.onSyncState('closed')
    })
    provider.on('authenticationFailed', () => {
      callbacks.current.onSyncState('closed')
    })

    const undoManager = new Y.UndoManager(ytext)
    const listeners = new Set<() => void>()
    let created: EditorView | null = null

    // L'éditeur n'existe qu'une fois le document reçu du serveur : on n'écrit jamais dans un
    // document dont l'authentification n'est pas encore faite.
    const mount = () => {
      report()
      if (created !== null) return
      const editor = new EditorView({
        parent: element,
        state: EditorState.create({
          doc: ytext.toJSON(),
          extensions: [
            latexExtensions({
              sharedHistory: true,
              // Lu au montage : un passage en lecture seule pendant le chargement compte.
              readOnly: latest.current.readOnly,
              theme: initialTheme.current,
              onCompile: () => {
                callbacks.current.onCompile()
              },
              actions: { registry, host: () => callbacks.current.host },
              autoCompile: {
                onCompile: () => {
                  ;(callbacks.current.onAutoCompile ?? callbacks.current.onCompile)()
                },
                enabled: () => callbacks.current.autoCompile,
                // Annuler et rétablir passent par l'historique Yjs : y-codemirror applique la
                // modification sans événement utilisateur, comme celles des collaborateurs. Les
                // drapeaux de l'UndoManager, levés pendant l'appel synchrone, les distinguent.
                filter: (transaction) =>
                  isLocalEdit(transaction) || undoManager.undoing || undoManager.redoing,
              },
            }),
            yCollab(ytext, provider.awareness, { undoManager }),
            keymap.of(yUndoManagerKeymap),
            collaboratorCursorTheme,
            commentHighlights({
              onSelect: (threadId) => {
                callbacks.current.onCommentSelect?.(threadId)
              },
            }),
            keymap.of([
              {
                key: 'Mod-Alt-m',
                preventDefault: true,
                run: () => {
                  callbacks.current.onCommentShortcut?.()
                  return callbacks.current.onCommentShortcut !== undefined
                },
              },
            ]),
            keystrokeListener(() => {
              // Fin du suivi immédiate : le raccourci (Entrée, Retour arrière…) modifie le
              // document dans le même événement, avant que React n'applique le nouvel état.
              latest.current.follow = null
              callbacks.current.onKeystroke()
            }),
            // Chaque action de la barre Tools est une étape d'annulation distincte : la saisie
            // en cours est close avant l'action, et l'action avant la saisie suivante.
            EditorState.transactionFilter.of((transaction) => {
              if (isActionTransaction(transaction)) undoManager.stopCapturing()
              return transaction
            }),
            EditorView.updateListener.of((update) => {
              if (update.transactions.some(isActionTransaction)) undoManager.stopCapturing()
              if (update.docChanged || update.selectionSet) {
                for (const listener of [...listeners]) listener()
              }
            }),
          ],
        }),
      })
      created = editor
      view.current = editor
      shared.current = { ytext, editor }
      // Plages commentées : envoyées à l'éditeur hors de sa mise à jour (une modification locale
      // atteint Yjs pendant celle-ci), une fois par salve ; positions remontées au panneau après
      // un court délai.
      let commentsScheduled = false
      let reported = new Map<string, ResolvedAnchor>()
      let reportTimer: ReturnType<typeof setTimeout> | null = null
      refreshComments.current = () => {
        if (commentsScheduled) return
        commentsScheduled = true
        queueMicrotask(() => {
          commentsScheduled = false
          if (view.current !== editor) return
          const { positions, ranges } = resolveThreads(ytext, latest.current.comments)
          editor.dispatch({ effects: setCommentRanges.of(ranges) })
          if (reportTimer !== null) clearTimeout(reportTimer)
          reportTimer = null
          if (samePositions(positions, reported)) return
          reportTimer = setTimeout(() => {
            reportTimer = null
            if (view.current !== editor) return
            reported = positions
            callbacks.current.onCommentPositions?.(positions)
          }, COMMENT_POSITIONS_DELAY_MS)
        })
      }
      refreshComments.current()
      // Défilement différé : les extensions de y-codemirror modifient Yjs et l'awareness pendant
      // la mise à jour de l'éditeur ; appeler view.dispatch à ce moment lèverait une erreur et
      // désactiverait leurs plugins (synchronisation, curseurs distants). Un seul défilement par
      // salve de changements.
      let scheduled = false
      revealFollowed.current = () => {
        if (scheduled) return
        scheduled = true
        queueMicrotask(() => {
          scheduled = false
          const followed = latest.current.follow
          const awareness = provider.awareness
          if (followed === null || !awareness || view.current !== editor) return
          const index = cursorIndexOf(awareness.getStates(), followed, ytext)
          if (index !== null) revealPosition(editor, index)
        })
      }
      setReady(true)
      revealFollowed.current()
      callbacks.current.onReady({
        documentId,
        view: editor,
        goToLine: (line) => {
          goToLine(editor, line)
        },
        select: (line, column, length) => {
          const target = editor.state.doc.line(Math.min(Math.max(1, line), editor.state.doc.lines))
          const from = Math.min(target.from + column, target.to)
          const to = Math.min(from + length, editor.state.doc.length)
          editor.dispatch({
            selection: EditorSelection.range(from, to),
            effects: EditorView.scrollIntoView(from, { y: 'center' }),
          })
          editor.focus()
        },
        subscribe: (listener) => {
          listeners.add(listener)
          return () => {
            listeners.delete(listener)
          }
        },
        cursorLine: () => editor.state.doc.lineAt(editor.state.selection.main.head).number,
        flush: () =>
          new Promise<void>((resolve) => {
            if (!provider.hasUnsyncedChanges) {
              resolve()
              return
            }
            const done = () => {
              if (provider.hasUnsyncedChanges) return
              provider.off('unsyncedChanges', done)
              clearTimeout(timer)
              resolve()
            }
            // Au pire, on compile ce que le serveur a déjà reçu.
            const timer = setTimeout(() => {
              provider.off('unsyncedChanges', done)
              resolve()
            }, 3_000)
            provider.on('unsyncedChanges', done)
          }),
        undo: () => {
          if (!latest.current.readOnly) undoManager.undo()
          editor.focus()
        },
        redo: () => {
          if (!latest.current.readOnly) undoManager.redo()
          editor.focus()
        },
        commentDraft: () => {
          const selection = commentableSelection(editor.state)
          if (selection === null) return null
          return {
            anchor: anchorToBase64(createCommentAnchor(ytext, selection.from, selection.to)),
            quotedText: quoteOf(selection.text),
          }
        },
      })
    }
    provider.on('synced', mount)
    // Suivi : le curseur suivi bouge (awareness) ou le texte change autour de lui.
    // Les changements locaux (sa propre saisie, son propre curseur) sont ignorés : ils ne
    // déplacent pas le curseur suivi et surviennent pendant la mise à jour de l'éditeur.
    const followAwareness = (changes: {
      added: number[]
      updated: number[]
      removed: number[]
    }) => {
      const ids = [...changes.added, ...changes.updated, ...changes.removed]
      if (ids.some((id) => id !== doc.clientID)) revealFollowed.current?.()
    }
    const followText = (_event: Y.YTextEvent, transaction: Y.Transaction) => {
      if (!transaction.local) revealFollowed.current?.()
      refreshComments.current?.()
    }
    provider.awareness?.on('change', followAwareness)
    ytext.observe(followText)

    return () => {
      provider.awareness?.off('change', followAwareness)
      ytext.unobserve(followText)
      revealFollowed.current = null
      refreshComments.current = null
      shared.current = null
      callbacks.current.onReady(null)
      listeners.clear()
      created?.destroy()
      view.current = null
      undoManager.destroy()
      provider.destroy()
      doc.destroy()
      setReady(false)
    }
  }, [projectId, documentId, socket, registry, openingSerial])

  return (
    <div className="relative h-full bg-editor">
      {!ready ? (
        <p className="absolute inset-x-0 top-4 z-10 flex items-center justify-center gap-2 text-sm text-editor-gutter-foreground">
          <Spinner label="" /> Chargement du document…
        </p>
      ) : null}
      <div ref={container} className="h-full" data-testid="code-editor" />
    </div>
  )
}
