import { constants, createWriteStream } from 'node:fs'
import { type FileHandle, open } from 'node:fs/promises'
import { pipeline } from 'node:stream/promises'

/**
 * Lecture des sorties d'une compilation par l'agent. Dans le conteneur Cloudflare, l'agent (root)
 * partage le système de fichiers du processus TeX : une sortie remplacée par un lien symbolique
 * (vers `/proc/1/environ`, par exemple) ferait lire et publier un fichier réservé à root. Les
 * sorties sont donc ouvertes sans suivre de lien (`O_NOFOLLOW`), sans bloquer sur un tube
 * (`O_NONBLOCK`), puis vérifiées par `fstat` et lues par le même descripteur.
 */
const FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK

/** Ouvre un fichier régulier ; null pour un lien, un tube, un répertoire ou un fichier absent. */
export async function openRegularFile(path: string): Promise<FileHandle | null> {
  let handle: FileHandle
  try {
    handle = await open(path, FLAGS)
  } catch {
    return null
  }
  try {
    if ((await handle.stat()).isFile()) return handle
  } catch {
    // Fermé ci-dessous.
  }
  await handle.close()
  return null
}

/** Taille d'un fichier régulier, null sinon. */
export async function regularFileSize(path: string): Promise<number | null> {
  const handle = await openRegularFile(path)
  if (handle === null) return null
  try {
    return (await handle.stat()).size
  } finally {
    await handle.close()
  }
}

/** Contenu d'un fichier régulier, null sinon. */
export async function readRegularFile(path: string): Promise<Buffer | null> {
  const handle = await openRegularFile(path)
  if (handle === null) return null
  try {
    return await handle.readFile()
  } finally {
    await handle.close()
  }
}

/** Copie un fichier régulier ; lève une erreur si la source n'en est pas un. */
export async function copyRegularFile(source: string, target: string): Promise<void> {
  const handle = await openRegularFile(source)
  if (handle === null) throw new Error(`Not a regular file: ${source}`)
  try {
    await pipeline(handle.createReadStream({ autoClose: false }), createWriteStream(target))
  } finally {
    await handle.close()
  }
}
