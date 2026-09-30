/** Largeur à laquelle TeX coupe les lignes du log (max_print_line, 79 par défaut). */
export const DEFAULT_MAX_PRINT_LINE = 79

type WidthUnit = 'bytes' | 'characters'

const LF = 0x0a
const CR = 0x0d

const decoder = new TextDecoder('utf-8')
const encoder = new TextEncoder()

export function toBytes(input: string | Uint8Array): Uint8Array {
  return typeof input === 'string' ? encoder.encode(input) : input
}

/**
 * pdfTeX (et TeX, e-TeX) coupe les lignes à 79 octets, y compris au milieu d'un caractère UTF-8 ;
 * XeTeX et LuaTeX coupent à 79 caractères. Le moteur se lit sur la première ligne du log.
 */
function widthUnit(firstLine: string): WidthUnit {
  return /^This is (?:XeTeX|LuaHBTeX|LuaTeX|LuaJITTeX)/.test(firstLine) ? 'characters' : 'bytes'
}

function splitRawLines(bytes: Uint8Array): Uint8Array[] {
  const lines: Uint8Array[] = []
  let start = 0
  for (let index = 0; index <= bytes.length; index++) {
    if (index === bytes.length || bytes[index] === LF) {
      let end = index
      if (end > start && bytes[end - 1] === CR) end--
      lines.push(bytes.subarray(start, end))
      start = index + 1
    }
  }
  return lines
}

function characterCount(line: Uint8Array): number {
  // Un octet de continuation UTF-8 (10xxxxxx) n'ouvre pas de nouveau caractère.
  let count = 0
  for (const byte of line) {
    if ((byte & 0xc0) !== 0x80) count++
  }
  return count
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0)
  const result = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    result.set(part, offset)
    offset += part.length
  }
  return result
}

/**
 * Recolle les lignes coupées par TeX et renvoie les lignes logiques, décodées en UTF-8.
 * Une ligne qui fait exactement `maxPrintLine` unités est considérée comme coupée.
 */
export function logicalLines(
  input: string | Uint8Array,
  maxPrintLine: number = DEFAULT_MAX_PRINT_LINE,
): string[] {
  const raw = splitRawLines(toBytes(input))
  const firstLine = raw[0] === undefined ? '' : decoder.decode(raw[0])
  const unit = widthUnit(firstLine)
  const width = (line: Uint8Array) => (unit === 'bytes' ? line.length : characterCount(line))

  const lines: string[] = []
  let pending: Uint8Array[] = []
  for (const line of raw) {
    pending.push(line)
    if (width(line) === maxPrintLine) continue
    lines.push(decoder.decode(concat(pending)))
    pending = []
  }
  if (pending.length > 0) lines.push(decoder.decode(concat(pending)))
  return lines
}

/** Découpe un log sans recoller les lignes (logs BibTeX et Biber). */
export function plainLines(input: string | Uint8Array): string[] {
  const text = typeof input === 'string' ? input : decoder.decode(input)
  return text.split(/\r?\n/)
}
