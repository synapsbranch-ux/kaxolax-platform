import type { ProjectTree, TreeDocument } from './api'

/** Documents analysés pour l'autocomplétion : LaTeX (labels, commandes, packages) et BibTeX. */
export const INDEXED_EXTENSIONS = /\.(?:tex|ltx|sty|cls|tikz|bib)$/i

/**
 * Lecteurs ouverts au plus : au-delà (projet de plusieurs centaines de chapitres), les .bib
 * passent en premier, puis les documents LaTeX par ordre de chemin.
 */
export const MAX_INDEXED_DOCUMENTS = 200

/** Documents de l'arborescence lus pour l'index du projet. */
export function indexedDocuments(tree: ProjectTree, limit = MAX_INDEXED_DOCUMENTS): TreeDocument[] {
  const isBib = (entry: TreeDocument) => /\.bib$/i.test(entry.path)
  return tree.documents
    .filter((entry) => INDEXED_EXTENSIONS.test(entry.path))
    .toSorted(
      (a, b) =>
        Number(isBib(b)) - Number(isBib(a)) || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    )
    .slice(0, limit)
}

/** Documents dont le chemin a changé depuis la dernière arborescence (renommage, déplacement). */
export function treeRenames(
  previous: ReadonlyMap<string, string>,
  tree: ProjectTree,
): { from: string; to: string }[] {
  const renames: { from: string; to: string }[] = []
  for (const entry of tree.documents) {
    const before = previous.get(entry.id)
    if (before !== undefined && before !== entry.path)
      renames.push({ from: before, to: entry.path })
  }
  return renames
}
