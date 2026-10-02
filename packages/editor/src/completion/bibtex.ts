/**
 * Analyse BibTeX et biblatex tolérante : entrées `@type{clé, champ = valeur, …}` ou avec
 * parenthèses, `@string`, `@preamble`, `@comment`, valeurs entre accolades (imbriquées), entre
 * guillemets, nombres, macros et concaténations `#`. Le texte hors entrées est ignoré (comme
 * BibTeX) ; une entrée mal formée est signalée et l'analyse reprend à l'entrée suivante.
 */

export interface BibEntry {
  key: string
  /** Type en minuscules (`article`, `book`, `online`…). */
  type: string
  /** Champs en minuscules, valeurs avec macros résolues et accolades conservées. */
  fields: Record<string, string>
  /** Début de `@` et fin de l'entrée dans le texte. */
  from: number
  to: number
  /** Ligne de `@` (1 = première). */
  line: number
}

export interface BibParseError {
  /** Position de l'erreur dans le texte. */
  offset: number
  line: number
  message: string
}

export interface BibParseResult {
  entries: BibEntry[]
  /** Macros définies par `@string`. */
  strings: Record<string, string>
  errors: BibParseError[]
}

const MONTHS: Record<string, string> = {
  jan: 'January',
  feb: 'February',
  mar: 'March',
  apr: 'April',
  may: 'May',
  jun: 'June',
  jul: 'July',
  aug: 'August',
  sep: 'September',
  oct: 'October',
  nov: 'November',
  dec: 'December',
}

/** Caractères d'un identifiant BibTeX (type, nom de champ, macro). */
const IDENTIFIER = /[^\s"#%'(),={}]+/y
/** Clé d'entrée : tout sauf blancs, virgule et délimiteurs. */
const KEY = /[^\s,{}()"#%]+/y

class BibSyntaxError extends Error {
  constructor(
    readonly offset: number,
    message: string,
  ) {
    super(message)
  }
}

function lineStarts(text: string): number[] {
  const starts = [0]
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1)
  return starts
}

function lineAt(starts: readonly number[], offset: number): number {
  let low = 0
  let high = starts.length - 1
  while (low < high) {
    const middle = (low + high + 1) >> 1
    if ((starts[middle] ?? 0) <= offset) low = middle
    else high = middle - 1
  }
  return low + 1
}

class Parser {
  position = 0
  readonly strings: Record<string, string> = { ...MONTHS }

  constructor(readonly text: string) {}

  skipSpaces(): void {
    while (this.position < this.text.length) {
      const code = this.text.charCodeAt(this.position)
      // Un `%` hors valeur commence un commentaire (biblatex, et BibTeX en pratique).
      if (code === 37) {
        const newline = this.text.indexOf('\n', this.position)
        this.position = newline === -1 ? this.text.length : newline + 1
      } else if (code === 32 || code === 9 || code === 10 || code === 13 || code === 12) {
        this.position++
      } else return
    }
  }

  read(pattern: RegExp): string | null {
    pattern.lastIndex = this.position
    const match = pattern.exec(this.text)
    if (!match) return null
    this.position = pattern.lastIndex
    return match[0]
  }

  expect(char: string): void {
    this.skipSpaces()
    if (this.text[this.position] !== char) {
      throw new BibSyntaxError(this.position, `Expected "${char}"`)
    }
    this.position++
  }

  /** Groupe entre accolades qui commence à la position courante : contenu sans les accolades. */
  braced(): string {
    const start = this.position
    let depth = 0
    for (let i = start; i < this.text.length; i++) {
      const char = this.text[i]
      if (char === '\\') i++
      else if (char === '{') depth++
      else if (char === '}') {
        depth--
        if (depth === 0) {
          this.position = i + 1
          return this.text.slice(start + 1, i)
        }
      } else if (char === '@' && depth === 1 && /\n\s*$/.test(this.text.slice(start, i))) {
        // `@` en début de ligne au premier niveau : l'entrée précédente n'a pas été fermée.
        break
      }
    }
    throw new BibSyntaxError(start, 'Unclosed brace')
  }

  /** Chaîne entre guillemets (les accolades y protègent les `"`). */
  quoted(): string {
    const start = this.position
    let depth = 0
    for (let i = start + 1; i < this.text.length; i++) {
      const char = this.text[i]
      if (char === '\\') i++
      else if (char === '{') depth++
      else if (char === '}') depth = Math.max(0, depth - 1)
      else if (char === '"' && depth === 0) {
        this.position = i + 1
        return this.text.slice(start + 1, i)
      }
    }
    throw new BibSyntaxError(start, 'Unclosed quote')
  }

  /** Valeur d'un champ : morceaux concaténés par `#`. */
  value(): string {
    let result = ''
    for (;;) {
      this.skipSpaces()
      const char = this.text[this.position]
      if (char === '{') result += this.braced()
      else if (char === '"') result += this.quoted()
      else {
        const word = this.read(IDENTIFIER)
        if (word === null) throw new BibSyntaxError(this.position, 'Expected a value')
        result += /^\d+$/.test(word) ? word : (this.strings[word.toLowerCase()] ?? word)
      }
      this.skipSpaces()
      if (this.text[this.position] !== '#') return result
      this.position++
    }
  }

  /** Champs `nom = valeur` séparés par des virgules, jusqu'au délimiteur fermant. */
  fields(close: string): Record<string, string> {
    const fields: Record<string, string> = {}
    for (;;) {
      this.skipSpaces()
      const char = this.text[this.position]
      if (char === close) {
        this.position++
        return fields
      }
      if (char === ',') {
        this.position++
        continue
      }
      if (char === '@' || char === undefined) {
        throw new BibSyntaxError(this.position, `Expected "${close}"`)
      }
      const name = this.read(IDENTIFIER)
      if (name === null) throw new BibSyntaxError(this.position, 'Expected a field name')
      this.expect('=')
      const value = this.value()
      const key = name.toLowerCase()
      if (!(key in fields)) fields[key] = value
    }
  }
}

/** Analyse un fichier .bib. Ne lève jamais : les erreurs sont renvoyées avec les entrées valides. */
export function parseBibtex(text: string): BibParseResult {
  const parser = new Parser(text)
  const entries: BibEntry[] = []
  const errors: BibParseError[] = []
  const seen = new Set<string>()
  let starts: number[] | null = null
  const line = (offset: number) => lineAt((starts ??= lineStarts(text)), offset)

  for (let at = text.indexOf('@'); at !== -1; at = text.indexOf('@', parser.position)) {
    parser.position = at + 1
    // `@` dans une ligne commentée par `%` (hors entrée) : ignoré, comme biber et les éditeurs.
    if (text.slice(text.lastIndexOf('\n', at) + 1, at).includes('%')) continue
    parser.skipSpaces()
    const type = parser.read(IDENTIFIER)?.toLowerCase()
    parser.skipSpaces()
    const open = text[parser.position]
    // `@` hors entrée (adresse email dans un commentaire…) : ignoré.
    if (type === undefined || (open !== '{' && open !== '(')) {
      parser.position = at + 1
      continue
    }
    const close = open === '{' ? '}' : ')'
    try {
      if (type === 'comment') {
        if (open === '{') parser.braced()
        else {
          const end = text.indexOf(')', parser.position)
          parser.position = end === -1 ? text.length : end + 1
        }
        continue
      }
      parser.position++
      if (type === 'preamble') {
        parser.value()
        parser.expect(close)
        continue
      }
      if (type === 'string') {
        const fields = parser.fields(close)
        for (const [name, value] of Object.entries(fields)) parser.strings[name] = value
        continue
      }
      parser.skipSpaces()
      const keyStart = parser.position
      const key = parser.read(KEY)
      if (key === null) throw new BibSyntaxError(keyStart, 'Missing entry key')
      parser.skipSpaces()
      let fields: Record<string, string> = {}
      // `@misc{clé}` : entrée sans champ, fermée juste après la clé.
      if (text[parser.position] === close) parser.position++
      else {
        parser.expect(',')
        fields = parser.fields(close)
      }
      if (seen.has(key)) {
        errors.push({ offset: keyStart, line: line(keyStart), message: `Duplicate key "${key}"` })
        continue
      }
      seen.add(key)
      entries.push({ key, type, fields, from: at, to: parser.position, line: line(at) })
    } catch (error) {
      if (!(error instanceof BibSyntaxError)) throw error
      errors.push({ offset: error.offset, line: line(error.offset), message: error.message })
      // Reprise : prochain `@` en début de ligne après le début de l'entrée fautive.
      const next = /\n[ \t]*@/g
      next.lastIndex = at + 1
      const match = next.exec(text)
      parser.position = match ? match.index + match[0].length - 1 : text.length
    }
  }
  return { entries, strings: parser.strings, errors }
}

const ACCENTS: Record<string, Record<string, string>> = {
  "'": { a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', y: 'ý', c: 'ć', n: 'ń', E: 'É', A: 'Á', O: 'Ó' },
  '`': { a: 'à', e: 'è', i: 'ì', o: 'ò', u: 'ù', A: 'À', E: 'È' },
  '^': { a: 'â', e: 'ê', i: 'î', o: 'ô', u: 'û', A: 'Â', E: 'Ê', I: 'Î', O: 'Ô', U: 'Û' },
  '"': { a: 'ä', e: 'ë', i: 'ï', o: 'ö', u: 'ü', y: 'ÿ', A: 'Ä', O: 'Ö', U: 'Ü' },
  '~': { a: 'ã', n: 'ñ', o: 'õ', N: 'Ñ' },
  c: { c: 'ç', C: 'Ç', s: 'ş' },
}

const SYMBOLS: Record<string, string> = {
  ss: 'ß',
  o: 'ø',
  O: 'Ø',
  ae: 'æ',
  AE: 'Æ',
  oe: 'œ',
  OE: 'Œ',
  aa: 'å',
  AA: 'Å',
  l: 'ł',
  L: 'Ł',
  i: 'ı',
}

/**
 * Texte lisible d'une valeur BibTeX (affichage dans l'autocomplétion) : accents LaTeX courants
 * convertis, accolades et commandes de mise en forme retirées, blancs normalisés.
 */
export function bibtexToText(value: string): string {
  return value
    .replace(/\\([`'^"~])\s*\{?\\?([a-zA-Z])\}?/g, (match, accent: string, letter: string) => {
      return ACCENTS[accent]?.[letter] ?? match
    })
    .replace(/\\c\s*\{?([a-zA-Z])\}?/g, (match, letter: string) => ACCENTS.c?.[letter] ?? match)
    .replace(/\\(ss|ae|AE|oe|OE|aa|AA|[oOlLi])(?![a-zA-Z])\s*/g, (match, name: string) => {
      return SYMBOLS[name] ?? match
    })
    .replace(/\\(La)?TeX(?![a-zA-Z])\s*/g, (_match, la: string | undefined) => `${la ?? ''}TeX`)
    .replace(/\\[&%$#_]/g, (match) => match.slice(1))
    .replace(/\\[a-zA-Z]+\*?\s*/g, '')
    .replace(/[{}]/g, '')
    .replace(/~/g, ' ')
    .replace(/--/g, '–')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Auteurs abrégés : « Nom », « Nom et Nom », ou « Nom et al. ». */
export function shortAuthors(authors: string): string {
  const names = bibtexToText(authors)
    .split(/\s+and\s+/i)
    .map((name) => {
      const trimmed = name.trim()
      if (trimmed.includes(',')) return trimmed.slice(0, trimmed.indexOf(',')).trim()
      return trimmed.split(/\s+/).at(-1) ?? trimmed
    })
    .filter((name) => name !== '' && name.toLowerCase() !== 'others')
  if (names.length === 0) return ''
  if (names.length === 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0] ?? ''} & ${names[1] ?? ''}`
  return `${names[0] ?? ''} et al.`
}
