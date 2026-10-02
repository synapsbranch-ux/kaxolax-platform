import { mathPackages } from './math-packages.js'

export const FORMULA_CATEGORIES = [
  { id: 'fractions', label: 'Fractions et racines' },
  { id: 'sums', label: 'Sommes et produits' },
  { id: 'integrals', label: 'Intégrales' },
  { id: 'limits', label: 'Limites' },
  { id: 'derivatives', label: 'Dérivées' },
  { id: 'matrices', label: 'Matrices' },
  { id: 'systems', label: 'Systèmes et cas' },
  { id: 'binomials', label: 'Binômes' },
  { id: 'classics', label: 'Formules classiques' },
] as const

export type FormulaCategory = (typeof FORMULA_CATEGORIES)[number]['id']

export interface LibraryFormula {
  id: string
  label: string
  category: FormulaCategory
  /** Exemple complet, compilable tel quel. */
  latex: string
  /**
   * Modèle pour MathLive (`mathfield.insert`) : `#?` marque une case à remplir, `#@` la sélection
   * courante.
   */
  template: string
  /** Présentation conseillée (centrée pour les matrices, systèmes et grands opérateurs). */
  display: boolean
  /** Packages demandés (calculés depuis `latex`). */
  packages: string[]
}

type Entry = readonly [
  id: string,
  label: string,
  category: FormulaCategory,
  latex: string,
  template: string,
  display?: boolean,
]

const ENTRIES: Entry[] = [
  ['fraction', 'Fraction', 'fractions', '\\frac{a}{b}', '\\frac{#@}{#?}'],
  ['dfraction', 'Fraction (grande taille)', 'fractions', '\\dfrac{a}{b}', '\\dfrac{#@}{#?}'],
  [
    'continued-fraction',
    'Fraction continue',
    'fractions',
    'a_0 + \\cfrac{1}{a_1 + \\cfrac{1}{a_2 + \\cdots}}',
    '#? + \\cfrac{1}{#? + \\cfrac{1}{#? + \\cdots}}',
    true,
  ],
  ['sqrt', 'Racine carrée', 'fractions', '\\sqrt{x}', '\\sqrt{#@}'],
  ['nth-root', 'Racine n-ième', 'fractions', '\\sqrt[n]{x}', '\\sqrt[#?]{#@}'],
  ['sum', 'Somme', 'sums', '\\sum_{i=1}^{n} a_i', '\\sum_{#?}^{#?} #@', true],
  [
    'series',
    'Série entière',
    'sums',
    '\\sum_{n=0}^{\\infty} \\frac{x^n}{n!}',
    '\\sum_{n=0}^{\\infty} #?',
    true,
  ],
  ['product', 'Produit', 'sums', '\\prod_{i=1}^{n} a_i', '\\prod_{#?}^{#?} #@', true],
  [
    'integral',
    'Intégrale définie',
    'integrals',
    '\\int_{a}^{b} f(x) \\, \\mathrm{d}x',
    '\\int_{#?}^{#?} #@ \\, \\mathrm{d}x',
    true,
  ],
  [
    'indefinite-integral',
    'Primitive',
    'integrals',
    '\\int f(x) \\, \\mathrm{d}x',
    '\\int #@ \\, \\mathrm{d}x',
  ],
  [
    'double-integral',
    'Intégrale double',
    'integrals',
    '\\iint_{D} f(x, y) \\, \\mathrm{d}x \\, \\mathrm{d}y',
    '\\iint_{#?} #@ \\, \\mathrm{d}x \\, \\mathrm{d}y',
    true,
  ],
  [
    'contour-integral',
    'Intégrale curviligne',
    'integrals',
    '\\oint_{C} \\vec{F} \\cdot \\mathrm{d}\\vec{r}',
    '\\oint_{#?} #@',
    true,
  ],
  ['limit', 'Limite', 'limits', '\\lim_{x \\to a} f(x)', '\\lim_{#? \\to #?} #@'],
  [
    'limit-infinity',
    'Limite en l’infini',
    'limits',
    '\\lim_{n \\to +\\infty} u_n',
    '\\lim_{n \\to +\\infty} #@',
  ],
  [
    'derivative',
    'Dérivée',
    'derivatives',
    '\\frac{\\mathrm{d}y}{\\mathrm{d}x}',
    '\\frac{\\mathrm{d}#?}{\\mathrm{d}#?}',
  ],
  [
    'second-derivative',
    'Dérivée seconde',
    'derivatives',
    '\\frac{\\mathrm{d}^2 y}{\\mathrm{d}x^2}',
    '\\frac{\\mathrm{d}^2 #?}{\\mathrm{d}#?^2}',
  ],
  [
    'partial-derivative',
    'Dérivée partielle',
    'derivatives',
    '\\frac{\\partial f}{\\partial x}',
    '\\frac{\\partial #?}{\\partial #?}',
  ],
  ['prime', 'Dérivée (prime)', 'derivatives', "f'(x)", "#?'(#?)"],
  [
    'pmatrix',
    'Matrice (parenthèses)',
    'matrices',
    '\\begin{pmatrix} a & b \\\\ c & d \\end{pmatrix}',
    '\\begin{pmatrix} #? & #? \\\\ #? & #? \\end{pmatrix}',
    true,
  ],
  [
    'bmatrix',
    'Matrice (crochets) 3 × 3',
    'matrices',
    '\\begin{bmatrix} 1 & 0 & 0 \\\\ 0 & 1 & 0 \\\\ 0 & 0 & 1 \\end{bmatrix}',
    '\\begin{bmatrix} #? & #? & #? \\\\ #? & #? & #? \\\\ #? & #? & #? \\end{bmatrix}',
    true,
  ],
  [
    'determinant',
    'Déterminant',
    'matrices',
    '\\begin{vmatrix} a & b \\\\ c & d \\end{vmatrix} = ad - bc',
    '\\begin{vmatrix} #? & #? \\\\ #? & #? \\end{vmatrix}',
    true,
  ],
  [
    'cases',
    'Fonction définie par cas',
    'systems',
    'f(x) = \\begin{cases} x & \\text{si } x \\geq 0 \\\\ -x & \\text{sinon} \\end{cases}',
    '#? = \\begin{cases} #? & \\text{si } #? \\\\ #? & \\text{sinon} \\end{cases}',
    true,
  ],
  [
    'system',
    'Système d’équations',
    'systems',
    '\\begin{cases} x + y = 1 \\\\ x - y = 0 \\end{cases}',
    '\\begin{cases} #? \\\\ #? \\end{cases}',
    true,
  ],
  ['binomial', 'Coefficient binomial', 'binomials', '\\binom{n}{k}', '\\binom{#?}{#?}'],
  [
    'binomial-theorem',
    'Formule du binôme',
    'binomials',
    '(a + b)^n = \\sum_{k=0}^{n} \\binom{n}{k} a^{k} b^{n-k}',
    '(a + b)^n = \\sum_{k=0}^{n} \\binom{n}{k} a^{k} b^{n-k}',
    true,
  ],
  [
    'quadratic',
    'Racines du trinôme',
    'classics',
    'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
    'x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}',
    true,
  ],
  ['euler', 'Identité d’Euler', 'classics', 'e^{i\\pi} + 1 = 0', 'e^{i\\pi} + 1 = 0'],
  ['norm', 'Norme', 'classics', '\\lVert x \\rVert', '\\lVert #@ \\rVert'],
  ['absolute', 'Valeur absolue', 'classics', '\\lvert x \\rvert', '\\lvert #@ \\rvert'],
]

/** Bibliothèque de formules courantes de l'éditeur de formules. */
export const FORMULA_LIBRARY: readonly LibraryFormula[] = ENTRIES.map(
  ([id, label, category, latex, template, display = false]) => ({
    id,
    label,
    category,
    latex,
    template,
    display,
    packages: mathPackages(latex),
  }),
)
