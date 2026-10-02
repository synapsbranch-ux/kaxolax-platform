'use client'

import type { HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { currentSection, type OutlineItem, type OutlineNode, scanOutline } from '@kaxolax/editor'
import { useEffect, useMemo, useState } from 'react'
import type { ProjectTree, TreeDocument } from '@/lib/api'
import { includedDocuments, projectOutline } from '@/lib/outline'
import { openDocumentReader } from './document-readers'
import type { EditorHandle } from './editor/code-editor'

/** Pause après une frappe ou un déplacement du curseur avant de recalculer le plan. */
const OUTLINE_DEBOUNCE_MS = 250
/** Pause après une modification d'un fichier inclus (faite par un collaborateur). */
const INCLUDED_DEBOUNCE_MS = 1_000

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
    const readers = key.split(',').map((documentId) =>
      openDocumentReader(
        projectId,
        socket,
        documentId,
        (text) => {
          const scanned = scanOutline(text)
          onItems((current) => new Map(current).set(documentId, scanned))
        },
        INCLUDED_DEBOUNCE_MS,
      ),
    )
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
