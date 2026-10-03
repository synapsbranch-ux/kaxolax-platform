/**
 * Texte à taper dans le panneau de recherche de l'éditeur pour trouver `text` tel quel. Le
 * panneau n'est pas littéral (`search({ top: true })` de @kaxolax/editor) : `unquote` de
 * @codemirror/search remplace `\n`, `\r`, `\t` et `\\` par le caractère correspondant, si bien
 * que `\ref` deviendrait un retour chariot suivi de `ef`. Chaque antislash est donc doublé.
 */
export function searchQueryFor(text: string): string {
  return text.replaceAll('\\', '\\\\')
}
