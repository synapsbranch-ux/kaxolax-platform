import { createHash } from 'node:crypto'
import { constants, createReadStream } from 'node:fs'
import {
  chmod,
  chown,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { type CompileResource, isSafeRelativePath } from '@kaxolax/contracts'

/** Emplacements d'un projet sur l'agent : `files/` est monté dans le conteneur, pas `state.json`. */
export interface ProjectPaths {
  root: string
  files: string
  state: string
}

export function projectPaths(compilesDir: string, projectId: string): ProjectPaths {
  const root = join(compilesDir, projectId)
  return { root, files: join(root, 'files'), state: join(root, 'state.json') }
}

interface ManifestEntry {
  sha256: string
  size: number
  mtimeMs: number
}

interface ProjectState {
  /** Fichiers écrits par l'agent depuis les ressources (les autres sont des fichiers générés). */
  resources: Record<string, ManifestEntry>
  lastUsedAt: number
  /** Document principal de la dernière compilation (sert aux requêtes SyncTeX). */
  rootResourcePath?: string
}

export class UnsafePathError extends Error {}

/** Fournit le chemin local (dans le cache) du contenu binaire d'une ressource. */
export interface BinarySource {
  get(s3Key: string, sha256: string): Promise<string>
}

export interface SyncStats {
  written: number
  unchanged: number
  deleted: number
  bytesWritten: number
}

const SANDBOX_UID = 1000
const SANDBOX_GID = 1000

async function lstatOrNull(path: string) {
  try {
    return await lstat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

/**
 * Refuse un chemin absolu, contenant `..` ou traversant un lien symbolique. Un document LuaLaTeX
 * peut créer des liens (lfs) dans son répertoire : les suivre ferait écrire l'agent hors du projet.
 */
export async function assertSafeTarget(filesDir: string, relativePath: string): Promise<void> {
  if (!isSafeRelativePath(relativePath)) {
    throw new UnsafePathError(`Unsafe resource path: ${relativePath}`)
  }
  let current = filesDir
  for (const segment of relativePath.split('/')) {
    current = join(current, segment)
    const info = await lstatOrNull(current)
    if (info === null) return
    if (info.isSymbolicLink()) {
      throw new UnsafePathError(`Resource path traverses a symbolic link: ${relativePath}`)
    }
  }
}

async function readState(path: string): Promise<ProjectState> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as ProjectState
  } catch {
    return { resources: {}, lastUsedAt: 0 }
  }
}

async function writeState(path: string, state: ProjectState): Promise<void> {
  const temporary = `${path}.tmp`
  await writeFile(temporary, JSON.stringify(state))
  await rename(temporary, path)
}

/** Écrit sans jamais suivre un lien symbolique sur le dernier composant du chemin. */
async function writeNoFollow(path: string, data: string | { fromFile: string }): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
    0o644,
  )
  if (typeof data === 'string') {
    try {
      await handle.writeFile(data, 'utf8')
    } finally {
      await handle.close()
    }
    return
  }
  // Le flux ferme lui-même le descripteur à la fin (ou en cas d'erreur).
  await pipeline(createReadStream(data.fromFile), handle.createWriteStream())
}

async function makeWritableForSandbox(path: string, isDirectory: boolean): Promise<void> {
  const uid = process.getuid?.()
  if (uid === 0) {
    await chown(path, SANDBOX_UID, SANDBOX_GID)
  } else if (uid !== SANDBOX_UID) {
    // Développement avec un autre UID que 1000 : le conteneur doit pouvoir écrire.
    await chmod(path, isDirectory ? 0o777 : 0o666)
  }
}

async function ensureDirectory(filesDir: string, relativeDir: string): Promise<void> {
  if (relativeDir === '.' || relativeDir === '') return
  let current = filesDir
  for (const segment of relativeDir.split('/')) {
    current = join(current, segment)
    const info = await lstatOrNull(current)
    if (info === null) {
      await mkdir(current)
      await makeWritableForSandbox(current, true)
    } else if (!info.isDirectory()) {
      throw new UnsafePathError(`Path is not a directory: ${relativeDir}`)
    }
  }
}

async function removeEmptyParents(filesDir: string, relativePath: string): Promise<void> {
  let relative = dirname(relativePath)
  while (relative !== '.' && relative !== '') {
    try {
      await rmdir(join(filesDir, relative))
    } catch {
      return
    }
    relative = dirname(relative)
  }
}

export async function prepareProjectDirectory(paths: ProjectPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 })
  const info = await lstatOrNull(paths.files)
  if (info?.isSymbolicLink()) throw new UnsafePathError('Project directory is a symbolic link')
  if (info === null) {
    await mkdir(paths.files)
    await makeWritableForSandbox(paths.files, true)
  }
}

/**
 * Synchronise les ressources dans le répertoire du projet, par hash : seuls les fichiers modifiés
 * sont écrits, et les fichiers de ressources absents de la liste sont supprimés. Les fichiers
 * générés (aux, log, pdf…) sont conservés pour la compilation incrémentale.
 */
export async function syncWorkspace(
  paths: ProjectPaths,
  resources: CompileResource[],
  binaries: BinarySource,
  rootResourcePath: string,
): Promise<SyncStats> {
  // Toutes les vérifications ont lieu avant la moindre écriture.
  for (const resource of resources) await assertSafeTarget(paths.files, resource.path)

  await prepareProjectDirectory(paths)
  const state = await readState(paths.state)
  const wanted = new Set(resources.map((resource) => resource.path))
  const stats: SyncStats = { written: 0, unchanged: 0, deleted: 0, bytesWritten: 0 }

  for (const path of Object.keys(state.resources)) {
    if (wanted.has(path)) continue
    const target = join(paths.files, path)
    await assertSafeTarget(paths.files, path).catch(() => undefined)
    const info = await lstatOrNull(target)
    if (info && (info.isFile() || info.isSymbolicLink())) await rm(target, { force: true })
    Reflect.deleteProperty(state.resources, path)
    await removeEmptyParents(paths.files, path)
    stats.deleted++
  }

  for (const resource of resources) {
    const target = join(paths.files, resource.path)
    const known = state.resources[resource.path]
    const info = await lstatOrNull(target)
    // Même hash, et fichier inchangé depuis notre écriture (une compilation peut l'avoir écrasé).
    if (
      known?.sha256 === resource.sha256 &&
      info?.isFile() === true &&
      info.size === known.size &&
      info.mtimeMs === known.mtimeMs
    ) {
      stats.unchanged++
      continue
    }
    await ensureDirectory(paths.files, dirname(resource.path))
    if (info?.isDirectory()) {
      throw new UnsafePathError(`A directory exists where a file is expected: ${resource.path}`)
    }
    if (resource.kind === 'text') {
      await writeNoFollow(target, resource.content)
    } else {
      await writeNoFollow(target, { fromFile: await binaries.get(resource.s3Key, resource.sha256) })
    }
    await makeWritableForSandbox(target, false)
    const written = await stat(target)
    state.resources[resource.path] = {
      sha256: resource.sha256,
      size: written.size,
      mtimeMs: written.mtimeMs,
    }
    stats.written++
    stats.bytesWritten += written.size
  }

  state.lastUsedAt = Date.now()
  state.rootResourcePath = rootResourcePath
  await writeState(paths.state, state)
  return stats
}

/** Taille totale d'un répertoire, sans suivre les liens symboliques. */
export async function directorySize(path: string): Promise<number> {
  let total = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isDirectory()) total += await directorySize(child)
    else {
      const info = await lstatOrNull(child)
      total += info?.size ?? 0
    }
  }
  return total
}

export async function touchProject(paths: ProjectPaths): Promise<void> {
  const state = await readState(paths.state)
  state.lastUsedAt = Date.now()
  await writeState(paths.state, state).catch(() => undefined)
}

export async function readLastUsedAt(paths: ProjectPaths): Promise<number> {
  return (await readState(paths.state)).lastUsedAt
}

export async function readRootResourcePath(paths: ProjectPaths): Promise<string | null> {
  return (await readState(paths.state)).rootResourcePath ?? null
}

export function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}
