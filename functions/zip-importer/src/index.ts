import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pipeline as streamPipeline, type Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  type Compiler,
  hasTextDocumentExtension,
  isSafeRelativePath,
  isValidUtf8,
  MAX_TEXT_DOCUMENT_BYTES,
  mimeTypeFor,
  ZIP_IMPORT_LIMITS,
} from '@kaxolax/contracts'
import yauzl, { type Entry, type ZipFile } from 'yauzl'

export interface ZipLimits {
  maxFiles: number
  maxUncompressedBytes: number
}

export type ZipRejection =
  | 'E_ZIP_INVALID'
  | 'E_ZIP_UNSAFE_PATH'
  | 'E_ZIP_INVALID_NAME'
  | 'E_ZIP_DUPLICATE_PATH'
  | 'E_ZIP_TOO_MANY_FILES'
  | 'E_ZIP_TOO_LARGE'
  | 'E_ZIP_ENCRYPTED'
  | 'E_ZIP_EMPTY'

export class ZipImportError extends Error {
  constructor(
    readonly code: ZipRejection,
    message: string,
  ) {
    super(message)
    this.name = 'ZipImportError'
  }
}

export interface ImportedDocument {
  path: string
  content: string
  sha256: string
}

export interface ImportedBinary<Stored> {
  path: string
  sha256: string
  sizeBytes: number
  mimeType: string
  /** Ce que `storeBinary` a renvoyé (clé S3, identifiant…). */
  stored: Stored
}

export interface ImportResult<Stored> {
  /** Tous les dossiers, parents avant enfants. */
  folders: string[]
  documents: ImportedDocument[]
  binaries: ImportedBinary<Stored>[]
  /** main.tex à la racine s'il existe, sinon le premier .tex qui contient \documentclass. */
  mainDocumentPath: string | null
  compiler: Compiler
}

/** Reçoit le contenu d'un fichier binaire ; doit consommer `body` entièrement. */
export type StoreBinary<Stored> = (file: {
  path: string
  sizeBytes: number
  mimeType: string
  body: Readable
}) => Promise<Stored>

/** Fichiers ajoutés par les systèmes d'exploitation, ignorés à l'import. */
function isJunk(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  return path.startsWith('__MACOSX/') || name === '.DS_Store' || name === 'Thumbs.db'
}

const S_IFMT = 0o170000
const S_IFLNK = 0o120000

function isSymlink(entry: Entry): boolean {
  // Attributs Unix dans les 16 bits de poids fort (zip créé sous Unix, « version made by » 3).
  return (
    entry.versionMadeBy >> 8 === 3 && ((entry.externalFileAttributes >>> 16) & S_IFMT) === S_IFLNK
  )
}

function assertSafePath(path: string): void {
  // Sortie du projet (chemin absolu, segment « .. », antislash) : refus de tout le zip.
  if (/^([a-zA-Z]:)?[/\\]/.test(path) || path.includes('\\') || path.split('/').includes('..')) {
    throw new ZipImportError('E_ZIP_UNSAFE_PATH', `Unsafe path in the zip: ${path}`)
  }
  if (!isSafeRelativePath(path)) {
    throw new ZipImportError('E_ZIP_INVALID_NAME', `Invalid file name in the zip: ${path}`)
  }
}

/** Erreurs de yauzl : chemins refusés par sa propre validation, ou archive illisible. */
function translateZipError(error: unknown): ZipImportError {
  if (error instanceof ZipImportError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/^(invalid relative path|absolute path|invalid characters in fileName)/.test(message)) {
    return new ZipImportError('E_ZIP_UNSAFE_PATH', message)
  }
  if (/too many bytes|too few bytes|exceeds/.test(message)) {
    return new ZipImportError('E_ZIP_TOO_LARGE', message)
  }
  return new ZipImportError('E_ZIP_INVALID', message)
}

function parentsOf(path: string): string[] {
  const segments = path.split('/').slice(0, -1)
  return segments.map((_, index) => segments.slice(0, index + 1).join('/'))
}

/** Un `\documentclass` qui n'est pas en commentaire. */
const DOCUMENT_CLASS = /^[^%\n]*\\documentclass\b/m

function uncommented(content: string): string {
  return content.replace(/(^|[^\\])%.*$/gm, '$1')
}

/**
 * Compilateur probable, d'après les paquets du document principal : fontspec et consorts
 * exigent XeLaTeX ou LuaLaTeX, et un projet exporté ne dit pas avec quoi il compilait.
 */
export function detectCompiler(mainContent: string | null): Compiler {
  if (mainContent === null) return 'pdflatex'
  const source = uncommented(mainContent)
  const packages = [
    ...source.matchAll(/\\(?:usepackage|RequirePackage)\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g),
  ]
    .flatMap((match) => (match[1] ?? '').split(','))
    .map((name) => name.trim())
  if (
    /\\directlua\b/.test(source) ||
    packages.some((name) =>
      ['luacode', 'luatexja', 'luaotfload', 'lua-ul', 'luamplib'].includes(name),
    )
  ) {
    return 'lualatex'
  }
  if (
    packages.some((name) =>
      [
        'fontspec',
        'unicode-math',
        'polyglossia',
        'xeCJK',
        'xltxtra',
        'xunicode',
        'mathspec',
      ].includes(name),
    )
  ) {
    return 'xelatex'
  }
  return 'pdflatex'
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = []
  for await (const chunk of stream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

interface PlannedFile {
  entry: Entry
  path: string
}

async function listEntries(zip: ZipFile, limits: ZipLimits) {
  // Borne grossière avant de parcourir le répertoire central : dossiers compris.
  if (zip.entryCount > limits.maxFiles * 2) {
    throw new ZipImportError(
      'E_ZIP_TOO_MANY_FILES',
      `The zip contains more than ${String(limits.maxFiles)} files`,
    )
  }
  const files: PlannedFile[] = []
  const folders = new Set<string>()
  const paths = new Set<string>()
  let declaredBytes = 0
  for await (const entry of zip.eachEntry()) {
    const raw = entry.fileName
    if (isJunk(raw)) continue
    const isDirectory = raw.endsWith('/')
    const path = isDirectory ? raw.slice(0, -1) : raw
    if (path === '') continue
    assertSafePath(path)
    if (isSymlink(entry)) {
      throw new ZipImportError('E_ZIP_UNSAFE_PATH', `Symbolic links are not allowed: ${path}`)
    }
    if (isDirectory) {
      folders.add(path)
      continue
    }
    if (!entry.canDecodeFileData()) {
      throw new ZipImportError('E_ZIP_ENCRYPTED', `Encrypted or unsupported entry: ${path}`)
    }
    if (paths.has(path)) throw new ZipImportError('E_ZIP_DUPLICATE_PATH', `Duplicate path: ${path}`)
    paths.add(path)
    if (paths.size > limits.maxFiles) {
      throw new ZipImportError(
        'E_ZIP_TOO_MANY_FILES',
        `The zip contains more than ${String(limits.maxFiles)} files`,
      )
    }
    // La taille annoncée est vérifiée à la lecture (validateEntrySizes) : une entrée qui ment
    // sur sa taille est rejetée dès qu'elle la dépasse.
    declaredBytes += entry.uncompressedSize
    if (declaredBytes > limits.maxUncompressedBytes) {
      throw new ZipImportError('E_ZIP_TOO_LARGE', 'The zip is too large once uncompressed')
    }
    files.push({ entry, path })
  }
  for (const { path } of files) for (const parent of parentsOf(path)) folders.add(parent)
  for (const folder of folders) {
    if (paths.has(folder)) {
      throw new ZipImportError(
        'E_ZIP_DUPLICATE_PATH',
        `A file and a folder share the path: ${folder}`,
      )
    }
  }
  if (files.length === 0) throw new ZipImportError('E_ZIP_EMPTY', 'The zip contains no files')
  return { files, folders: [...folders] }
}

/**
 * Un zip dont tout le contenu est dans un seul dossier (archive d'un dossier) est importé comme
 * si ce dossier était la racine du projet.
 */
function stripCommonRoot(
  files: PlannedFile[],
  folders: string[],
): { files: PlannedFile[]; folders: string[] } {
  const [first] = files
  if (!first?.path.includes('/')) return { files, folders }
  const root = first.path.slice(0, first.path.indexOf('/') + 1)
  if (!files.every((file) => file.path.startsWith(root))) return { files, folders }
  if (!folders.every((folder) => folder === root.slice(0, -1) || folder.startsWith(root))) {
    return { files, folders }
  }
  return {
    files: files.map((file) => ({ ...file, path: file.path.slice(root.length) })),
    folders: folders
      .filter((folder) => folder.startsWith(root))
      .map((folder) => folder.slice(root.length)),
  }
}

const byDepthThenPath = (a: string, b: string) =>
  a.split('/').length - b.split('/').length || (a < b ? -1 : a > b ? 1 : 0)

function findMainDocument(documents: ImportedDocument[]): ImportedDocument | null {
  const root = documents.find((document) => document.path === 'main.tex')
  if (root) return root
  const candidates = documents
    .filter(
      (document) =>
        document.path.toLowerCase().endsWith('.tex') && DOCUMENT_CLASS.test(document.content),
    )
    .sort((a, b) => byDepthThenPath(a.path, b.path))
  return candidates[0] ?? null
}

/** Plafond du texte gardé en mémoire pendant un import (documents Yjs créés ensuite). */
export const MAX_IMPORTED_TEXT_BYTES = 100 * 1024 * 1024

interface ExtractedBinary {
  path: string
  sha256: string
  sizeBytes: number
  mimeType: string
  file: string
}

/**
 * Lit un zip de projet en deux phases. D'abord, tout le zip est vérifié : répertoire central
 * (chemins, doublons, nombre de fichiers, taille annoncée), puis chaque entrée lue en entier avec
 * contrôle de sa taille réelle ; les binaires sont extraits dans un répertoire temporaire. Ensuite
 * seulement, les binaires sont confiés à `storeBinary` : un zip refusé n'envoie rien vers S3.
 * En cas d'erreur pendant la deuxième phase, l'appelant supprime ce qui a déjà été stocké.
 */
export async function importZip<Stored>(
  zipPath: string,
  storeBinary: StoreBinary<Stored>,
  limits: ZipLimits = ZIP_IMPORT_LIMITS,
): Promise<ImportResult<Stored>> {
  const workDir = await mkdtemp(join(tmpdir(), 'kaxolax-zip-'))
  try {
    const { folders, documents, extracted } = await extract(zipPath, workDir, limits)
    const binaries: ImportedBinary<Stored>[] = []
    for (const binary of extracted) {
      const stored = await storeBinary({
        path: binary.path,
        sizeBytes: binary.sizeBytes,
        mimeType: binary.mimeType,
        body: createReadStream(binary.file),
      })
      const { file, ...rest } = binary
      binaries.push({ ...rest, stored })
      await rm(file, { force: true })
    }
    const main = findMainDocument(documents)
    return {
      folders: folders.sort(byDepthThenPath),
      documents: documents.sort((a, b) => byDepthThenPath(a.path, b.path)),
      binaries: binaries.sort((a, b) => byDepthThenPath(a.path, b.path)),
      mainDocumentPath: main?.path ?? null,
      compiler: detectCompiler(main?.content ?? null),
    }
  } finally {
    await rm(workDir, { recursive: true, force: true })
  }
}

async function extract(zipPath: string, workDir: string, limits: ZipLimits) {
  let zip: ZipFile
  try {
    zip = await yauzl.openPromise(zipPath, {
      autoClose: false,
      validateEntrySizes: true,
      strictFileNames: false,
    })
  } catch (error) {
    throw translateZipError(error)
  }
  try {
    const listed = await listEntries(zip, limits).catch((error: unknown) => {
      throw translateZipError(error)
    })
    const { files, folders } = stripCommonRoot(listed.files, listed.folders)
    const documents: ImportedDocument[] = []
    const extracted: ExtractedBinary[] = []
    let totalBytes = 0
    let textBytes = 0

    for (const [index, { entry, path }] of files.entries()) {
      const sizeBytes = entry.uncompressedSize
      const mimeType = mimeTypeFor(path)
      const hash = createHash('sha256')
      let counted = 0
      const counter = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          counted += chunk.byteLength
          totalBytes += chunk.byteLength
          // yauzl vérifie déjà la taille annoncée ; ce compteur borne aussi le total.
          if (counted > sizeBytes || totalBytes > limits.maxUncompressedBytes) {
            callback(
              new ZipImportError('E_ZIP_TOO_LARGE', 'The zip is too large once uncompressed'),
            )
            return
          }
          hash.update(chunk)
          callback(null, chunk)
        },
      })
      try {
        const source = await zip.openReadStreamPromise(entry)
        if (hasTextDocumentExtension(path) && sizeBytes < MAX_TEXT_DOCUMENT_BYTES) {
          const content = await readAll(streamPipeline(source, counter, () => undefined))
          const sha256 = hash.digest('hex')
          if (isValidUtf8(content)) {
            textBytes += content.byteLength
            if (textBytes > MAX_IMPORTED_TEXT_BYTES) {
              throw new ZipImportError('E_ZIP_TOO_LARGE', 'The zip contains too much text')
            }
            documents.push({ path, content: content.toString('utf8'), sha256 })
            continue
          }
          const file = join(workDir, String(index))
          await writeFile(file, content, { flag: 'wx', mode: 0o600 })
          extracted.push({ path, sha256, sizeBytes, mimeType, file })
          continue
        }
        const file = join(workDir, String(index))
        await pipeline(source, counter, createWriteStream(file, { flags: 'wx', mode: 0o600 }))
        if (counted !== sizeBytes) {
          throw new ZipImportError('E_ZIP_INVALID', `Entry is shorter than announced: ${path}`)
        }
        extracted.push({ path, sha256: hash.digest('hex'), sizeBytes, mimeType, file })
      } catch (error) {
        throw translateZipError(error)
      }
    }
    return { folders, documents, extracted }
  } finally {
    zip.close()
  }
}
