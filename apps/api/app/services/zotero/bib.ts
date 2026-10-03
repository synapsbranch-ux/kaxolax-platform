/**
 * Lecture minimale d'un texte BibTeX/BibLaTeX pour la synchronisation Zotero : clés et étendue des
 * entrées (`@type{clé, …}` ou `@type(clé, …)`, accolades imbriquées). `@string`, `@preamble` et
 * `@comment` ne sont pas des entrées. L'analyse complète (champs, macros) est celle de l'éditeur
 * (`@kaxolax/editor`, completion/bibtex.ts) ; l'API n'a besoin que des clés.
 */

export interface BibEntryRange {
  key: string
  /** Position de `@` et fin de l'entrée (après le délimiteur fermant). */
  from: number
  to: number
}

const NON_ENTRIES = new Set(['string', 'preamble', 'comment'])
const HEAD = /@\s*([A-Za-z]+)\s*([{(])\s*/y
const KEY = /([^\s,{}()"#%]+)\s*,/y

/** Fin d'un bloc ouvert par `open` à `start` (position après le fermant), ou -1. */
function blockEnd(text: string, start: number, open: string): number {
  const close = open === '{' ? '}' : ')'
  let depth = 0
  for (let index = start; index < text.length; index++) {
    const char = text[index]
    if (char === '{') depth++
    else if (char === '}') depth--
    if (open === '(' && char === close && depth === 0) return index + 1
    if (open === '{' && depth === 0) return index + 1
    if (depth < 0) return -1
  }
  return -1
}

/** Entrées du texte, dans l'ordre. Une entrée mal formée est ignorée. */
export function bibEntries(text: string): BibEntryRange[] {
  const entries: BibEntryRange[] = []
  let position = text.indexOf('@')
  while (position !== -1) {
    HEAD.lastIndex = position
    const head = HEAD.exec(text)
    if (!head?.[1] || !head[2]) {
      position = text.indexOf('@', position + 1)
      continue
    }
    const type = head[1].toLowerCase()
    const openAt = position + head[0].trimEnd().length - 1
    const end = blockEnd(text, openAt, head[2])
    if (!NON_ENTRIES.has(type)) {
      KEY.lastIndex = HEAD.lastIndex
      const key = KEY.exec(text)?.[1]
      if (key !== undefined && end !== -1) entries.push({ key, from: position, to: end })
    }
    position = text.indexOf('@', end === -1 ? position + 1 : end)
  }
  return entries
}

/** Clés des entrées du texte. */
export function bibKeys(text: string): Set<string> {
  return new Set(bibEntries(text).map((entry) => entry.key))
}

/** Première entrée d'un export (un seul élément), avec son texte. */
export function firstBibEntry(text: string): { key: string; text: string } | null {
  const [entry] = bibEntries(text)
  return entry ? { key: entry.key, text: text.slice(entry.from, entry.to) } : null
}

/** En-tête du `.bib` géré par la synchronisation. */
export const MANAGED_BIB_HEADER =
  '% Bibliographie synchronisée depuis Zotero par Kaxolax : les modifications faites ici sont\n' +
  '% remplacées à la prochaine synchronisation (relier le projet à une autre collection ou\n' +
  '% ajouter des références dans Zotero).\n'

/** Entrée d'un élément Zotero exportée seule (clé d'élément, texte BibTeX/BibLaTeX). */
export interface ItemEntry {
  itemKey: string
  text: string
}

/** Suffixes de désambiguïsation, comme ceux du traducteur de Zotero : a, b, …, z, aa, ab, … */
function suffix(index: number): string {
  let value = index
  let result = ''
  do {
    result = String.fromCharCode(97 + (value % 26)) + result
    value = Math.floor(value / 26) - 1
  } while (value >= 0)
  return result
}

/**
 * Clé de citation d'un élément : la clé déjà attribuée (`previous`) si elle est libre et dérive
 * toujours de celle produite par Zotero (`base`, éventuellement suivie d'un suffixe), sinon `base`
 * si elle est libre, sinon `base` suivie du premier suffixe libre (`smith2020a`, …).
 */
export function assignCitationKey(
  base: string,
  previous: string | undefined,
  taken: ReadonlySet<string>,
): string {
  if (
    previous !== undefined &&
    !taken.has(previous) &&
    previous.startsWith(base) &&
    /^[a-z]*$/.test(previous.slice(base.length))
  ) {
    return previous
  }
  if (!taken.has(base)) return base
  for (let index = 0; ; index++) {
    const candidate = `${base}${suffix(index)}`
    if (!taken.has(candidate)) return candidate
  }
}

/** Texte d'une entrée avec une autre clé de citation. */
export function withCitationKey(entry: string, key: string): string {
  return entry.replace(/^(\s*@\s*[A-Za-z]+\s*[{(]\s*)[^\s,{}()"#%]+/, (_match, head: string) => {
    return `${head}${key}`
  })
}

/**
 * Texte du `.bib` synchronisé : en-tête, puis une entrée par élément Zotero (le premier de chaque
 * clé d'élément l'emporte : la collection, puis les éléments ajoutés par le sélecteur). Les clés
 * de citation sont uniques dans le fichier : un élément garde la clé qu'il avait (`previous`,
 * clé d'élément → clé de citation), les autres prennent celle de Zotero ou, si un autre élément
 * l'a déjà, la même suivie d'un suffixe. Deux références distinctes ne partagent donc jamais une
 * clé, et `\cite{…}` continue de désigner le même élément d'une synchro à l'autre. Renvoie aussi
 * les clés attribuées (à enregistrer sur le lien) et les collisions résolues (journal).
 * `reserved` : clés d'autres fichiers (autres `.bib` du projet), qu'une clé nouvellement
 * attribuée ne prend pas ; une clé déjà attribuée reste (`\cite{…}` stables).
 */
export function managedBibliography(
  entries: readonly ItemEntry[],
  previous: Readonly<Record<string, string>>,
  reserved: ReadonlySet<string> = new Set(),
): { content: string; citationKeys: Record<string, string>; renamed: number } {
  const items: { itemKey: string; base: string; text: string }[] = []
  const seen = new Set<string>()
  for (const entry of entries) {
    if (seen.has(entry.itemKey)) continue
    const parsed = firstBibEntry(entry.text)
    if (!parsed) continue
    seen.add(entry.itemKey)
    items.push({ itemKey: entry.itemKey, base: parsed.key, text: parsed.text })
  }
  const taken = new Set<string>()
  const assigned = new Map<string, string>()
  // Les clés déjà attribuées d'abord : un nouvel élément ne prend jamais la clé d'un ancien.
  for (const item of items) {
    const kept = previous[item.itemKey]
    if (kept === undefined) continue
    const key = assignCitationKey(item.base, kept, taken)
    if (key !== kept) continue
    taken.add(key)
    assigned.set(item.itemKey, key)
  }
  for (const key of reserved) taken.add(key)
  let renamed = 0
  for (const item of items) {
    if (assigned.has(item.itemKey)) continue
    const key = assignCitationKey(item.base, undefined, taken)
    if (key !== item.base) renamed++
    taken.add(key)
    assigned.set(item.itemKey, key)
  }
  const citationKeys: Record<string, string> = {}
  const parts = items.map((item) => {
    const key = assigned.get(item.itemKey) ?? item.base
    citationKeys[item.itemKey] = key
    return key === item.base ? item.text : withCitationKey(item.text, key)
  })
  const body = parts.join('\n\n')
  return {
    content: body === '' ? MANAGED_BIB_HEADER : `${MANAGED_BIB_HEADER}\n${body}\n`,
    citationKeys,
    renamed,
  }
}

/** Ajoute une entrée à la fin d'un `.bib` (une ligne vide avant). */
export function appendBibEntry(text: string, entry: string): string {
  const head = text.trimEnd()
  return `${head === '' ? '' : `${head}\n\n`}${entry.trim()}\n`
}

/** Auteurs abrégés : « Lovelace », « Lovelace et Babbage », « Lovelace et al. ». */
export function shortCreators(
  creators: readonly { lastName?: string; name?: string; creatorType?: string }[],
): string {
  const authors = creators.filter(
    (creator) => creator.creatorType === undefined || creator.creatorType === 'author',
  )
  const names = (authors.length > 0 ? authors : creators)
    .map((creator) => (creator.lastName ?? '') || (creator.name ?? ''))
    .filter((name) => name !== '')
  if (names.length === 0) return ''
  if (names.length === 1) return names[0] ?? ''
  if (names.length === 2) return `${names[0] ?? ''} et ${names[1] ?? ''}`
  return `${names[0] ?? ''} et al.`
}

/** Année d'une date Zotero (« 2020-03-01 », « March 2020 »), null sinon. */
export function yearOf(date: string): string | null {
  return /\b(\d{4})\b/.exec(date)?.[1] ?? null
}
