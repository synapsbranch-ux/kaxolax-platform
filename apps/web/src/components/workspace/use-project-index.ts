'use client'

import type { HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { ProjectIndex } from '@kaxolax/editor'
import { useEffect, useMemo, useRef, useState } from 'react'
import type { ProjectTree, TreeDocument } from '@/lib/api'
import { indexedDocuments, treeRenames } from '@/lib/project-index'
import { DocumentReaders } from './document-readers'
import type { EditorHandle } from './editor/code-editor'

/** Pause après une modification d'un document lu en arrière-plan (collaborateur). */
const READER_DEBOUNCE_MS = 500
/** Pause de frappe avant de réanalyser le document ouvert. */
const EDITOR_DEBOUNCE_MS = 250

/**
 * Index du projet pour l'autocomplétion (`ProjectIndex` de @kaxolax/editor) : chemins de toute
 * l'arborescence, labels, commandes et packages de tous les documents LaTeX, clés de tous les
 * .bib. Les documents sont lus en direct sur la connexion temps réel du projet (lecteurs Yjs
 * sans présence, ouverts au fil de l'arborescence) ; le document ouvert est réanalysé après une
 * courte pause de frappe, sans attendre le serveur. Chaque document n'est réanalysé que lorsqu'il
 * change : les listes de l'autocomplétion sont recalculées une fois par version de l'index.
 */
export function useProjectIndex({
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
  /** Document principal : les chemins proposés après `\input{`… sont relatifs à son dossier. */
  mainDocumentId: string | null
  /** Document de l'onglet actif. */
  document: TreeDocument | null
  editor: EditorHandle | null
}): ProjectIndex {
  // Un index par projet (la page peut changer de projet sans être démontée).
  const [indexOf, setIndexOf] = useState(() => ({ projectId, index: new ProjectIndex() }))
  let index = indexOf.index
  if (indexOf.projectId !== projectId) {
    index = new ProjectIndex()
    setIndexOf({ projectId, index })
  }
  // Chemin courant de chaque document lu (renommages, déplacements).
  const paths = useRef(new Map<string, string>())
  const readers = useRef<DocumentReaders | null>(null)
  const documents = useMemo(() => (tree === null ? [] : indexedDocuments(tree)), [tree])
  const documentsKey = documents.map((entry) => entry.id).join(',')

  // Arborescence : renommages reportés dans l'index, puis chemins de tous les fichiers.
  useEffect(() => {
    if (tree === null) return
    for (const rename of treeRenames(paths.current, tree)) index.renameFile(rename.from, rename.to)
    paths.current = new Map(tree.documents.map((entry) => [entry.id, entry.path]))
    index.setFiles([
      ...tree.documents.map((entry) => entry.path),
      ...tree.files.map((entry) => entry.path),
    ])
  }, [index, tree])

  // Dossier du document principal (LaTeX et texcount tournent dans ce dossier).
  const mainPath = tree?.documents.find((entry) => entry.id === mainDocumentId)?.path ?? null
  useEffect(() => {
    if (mainPath === null) return
    const slash = mainPath.lastIndexOf('/')
    index.setRootDirectory(slash === -1 ? '' : mainPath.slice(0, slash))
  }, [index, mainPath])

  // Lecteurs des documents, sur la connexion du projet.
  useEffect(() => {
    if (socket === null) return
    const created = new DocumentReaders(
      projectId,
      socket,
      (documentId, text) => {
        const path = paths.current.get(documentId)
        if (path !== undefined) index.setFile(path, text)
      },
      READER_DEBOUNCE_MS,
    )
    readers.current = created
    return () => {
      created.destroy()
      if (readers.current === created) readers.current = null
    }
  }, [projectId, socket, index])

  useEffect(() => {
    readers.current?.sync(documentsKey === '' ? [] : documentsKey.split(','))
  }, [documentsKey, socket, index])

  // Document ouvert : réanalysé pendant la frappe.
  useEffect(() => {
    if (document === null || editor?.documentId !== document.id) return
    const { view } = editor
    const path = document.path
    let analysed = view.state.doc
    index.setFile(path, analysed.toString())
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = editor.subscribe(() => {
      if (view.state.doc === analysed) return
      if (timer !== null) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        analysed = view.state.doc
        index.setFile(path, analysed.toString())
      }, EDITOR_DEBOUNCE_MS)
    })
    return () => {
      if (timer !== null) clearTimeout(timer)
      unsubscribe()
    }
  }, [index, editor, document])

  return index
}
