'use client'

import { HocuspocusProvider, type HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { documentName, TEXT_FIELD } from '@kaxolax/collab'
import { currentSection, type OutlineItem, type OutlineNode, scanOutline } from '@kaxolax/editor'
import { useEffect, useMemo, useState } from 'react'
import * as Y from 'yjs'
import { api, type ProjectTree, type TreeDocument } from '@/lib/api'
import { includedDocuments, projectOutline } from '@/lib/outline'
import type { EditorHandle } from './editor/code-editor'

/** Pause après une frappe ou un déplacement du curseur avant de recalculer le plan. */
const OUTLINE_DEBOUNCE_MS = 250
/** Pause après une modification d'un fichier inclus (faite par un collaborateur). */
const INCLUDED_DEBOUNCE_MS = 1_000

/** Jeton temps réel partagé par les lecteurs de fichiers inclus (valable 5 minutes). */
let sharedToken: { projectId: string; promise: Promise<string>; until: number } | null = null
function realtimeToken(projectId: string): Promise<string> {
  const now = Date.now()
  if (sharedToken?.projectId !== projectId || sharedToken.until < now) {
    const promise = api.realtimeToken(projectId).then(({ token }) => token)
    sharedToken = { projectId, promise, until: now + 2 * 60_000 }
    // Un échec ne reste pas en cache.
    promise.catch(() => {
      sharedToken = null
    })
  }
  return sharedToken.promise
}

type ItemsById = ReadonlyMap<string, readonly OutlineItem[]>

/**
 * Lit en direct (Yjs, lecture seule, sans présence) les documents inclus sur la connexion du
 * projet et publie les éléments de leur plan dans `onItems`. Les lecteurs sont ouverts et fermés
 * au fil de la liste `key` (ids triés, séparés par des virgules).
 */
function useIncludedReaders(
  projectId: string,
  socket: HocuspocusProviderWebsocket | null,
  key: string,
  onItems: (update: (current: ItemsById) => ItemsById) => void,
): void {
  useEffect(() => {
    if (socket === null || key === '') return
    const readers = key.split(',').map((documentId) => {
      const doc = new Y.Doc()
      const text = doc.getText(TEXT_FIELD)
      const provider = new HocuspocusProvider({
        websocketProvider: socket,
        name: documentName(projectId, documentId),
        document: doc,
        sessionAwareness: true,
        token: () => realtimeToken(projectId),
      })
      // Simple lecteur : il n'apparaît pas parmi les collaborateurs en ligne.
      provider.awareness?.setLocalState(null)
      provider.attach()
      let timer: ReturnType<typeof setTimeout> | null = null
      const publish = () => {
        const scanned = scanOutline(text.toJSON())
        onItems((current) => new Map(current).set(documentId, scanned))
      }
      const schedule = () => {
        if (timer !== null) clearTimeout(timer)
        timer = setTimeout(publish, INCLUDED_DEBOUNCE_MS)
      }
      provider.on('synced', publish)
      text.observe(schedule)
      return () => {
        if (timer !== null) clearTimeout(timer)
        text.unobserve(schedule)
        provider.destroy()
        doc.destroy()
      }
    })
    return () => {
      for (const close of readers) close()
    }
  }, [projectId, socket, key, onItems])
}

export interface DocumentOutline {
  nodes: OutlineNode[]
  /** Section qui contient le curseur (null avant le premier titre). */
  current: OutlineNode | null
}

/**
 * Plan du document ouvert, mis à jour pendant la frappe (anti-rebond), avec les titres des
 * fichiers du projet qu'il inclut (`\input`, `\include`…), et section courante selon le curseur.
 */
export function useDocumentOutline({
  projectId,
  socket,
  tree,
  mainDocumentId,
  document,
  editor,
}: {
  projectId: string
  socket: HocuspocusProviderWebsocket | null
  tree: ProjectTree | null
  mainDocumentId: string | null
  /** Document de l'onglet actif (null : fichier binaire ou aucun onglet). */
  document: TreeDocument | null
  editor: EditorHandle | null
}): DocumentOutline {
  const [snapshot, setSnapshot] = useState<{
    documentId: string
    items: readonly OutlineItem[]
    head: number
  } | null>(null)

  useEffect(() => {
    // Changement d'onglet : la poignée de l'ancien éditeur reste transmise jusqu'au rendu
    // suivant ; elle ne doit pas publier son plan sous le nouveau document.
    if (document === null || editor?.documentId !== document.id) return
    const { view } = editor
    let lastDoc = view.state.doc
    let items = scanOutline(lastDoc)
    const read = () => {
      if (view.state.doc !== lastDoc) {
        lastDoc = view.state.doc
        items = scanOutline(lastDoc)
      }
      setSnapshot({ documentId: document.id, items, head: view.state.selection.main.head })
    }
    read()
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = editor.subscribe(() => {
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(read, OUTLINE_DEBOUNCE_MS)
    })
    return () => {
      if (timer !== null) clearTimeout(timer)
      unsubscribe()
    }
  }, [editor, document])

  const active = snapshot !== null && snapshot.documentId === document?.id ? snapshot : null
  const mainPath = tree?.documents.find((entry) => entry.id === mainDocumentId)?.path ?? null

  // Éléments des fichiers inclus déjà lus : ils donnent les inclusions de niveau suivant.
  const [loaded, setLoaded] = useState<ItemsById>(new Map())
  const included = useMemo(
    () =>
      tree === null || active === null || document === null
        ? []
        : includedDocuments(tree, { document, items: active.items }, loaded, mainPath),
    [tree, active, document, loaded, mainPath],
  )
  const includedKey = included
    .map((entry) => entry.id)
    .sort()
    .join(',')
  useIncludedReaders(projectId, socket, includedKey, setLoaded)

  return useMemo(() => {
    if (tree === null || active === null || document === null) return { nodes: [], current: null }
    const nodes = projectOutline(tree, { document, items: active.items }, loaded, mainPath)
    return { nodes, current: currentSection(nodes, active.head, document.path) }
  }, [tree, active, document, loaded, mainPath])
}
