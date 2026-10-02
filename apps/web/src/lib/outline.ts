/** Plan du document : résolution des fichiers inclus (sans interface, testé unitairement). */
import {
  buildOutlineTree,
  expandOutline,
  includeCandidates,
  type OutlineInclude,
  type OutlineItem,
  type OutlineNode,
} from '@kaxolax/editor'
import type { ProjectTree, TreeDocument } from '@/lib/api'

/** Fichiers inclus lus au plus pour le plan (au-delà, les inclusions sont ignorées). */
export const MAX_OUTLINE_INCLUDES = 30

/** Dossier d'un chemin (`chapters/intro.tex` → `chapters`, `main.tex` → ``). */
function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index === -1 ? '' : path.slice(0, index)
}

/** Chemin normalisé (`a/./b/../c` → `a/c`) ; null s'il sort du projet. */
function normalize(path: string): string | null {
  const parts: string[] = []
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      if (parts.length === 0) return null
      parts.pop()
    } else parts.push(part)
  }
  return parts.join('/')
}

/**
 * Document du projet désigné par une inclusion. LaTeX cherche les fichiers depuis le dossier du
 * fichier principal (répertoire de compilation) ; on essaie ensuite le dossier du fichier qui
 * inclut, puis la racine du projet. Null si l'inclusion ne désigne aucun document.
 */
export function resolveInclude(
  tree: ProjectTree,
  include: Pick<OutlineInclude, 'command' | 'path'>,
  from: string,
  mainPath: string | null,
): TreeDocument | null {
  const bases = [...new Set([dirname(mainPath ?? from), dirname(from), ''])]
  for (const base of bases) {
    for (const candidate of includeCandidates(include)) {
      const path = normalize(base === '' ? candidate : `${base}/${candidate}`)
      if (path === null) continue
      const document = tree.documents.find((entry) => entry.path === path)
      if (document) return document
    }
  }
  return null
}

/** Éléments du plan d'un document lu (null tant que son texte n'est pas arrivé). */
export type OutlineItemsById = ReadonlyMap<string, readonly OutlineItem[]>

/**
 * Documents inclus, directement ou non, par `root` : ceux dont le texte est connu sont parcourus
 * à leur tour. Le document racine n'en fait pas partie ; au plus `MAX_OUTLINE_INCLUDES`.
 */
export function includedDocuments(
  tree: ProjectTree,
  root: { document: TreeDocument; items: readonly OutlineItem[] },
  known: OutlineItemsById,
  mainPath: string | null,
): TreeDocument[] {
  const found = new Map<string, TreeDocument>()
  const queue: { path: string; items: readonly OutlineItem[] }[] = [
    { path: root.document.path, items: root.items },
  ]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    for (const item of current.items) {
      if (item.kind !== 'include') continue
      const document = resolveInclude(tree, item, current.path, mainPath)
      if (document === null || document.id === root.document.id || found.has(document.id)) continue
      if (found.size >= MAX_OUTLINE_INCLUDES) return [...found.values()]
      found.set(document.id, document)
      const items = known.get(document.id)
      if (items !== undefined) queue.push({ path: document.path, items })
    }
  }
  return [...found.values()]
}

/**
 * Plan du document courant, fichiers inclus compris (ceux dont le texte est connu). Chaque titre
 * porte le chemin de son fichier (`file`).
 */
export function projectOutline(
  tree: ProjectTree,
  root: { document: TreeDocument; items: readonly OutlineItem[] },
  known: OutlineItemsById,
  mainPath: string | null,
): OutlineNode[] {
  const headings = expandOutline(
    { file: root.document.path, items: root.items },
    (include, from) => {
      const document = resolveInclude(tree, include, from, mainPath)
      if (document === null) return null
      const items = document.id === root.document.id ? root.items : known.get(document.id)
      return items === undefined ? null : { file: document.path, items }
    },
  )
  return buildOutlineTree(headings)
}
