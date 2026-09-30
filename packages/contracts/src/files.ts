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
