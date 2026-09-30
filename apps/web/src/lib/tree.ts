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
