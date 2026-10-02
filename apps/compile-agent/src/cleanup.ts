import { readdir, rm } from 'node:fs/promises'
import { directorySize, projectPaths, readLastUsedAt } from './workspace.js'

export interface PruneLimits {
  maxProjects: number
  maxBytes: number
}

export interface PruneResult {
  removed: string[]
  remainingBytes: number
}

/**
 * Nettoyage LRU des répertoires de projets : les moins récemment utilisés sont supprimés tant que
 * le nombre de projets ou la taille totale dépassent les limites. Un projet en cours de
 * compilation n'est jamais supprimé.
 */
export async function pruneProjects(
  compilesDir: string,
  limits: PruneLimits,
  isBusy: (projectId: string) => boolean,
): Promise<PruneResult> {
  // Les noms commençant par un point (comptages de mots en cours) ne sont pas des projets.
  const names = (await readdir(compilesDir).catch(() => [] as string[])).filter(
    (name) => !name.startsWith('.'),
  )
  const projects = await Promise.all(
    names.map(async (projectId) => {
      const paths = projectPaths(compilesDir, projectId)
      return {
        projectId,
        root: paths.root,
        lastUsedAt: await readLastUsedAt(paths),
        size: await directorySize(paths.root),
      }
    }),
  )
  projects.sort((a, b) => a.lastUsedAt - b.lastUsedAt)
  let count = projects.length
  let total = projects.reduce((sum, project) => sum + project.size, 0)
  const removed: string[] = []
  for (const project of projects) {
    if (count <= limits.maxProjects && total <= limits.maxBytes) break
    if (isBusy(project.projectId)) continue
    await rm(project.root, { recursive: true, force: true })
    removed.push(project.projectId)
    count--
    total -= project.size
  }
  return { removed, remainingBytes: total }
}
