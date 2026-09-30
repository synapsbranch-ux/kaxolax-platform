/** Extensions traitées comme documents texte éditables (stockés dans Yjs). */
export const TEXT_DOCUMENT_EXTENSIONS = [
  '.tex',
  '.bib',
  '.cls',
  '.sty',
  '.bst',
  '.bbx',
  '.cbx',
  '.txt',
  '.md',
  '.csv',
] as const

/** Un document texte doit faire strictement moins de 2 Mo. */
export const MAX_TEXT_DOCUMENT_BYTES = 2 * 1024 * 1024

export function hasTextDocumentExtension(filename: string): boolean {
  const lower = filename.toLowerCase()
  return TEXT_DOCUMENT_EXTENSIONS.some((extension) => lower.endsWith(extension))
}

export function isValidUtf8(content: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(content)
    return true
  } catch {
    return false
  }
}

/**
 * Un fichier devient un document texte s'il a une extension texte, fait moins de 2 Mo et est
 * en UTF-8 valide. Tout le reste est un fichier binaire stocké dans S3.
 */
export function isTextDocument(filename: string, content: Uint8Array): boolean {
  return (
    hasTextDocumentExtension(filename) &&
    content.byteLength < MAX_TEXT_DOCUMENT_BYTES &&
    isValidUtf8(content)
  )
}

/** Taille maximale d'un fichier uploadé dans un projet. */
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024

/** Taille maximale d'un zip à importer (compressé). */
export const MAX_IMPORT_ZIP_BYTES = 500 * 1024 * 1024

/** Limites d'un import zip : fichiers et taille totale décompressée. */
export const ZIP_IMPORT_LIMITS = {
  maxFiles: 5_000,
  maxUncompressedBytes: 500 * 1024 * 1024,
} as const

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.tif': 'image/tiff',
  '.tiff': 'image/tiff',
  '.pdf': 'application/pdf',
  '.eps': 'application/postscript',
  '.ps': 'application/postscript',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.zip': 'application/zip',
  '.json': 'application/json',
  '.xml': 'application/xml',
}

/** Type MIME déduit de l'extension (jamais du contenu envoyé par le client). */
export function mimeTypeFor(filename: string): string {
  const dot = filename.lastIndexOf('.')
  if (dot === -1) return 'application/octet-stream'
  return MIME_TYPES[filename.slice(dot).toLowerCase()] ?? 'application/octet-stream'
}

/** Images affichables dans l'aperçu de l'arborescence. */
export function isPreviewableImage(mimeType: string): boolean {
  return ['image/png', 'image/jpeg', 'image/gif', 'image/svg+xml', 'image/webp'].includes(mimeType)
}
