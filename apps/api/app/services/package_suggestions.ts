import type { PackageSuggestion } from '@kaxolax/contracts'

/** Un fichier `.sty` ou `.cls` de l'index, avec les packages TeX Live qui le fournissent. */
export interface StyleEntry {
  /** Nom sans extension (`graphicx`), tel qu'écrit dans `\usepackage`. */
  name: string
  file: string
  kind: 'package' | 'class'
  packages: string[]
}

export const MAX_SUGGESTIONS = 5

/**
 * Distance d'édition de Damerau-Levenshtein restreinte (insertion, suppression, substitution,
 * transposition de deux lettres voisines) : `hyperef` → `hyperref` = 1, `amsmaht` → `amsmath`
 * = 1. S'arrête dès que la distance dépasse `max` (renvoie alors `max + 1`).
 */
export function editDistance(a: string, b: string, max = Number.POSITIVE_INFINITY): number {
  if (Math.abs(a.length - b.length) > max) return max + 1
  let previous2: number[] = []
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  for (let i = 1; i <= a.length; i++) {
    const current = [i]
    let rowMin = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      let value = Math.min(
        (previous[j] ?? 0) + 1,
        (current[j - 1] ?? 0) + 1,
        (previous[j - 1] ?? 0) + cost,
      )
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        value = Math.min(value, (previous2[j - 2] ?? 0) + 1)
      }
      current.push(value)
      rowMin = Math.min(rowMin, value)
    }
    if (rowMin > max) return max + 1
    previous2 = previous
    previous = current
  }
  return previous[b.length] ?? 0
}

/** Longueur du préfixe commun. */
function commonPrefix(a: string, b: string): number {
  let length = 0
  while (length < a.length && length < b.length && a[length] === b[length]) length++
  return length
}

/** Distance tolérée : une faute pour un nom court, jusqu'à trois pour un nom long. */
export function maxDistanceFor(query: string): number {
  if (query.length <= 4) return 1
  if (query.length <= 8) return 2
  return 3
}

/**
 * Packages courants : départagent deux candidats à la même distance (`graphix` est plus
 * probablement `graphicx` que `graphbox`). Liste courte et stable, pas une mesure d'usage.
 */
const COMMON = new Set([
  'amsmath',
  'amssymb',
  'amsthm',
  'babel',
  'biblatex',
  'booktabs',
  'caption',
  'cleveref',
  'csquotes',
  'enumitem',
  'fontenc',
  'fontspec',
  'geometry',
  'graphicx',
  'hyperref',
  'inputenc',
  'listings',
  'mathtools',
  'microtype',
  'natbib',
  'siunitx',
  'subcaption',
  'tikz',
  'xcolor',
  'article',
  'report',
  'book',
  'beamer',
])

interface Candidate {
  entry: StyleEntry
  distance: number
  /** Distance pour le tri : un préfixe éloigné (`hyper` → `hyperxmp`) suit les fautes de frappe. */
  rank: number
  prefix: boolean
  common: number
}

/**
 * Noms proches de `query` (sans extension) parmi les fichiers de l'index du même type : distance
 * d'édition (casse ignorée) au plus `maxDistanceFor(query)`, ou nom qui commence par la demande
 * (au moins trois lettres : `hyper` → `hyperref`). Tri : distance, préfixe, package courant,
 * préfixe commun le plus long, écart de longueur, ordre alphabétique.
 */
export function suggestPackages(
  query: string,
  kind: StyleEntry['kind'],
  entries: readonly StyleEntry[],
  describe: (packageName: string) => string | null,
  limit = MAX_SUGGESTIONS,
): PackageSuggestion[] {
  const wanted = query.toLowerCase()
  const max = maxDistanceFor(wanted)
  const candidates: Candidate[] = []
  for (const entry of entries) {
    if (entry.kind !== kind) continue
    const name = entry.name.toLowerCase()
    const prefix = wanted.length >= 3 && name.length > wanted.length && name.startsWith(wanted)
    const bounded = editDistance(wanted, name, max)
    if (bounded > max && !prefix) continue
    candidates.push({
      entry,
      distance: bounded > max ? editDistance(wanted, name) : bounded,
      rank: Math.min(bounded, max + 1),
      prefix,
      common: COMMON.has(name) ? 1 : 0,
    })
  }
  candidates.sort(
    (a, b) =>
      a.rank - b.rank ||
      Number(b.prefix) - Number(a.prefix) ||
      b.common - a.common ||
      commonPrefix(wanted, b.entry.name.toLowerCase()) -
        commonPrefix(wanted, a.entry.name.toLowerCase()) ||
      Math.abs(a.entry.name.length - wanted.length) -
        Math.abs(b.entry.name.length - wanted.length) ||
      a.entry.name.localeCompare(b.entry.name),
  )
  return candidates.slice(0, limit).map(({ entry, distance }) => {
    const packageName = entry.packages[0] ?? entry.name
    return {
      name: entry.name,
      file: entry.file,
      package: packageName,
      shortdesc: describe(packageName),
      distance,
    }
  })
}
