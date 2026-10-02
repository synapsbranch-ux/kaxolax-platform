/** Normalise un texte pour la recherche : minuscules, sans accents, espaces réduits. */
export function normalizeSearchText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

/**
 * Filtre par défaut de `Command` : chaque mot de la recherche doit apparaître dans la valeur
 * ou dans un mot-clé, sans tenir compte de la casse ni des accents (« sec intro » trouve
 * « Section — Introduction », « equation » trouve « Équation »). Recherche vide : tout passe.
 */
export function matchesSearch(
  search: string,
  value: string,
  keywords: readonly string[] = [],
): boolean {
  const terms = normalizeSearchText(search).split(' ').filter(Boolean)
  if (terms.length === 0) return true
  const haystack = [value, ...keywords].map(normalizeSearchText)
  return terms.every((term) => haystack.some((text) => text.includes(term)))
}
