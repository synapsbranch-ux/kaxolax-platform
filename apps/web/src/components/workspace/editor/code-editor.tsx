'use client'

import { HocuspocusProvider, type HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import type { Theme } from '@kaxolax/contracts'
import { documentName, TEXT_FIELD } from '@kaxolax/collab'
import {
  type ActionHost,
  type ActionRegistry,
  goToLine,
  isActionTransaction,
  isLocalEdit,
  latexExtensions,
  reconfigureEditor,
} from '@kaxolax/editor'
import { Spinner } from '@kaxolax/ui'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { useEffect, useRef, useState } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { api } from '@/lib/api'
import { isStorageAvailableMessage, reportRealtimePlanLimit } from '@/lib/plan-limits'

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
  onCompile,
  onReady,
  onSyncState,
}: {
  projectId: string
  documentId: string
  socket: HocuspocusProviderWebsocket
  readOnly: boolean
  theme: Theme
  /** Registre d'actions dont les raccourcis sont liés à l'éditeur. */
  registry: ActionRegistry
  /** Callbacks de l'application pour les actions (lus à chaque exécution). */
  host: ActionHost
  /** Compilation automatique après une pause de frappe (préférence lue à chaque frappe). */
  autoCompile: boolean
  onCompile: () => void
  onReady: (handle: EditorHandle | null) => void
  onSyncState: (state: SyncState) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onCompile, onReady, onSyncState, host, autoCompile })
  const view = useRef<EditorView | null>(null)
  const [ready, setReady] = useState(false)
  // Thème à la création ; ses changements passent ensuite par reconfigureEditor.
  const initialTheme = useRef(theme)

  useEffect(() => {
    callbacks.current = { onCompile, onReady, onSyncState, host, autoCompile }
  })

  useEffect(() => {
    if (view.current) reconfigureEditor(view.current, { theme })
  }, [theme])

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
      // Stockage du propriétaire plein : éditions refusées, expliqué par la boîte des limites.
      onStateless: ({ payload }) => {
        reportRealtimePlanLimit(payload)
        if (isStorageAvailableMessage(payload)) provider.forceSync()
      },
    })
    provider.attach()

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
              readOnly,
              theme: initialTheme.current,
              onCompile: () => {
                callbacks.current.onCompile()
              },
              actions: { registry, host: () => callbacks.current.host },
              autoCompile: {
                onCompile: () => {
                  callbacks.current.onCompile()
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
      setReady(true)
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
          if (!readOnly) undoManager.undo()
          editor.focus()
        },
        redo: () => {
          if (!readOnly) undoManager.redo()
          editor.focus()
        },
      })
    }
    provider.on('synced', mount)

    return () => {
      callbacks.current.onReady(null)
      listeners.clear()
      created?.destroy()
      view.current = null
      undoManager.destroy()
      provider.destroy()
      doc.destroy()
      setReady(false)
    }
  }, [projectId, documentId, socket, readOnly, registry])

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
