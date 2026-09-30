export interface PathOptions {
  /** Répertoire du projet dans le conteneur, retiré des chemins absolus. */
  rootDir: string
  /** Nom de job : les fichiers `<jobname>.*` (aux, toc, bbl…) sont générés, pas du projet. */
  jobname: string
}

/**
 * Chemin tel qu'on le montre à l'utilisateur : relatif au projet (`chapters/intro.tex`),
 * absolu pour un fichier de TeX Live, et nul pour un fichier généré par la compilation.
 */
export function normalizePath(path: string, options: PathOptions): string | null {
  let result = path.trim()
  if (result.startsWith('"') && result.endsWith('"') && result.length >= 2) {
    result = result.slice(1, -1)
  }
  const root = options.rootDir.endsWith('/') ? options.rootDir : `${options.rootDir}/`
  if (result.startsWith(root)) result = result.slice(root.length)
  while (result.startsWith('./')) result = result.slice(2)
  if (result === '') return null
  if (!result.includes('/') && result.startsWith(`${options.jobname}.`)) return null
  return result
}
