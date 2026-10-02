import type { ProjectTree, TreeDocument, TreeFile, TreeFolder } from './api'

export type TreeNode =
  | { type: 'folder'; entity: TreeFolder; children: TreeNode[] }
  | { type: 'document'; entity: TreeDocument }
  | { type: 'file'; entity: TreeFile }

const byName = (a: TreeNode, b: TreeNode) =>
  (a.type === 'folder' ? 0 : 1) - (b.type === 'folder' ? 0 : 1) ||
  a.entity.name.localeCompare(b.entity.name)

/** Arbre imbriqué (dossiers d'abord, puis par nom) à partir des listes plates de l'API. */
export function nestTree(tree: ProjectTree): TreeNode[] {
  const children = new Map<string | null, TreeNode[]>()
  const push = (parent: string | null, node: TreeNode) => {
    const list = children.get(parent) ?? []
    list.push(node)
    children.set(parent, list)
  }
  const folderNodes = new Map<string, TreeNode & { type: 'folder' }>()
  for (const folder of tree.folders) {
    const node = { type: 'folder' as const, entity: folder, children: [] }
    folderNodes.set(folder.id, node)
    push(folder.parentId, node)
  }
  for (const document of tree.documents)
    push(document.folderId, { type: 'document', entity: document })
  for (const file of tree.files) push(file.folderId, { type: 'file', entity: file })
  for (const [id, node] of folderNodes) node.children = (children.get(id) ?? []).sort(byName)
  return (children.get(null) ?? []).sort(byName)
}

/** Document désigné par un chemin du projet (log, SyncTeX). */
export function documentByPath(tree: ProjectTree, path: string): TreeDocument | undefined {
  return tree.documents.find((document) => document.path === path)
}

/** Un dossier ne peut pas être déplacé dans lui-même ni dans l'un de ses sous-dossiers. */
export function isInside(tree: ProjectTree, folderId: string, ancestorId: string): boolean {
  let current: string | null = folderId
  while (current !== null) {
    if (current === ancestorId) return true
    current = tree.folders.find((folder) => folder.id === current)?.parentId ?? null
  }
  return false
}

/** Ligne visible de l'arborescence (dossiers repliés exclus de leur contenu), dans l'ordre affiché. */
export interface TreeRow {
  node: TreeNode
  /** Dossier parent affiché (null : racine). */
  parentId: string | null
  /** Dossier déplié. */
  open: boolean
}

/** Lignes visibles, dans l'ordre d'affichage (navigation au clavier). */
export function visibleRows(
  nodes: readonly TreeNode[],
  collapsed: ReadonlySet<string>,
  parentId: string | null = null,
  rows: TreeRow[] = [],
): TreeRow[] {
  for (const node of nodes) {
    const open = node.type === 'folder' && !collapsed.has(node.entity.id)
    rows.push({ node, parentId, open })
    if (node.type === 'folder' && open) visibleRows(node.children, collapsed, node.entity.id, rows)
  }
  return rows
}

/** Effet d'une touche dans l'arborescence (motif ARIA « tree view »). */
export type TreeKeyEffect =
  | { kind: 'focus'; id: string }
  | { kind: 'toggle'; id: string }
  | { kind: 'open'; id: string }
  | null

/**
 * Touche pressée sur la ligne `currentId` : flèches haut et bas (ligne voisine), Début et Fin,
 * droite (déplie un dossier, puis entre dans son contenu), gauche (replie, puis remonte au parent),
 * Entrée et Espace (ouvre un fichier, déplie ou replie un dossier). Null : touche non gérée.
 */
export function treeKeyEffect(
  rows: readonly TreeRow[],
  currentId: string,
  key: string,
): TreeKeyEffect {
  const index = rows.findIndex((row) => row.node.entity.id === currentId)
  const row = rows[index]
  if (row === undefined) return null
  const focus = (target: TreeRow | undefined): TreeKeyEffect =>
    target === undefined ? null : { kind: 'focus', id: target.node.entity.id }
  const isFolder = row.node.type === 'folder'
  switch (key) {
    case 'ArrowDown':
      return focus(rows[index + 1])
    case 'ArrowUp':
      return focus(rows[index - 1])
    case 'Home':
      return focus(rows[0])
    case 'End':
      return focus(rows.at(-1))
    case 'ArrowRight':
      if (!isFolder) return null
      if (!row.open) return { kind: 'toggle', id: currentId }
      return rows[index + 1]?.parentId === currentId ? focus(rows[index + 1]) : null
    case 'ArrowLeft':
      if (isFolder && row.open) return { kind: 'toggle', id: currentId }
      return row.parentId === null
        ? null
        : focus(rows.find((candidate) => candidate.node.entity.id === row.parentId))
    case 'Enter':
    case ' ':
      return isFolder ? { kind: 'toggle', id: currentId } : { kind: 'open', id: currentId }
    default:
      return null
  }
}
