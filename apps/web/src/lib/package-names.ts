import { MAX_MATCHING_STYLES, type TexlivePackageList } from '@kaxolax/contracts'

/** Résultats demandés à l'index TeX Live pour un début de nom. */
export const PACKAGE_NAME_PAGE = 50

/**
 * Noms de packages TeX Live appris au fil de la frappe après `\usepackage{` (recherche dans
 * l'index de l'API), pour l'autocomplétion. Une recherche dont la réponse était complète (moins
 * de résultats que la page) couvre toutes les saisies qui la prolongent : pas de nouvel appel.
 */
export class PackageNameCache {
  readonly #names = new Set<string>()
  /** Recherches faites, et si leur réponse était complète. */
  readonly #queries = new Map<string, boolean>()
  #sorted: string[] | null = []

  /** Faut-il interroger l'API pour cette saisie ? */
  shouldQuery(text: string): boolean {
    const query = normalizeQuery(text)
    if (query === null || this.#queries.has(query)) return false
    for (const [done, complete] of this.#queries) {
      if (complete && query.startsWith(done)) return false
    }
    return true
  }

  /** Mémorise la réponse d'une recherche ; vrai si de nouveaux noms ont été appris. */
  record(text: string, names: readonly string[], complete: boolean): boolean {
    const query = normalizeQuery(text)
    if (query !== null) this.#queries.set(query, complete)
    let added = false
    for (const name of names) {
      if (this.#names.has(name)) continue
      this.#names.add(name)
      added = true
    }
    if (added) this.#sorted = null
    return added
  }

  /** Noms appris, triés. */
  list(): readonly string[] {
    this.#sorted ??= [...this.#names].sort()
    return this.#sorted
  }
}

/**
 * Noms `\usepackage` d'une réponse de recherche : les premiers de chaque package et ceux qui
 * correspondent à la saisie (`matchingUsepackage`, au-delà des premiers). Complète seulement si
 * tous les packages trouvés sont dans la page et qu'aucune liste de noms n'a été coupée.
 */
export function packageNamesOf(list: TexlivePackageList): { names: string[]; complete: boolean } {
  const names = list.packages.flatMap((entry) => [
    ...entry.usepackage,
    ...(entry.matchingUsepackage ?? []),
  ])
  const complete =
    list.total <= list.packages.length &&
    list.packages.every(
      (entry) =>
        entry.matchingUsepackage !== undefined &&
        entry.matchingUsepackage.length < MAX_MATCHING_STYLES,
    )
  return { names, complete }
}

/** Saisie recherchable : 2 à 50 caractères d'un nom de package, en minuscules ; null sinon. */
export function normalizeQuery(text: string): string | null {
  const query = text.trim().toLowerCase()
  return /^[a-z0-9][a-z0-9._-]{1,49}$/.test(query) ? query : null
}
