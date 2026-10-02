/** Valeur texte d'un paramètre de recherche de page (premier si répété). */
export function param(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? ''
}

/** Numéro de page (1 par défaut). */
export function pageParam(value: string | string[] | undefined): number {
  const page = Number.parseInt(param(value), 10)
  return Number.isInteger(page) && page >= 1 ? page : 1
}

/** Lien vers `path` avec les paramètres non vides. */
export function hrefWith(
  path: string,
  params: Record<string, string | number | undefined>,
): string {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === '' || (key === 'page' && value === 1)) continue
    search.set(key, String(value))
  }
  const text = search.toString()
  return text === '' ? path : `${path}?${text}`
}
