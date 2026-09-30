'use client'

import { HocuspocusProvider, type HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { documentName, TEXT_FIELD } from '@kaxolax/collab'
import { goToLine, latexExtensions } from '@kaxolax/editor'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { useEffect, useRef, useState } from 'react'
import { yCollab, yUndoManagerKeymap } from 'y-codemirror.next'
import * as Y from 'yjs'
import { api } from '@/lib/api'

/** Commandes de l'éditeur utilisées par la page (logs, SyncTeX, compilation). */
export interface EditorHandle {
  goToLine: (line: number) => void
  /** Ligne du curseur (1 = première). */
  cursorLine: () => number
  /** Attend que les dernières frappes soient arrivées au serveur (avant une compilation). */
  flush: () => Promise<void>
}

export type SyncState = 'connecting' | 'synced' | 'saving' | 'offline' | 'closed'

export function CodeEditor({
  projectId,
  documentId,
  socket,
  readOnly,
  onCompile,
  onReady,
  onSyncState,
}: {
  projectId: string
  documentId: string
  socket: HocuspocusProviderWebsocket
  readOnly: boolean
  onCompile: () => void
  onReady: (handle: EditorHandle | null) => void
  onSyncState: (state: SyncState) => void
}) {
  const container = useRef<HTMLDivElement>(null)
  const callbacks = useRef({ onCompile, onReady, onSyncState })
  const [ready, setReady] = useState(false)

  useEffect(() => {
    callbacks.current = { onCompile, onReady, onSyncState }
  })

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
    let view: EditorView | null = null

    // L'éditeur n'existe qu'une fois le document reçu du serveur : on n'écrit jamais dans un
    // document dont l'authentification n'est pas encore faite.
    const mount = () => {
      report()
      if (view !== null) return
      const created = new EditorView({
        parent: element,
        state: EditorState.create({
          doc: ytext.toJSON(),
          extensions: [
            latexExtensions({
              sharedHistory: true,
              readOnly,
              onCompile: () => {
                callbacks.current.onCompile()
              },
            }),
            yCollab(ytext, provider.awareness, { undoManager }),
            keymap.of(yUndoManagerKeymap),
          ],
        }),
      })
      view = created
      setReady(true)
      callbacks.current.onReady({
        goToLine: (line) => {
          goToLine(created, line)
        },
        cursorLine: () => created.state.doc.lineAt(created.state.selection.main.head).number,
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
      })
    }
    provider.on('synced', mount)

    return () => {
      callbacks.current.onReady(null)
      view?.destroy()
      undoManager.destroy()
      provider.destroy()
      doc.destroy()
      setReady(false)
    }
  }, [projectId, documentId, socket, readOnly])

  return (
    <div className="relative h-full">
      {!ready ? (
        <p className="absolute inset-x-0 top-4 z-10 text-center text-sm text-muted-foreground">
          Chargement du document…
        </p>
      ) : null}
      <div ref={container} className="h-full" data-testid="code-editor" />
    </div>
  )
}
