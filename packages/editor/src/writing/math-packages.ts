import type { Text } from '@codemirror/state'
import { findPreamble, loadedPackages } from '../packages.js'
import { AMSMATH_ENVIRONMENTS } from './formula.js'
import { SYMBOLS } from './symbols.js'

/** Packages chargés par un autre (`mathtools` charge `amsmath`, `amssymb` charge `amsfonts`). */
export const PACKAGE_PROVIDERS: Readonly<Record<string, readonly string[]>> = {
  amsmath: ['mathtools'],
  amsfonts: ['amssymb'],
  amssymb: [],
  graphicx: [],
  xcolor: [],
}

/** Commandes mathématiques hors du catalogue de symboles et le package qui les définit. */
const COMMAND_PACKAGES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    [
      'text',
      'dfrac',
      'tfrac',
      'cfrac',
      'genfrac',
      'binom',
      'dbinom',
      'tbinom',
      'operatorname',
      'boldsymbol',
      'iint',
      'iiint',
      'iiiint',
      'idotsint',
      'overset',
      'underset',
      'xrightarrow',
      'xleftarrow',
      'eqref',
      'tag',
      'notag',
      'substack',
      'sideset',
      'lvert',
      'rvert',
      'lVert',
      'rVert',
      'intertext',
      'implies',
      'impliedby',
      'boxed',
      'dotsc',
      'dotsb',
      'dotsm',
      'dotsi',
      'pod',
      'overleftrightarrow',
      'underrightarrow',
      'underleftarrow',
      'varGamma',
      'varDelta',
      'varTheta',
      'varLambda',
      'varXi',
      'varPi',
      'varSigma',
      'varUpsilon',
      'varPhi',
      'varPsi',
      'varOmega',
    ].map((name) => [name, 'amsmath']),
  ),
  mathbb: 'amsfonts',
  mathfrak: 'amsfonts',
  mathscr: 'mathrsfs',
  bm: 'bm',
  coloneqq: 'mathtools',
  mathclap: 'mathtools',
  mathrlap: 'mathtools',
  mathllap: 'mathtools',
  xmapsto: 'mathtools',
  cancel: 'cancel',
  bcancel: 'cancel',
  xcancel: 'cancel',
  cancelto: 'cancel',
  textcolor: 'xcolor',
  color: 'xcolor',
  colorbox: 'xcolor',
  oiint: 'esint',
  SI: 'siunitx',
  si: 'siunitx',
  qty: 'siunitx',
  unit: 'siunitx',
  num: 'siunitx',
  href: 'hyperref',
}

/** Environnements mathématiques internes et le package qui les définit. */
const ENVIRONMENT_PACKAGES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    [
      'matrix',
      'pmatrix',
      'bmatrix',
      'Bmatrix',
      'vmatrix',
      'Vmatrix',
      'smallmatrix',
      'cases',
      'aligned',
      'alignedat',
      'gathered',
      'split',
      'subequations',
      ...AMSMATH_ENVIRONMENTS,
    ].map((name) => [name, 'amsmath']),
  ),
  dcases: 'mathtools',
  rcases: 'mathtools',
  'dcases*': 'mathtools',
  multlined: 'mathtools',
}

/** Package de chaque commande du catalogue de symboles (`\leqslant` → amssymb). */
const SYMBOL_PACKAGES = new Map<string, string>()
for (const symbol of SYMBOLS) {
  const name = /^\\([a-zA-Z]+)/.exec(symbol.command)?.[1]
  const required = symbol.packages[0]
  if (name !== undefined && required !== undefined && !(name in COMMAND_PACKAGES)) {
    SYMBOL_PACKAGES.set(name, required)
  }
}

/**
 * Packages demandés par une formule (commandes et environnements), dans l'ordre d'apparition :
 * amsmath pour `\text`, `pmatrix`, `align`… ; amssymb pour `\mathbb`, `\leqslant`… ;
 * `environment` est l'environnement englobant éventuel (`align*`).
 */
export function mathPackages(latex: string, environment?: string): string[] {
  const packages: string[] = []
  const add = (name: string | undefined) => {
    if (name !== undefined && !packages.includes(name)) packages.push(name)
  }
  if (environment !== undefined) add(ENVIRONMENT_PACKAGES[environment])
  for (const match of latex.matchAll(/\\(?:(begin)\s*\{([^{}]*)\}|([a-zA-Z]+))/g)) {
    if (match[1] !== undefined) add(ENVIRONMENT_PACKAGES[match[2]?.trim() ?? ''])
    else {
      const name = match[3] ?? ''
      add(COMMAND_PACKAGES[name] ?? SYMBOL_PACKAGES.get(name))
    }
  }
  return packages
}

/** Vrai si `name` est chargé directement ou par un package qui le fournit. */
function isLoaded(loaded: ReadonlySet<string>, name: string): boolean {
  if (loaded.has(name)) return true
  return (PACKAGE_PROVIDERS[name] ?? []).some((provider) => isLoaded(loaded, provider))
}

/**
 * Packages de `required` absents du préambule de `doc` (en tenant compte de `PACKAGE_PROVIDERS`),
 * ou null si `doc` n'a pas de préambule (fichier inclus : à vérifier dans le fichier principal).
 */
export function missingPackages(doc: Text | string, required: readonly string[]): string[] | null {
  if (findPreamble(doc) === null) return null
  const loaded = new Set(loadedPackages(doc).flatMap((item) => item.names))
  return [...new Set(required)].filter((name) => !isLoaded(loaded, name))
}
