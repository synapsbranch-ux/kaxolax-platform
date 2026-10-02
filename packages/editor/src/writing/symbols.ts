/** Catalogue de symboles du sélecteur (menu Maths), recherche et symboles récents. */

export const SYMBOL_CATEGORIES = [
  { id: 'greek', label: 'Lettres grecques' },
  { id: 'operators', label: 'Opérateurs' },
  { id: 'relations', label: 'Relations' },
  { id: 'arrows', label: 'Flèches' },
  { id: 'sets', label: 'Ensembles et logique' },
  { id: 'accents', label: 'Accents' },
  { id: 'misc', label: 'Divers' },
] as const

export type SymbolCategory = (typeof SYMBOL_CATEGORIES)[number]['id']

/** Mode où le symbole s'écrit : formule ou texte. */
export type SymbolMode = 'math' | 'text'

export interface LatexSymbol {
  /** Identifiant stable (la commande), utilisé pour les symboles récents. */
  id: string
  /** Commande insérée (`\alpha`, `\mathbb{R}`) ; avec `argument`, suivie de `{…}`. */
  command: string
  /** Aperçu Unicode pour la palette. */
  glyph: string
  name: { fr: string; en: string }
  /** Autres mots de recherche (synonymes). */
  keywords: string[]
  category: SymbolCategory
  mode: SymbolMode
  /** Packages à charger (vide : LaTeX de base). */
  packages: string[]
  /** La commande prend un argument (`\hat{x}`, `\'{e}`). */
  argument: boolean
}

interface Extra {
  packages?: string[]
  mode?: SymbolMode
  keywords?: string
  argument?: boolean
}

type Entry = readonly [command: string, glyph: string, fr: string, en: string, extra?: Extra]

const AMSSYMB = { packages: ['amssymb'] }
const AMSMATH = { packages: ['amsmath'] }
const STMARYRD = { packages: ['stmaryrd'] }

const GREEK: Entry[] = [
  ['\\alpha', 'α', 'alpha', 'alpha'],
  ['\\beta', 'β', 'bêta', 'beta'],
  ['\\gamma', 'γ', 'gamma', 'gamma'],
  ['\\delta', 'δ', 'delta', 'delta'],
  ['\\epsilon', 'ϵ', 'epsilon', 'epsilon'],
  ['\\varepsilon', 'ε', 'epsilon (variante)', 'epsilon (variant)'],
  ['\\zeta', 'ζ', 'zêta', 'zeta'],
  ['\\eta', 'η', 'êta', 'eta'],
  ['\\theta', 'θ', 'thêta', 'theta'],
  ['\\vartheta', 'ϑ', 'thêta (variante)', 'theta (variant)'],
  ['\\iota', 'ι', 'iota', 'iota'],
  ['\\kappa', 'κ', 'kappa', 'kappa'],
  ['\\varkappa', 'ϰ', 'kappa (variante)', 'kappa (variant)', AMSSYMB],
  ['\\lambda', 'λ', 'lambda', 'lambda'],
  ['\\mu', 'μ', 'mu', 'mu'],
  ['\\nu', 'ν', 'nu', 'nu'],
  ['\\xi', 'ξ', 'xi', 'xi'],
  ['\\pi', 'π', 'pi', 'pi'],
  ['\\varpi', 'ϖ', 'pi (variante)', 'pi (variant)'],
  ['\\rho', 'ρ', 'rhô', 'rho'],
  ['\\varrho', 'ϱ', 'rhô (variante)', 'rho (variant)'],
  ['\\sigma', 'σ', 'sigma', 'sigma'],
  ['\\varsigma', 'ς', 'sigma final', 'final sigma'],
  ['\\tau', 'τ', 'tau', 'tau'],
  ['\\upsilon', 'υ', 'upsilon', 'upsilon'],
  ['\\phi', 'ϕ', 'phi', 'phi'],
  ['\\varphi', 'φ', 'phi (variante)', 'phi (variant)'],
  ['\\chi', 'χ', 'khi', 'chi'],
  ['\\psi', 'ψ', 'psi', 'psi'],
  ['\\omega', 'ω', 'oméga', 'omega'],
  ['\\digamma', 'ϝ', 'digamma', 'digamma', AMSSYMB],
  ['\\Gamma', 'Γ', 'Gamma majuscule', 'capital Gamma'],
  ['\\Delta', 'Δ', 'Delta majuscule', 'capital Delta'],
  ['\\Theta', 'Θ', 'Thêta majuscule', 'capital Theta'],
  ['\\Lambda', 'Λ', 'Lambda majuscule', 'capital Lambda'],
  ['\\Xi', 'Ξ', 'Xi majuscule', 'capital Xi'],
  ['\\Pi', 'Π', 'Pi majuscule', 'capital Pi'],
  ['\\Sigma', 'Σ', 'Sigma majuscule', 'capital Sigma'],
  ['\\Upsilon', 'Υ', 'Upsilon majuscule', 'capital Upsilon'],
  ['\\Phi', 'Φ', 'Phi majuscule', 'capital Phi'],
  ['\\Psi', 'Ψ', 'Psi majuscule', 'capital Psi'],
  ['\\Omega', 'Ω', 'Oméga majuscule', 'capital Omega'],
]

const OPERATORS: Entry[] = [
  ['\\times', '×', 'multiplication (croix)', 'times', { keywords: 'fois produit' }],
  ['\\div', '÷', 'division', 'divide'],
  ['\\pm', '±', 'plus ou moins', 'plus minus'],
  ['\\mp', '∓', 'moins ou plus', 'minus plus'],
  ['\\cdot', '⋅', 'point médian', 'centered dot', { keywords: 'produit scalaire fois' }],
  ['\\ast', '∗', 'astérisque', 'asterisk'],
  ['\\star', '⋆', 'étoile', 'star'],
  ['\\circ', '∘', 'composition (rond)', 'circle', { keywords: 'rond compose' }],
  ['\\bullet', '∙', 'puce', 'bullet'],
  ['\\oplus', '⊕', 'plus cerclé', 'circled plus', { keywords: 'somme directe xor' }],
  ['\\ominus', '⊖', 'moins cerclé', 'circled minus'],
  ['\\otimes', '⊗', 'produit tensoriel', 'tensor product', { keywords: 'fois cerclé' }],
  ['\\oslash', '⊘', 'barre oblique cerclée', 'circled slash'],
  ['\\odot', '⊙', 'point cerclé', 'circled dot'],
  ['\\dagger', '†', 'dague', 'dagger', { keywords: 'adjoint' }],
  ['\\ddagger', '‡', 'double dague', 'double dagger'],
  ['\\amalg', '⨿', 'amalgame', 'amalgamation'],
  ['\\uplus', '⊎', 'union disjointe', 'multiset union'],
  ['\\sqcap', '⊓', 'intersection carrée', 'square cap'],
  ['\\sqcup', '⊔', 'union carrée', 'square cup'],
  ['\\boxplus', '⊞', 'plus encadré', 'boxed plus', AMSSYMB],
  ['\\boxtimes', '⊠', 'croix encadrée', 'boxed times', AMSSYMB],
  ['\\ltimes', '⋉', 'produit semi-direct à gauche', 'left semidirect product', AMSSYMB],
  ['\\rtimes', '⋊', 'produit semi-direct à droite', 'right semidirect product', AMSSYMB],
  ['\\intercal', '⊺', 'transposée', 'intercal', { ...AMSSYMB, keywords: 'transpose' }],
  ['\\sum', '∑', 'somme', 'sum', { keywords: 'sigma série' }],
  ['\\prod', '∏', 'produit', 'product'],
  ['\\coprod', '∐', 'coproduit', 'coproduct'],
  ['\\int', '∫', 'intégrale', 'integral'],
  ['\\iint', '∬', 'intégrale double', 'double integral', AMSMATH],
  ['\\iiint', '∭', 'intégrale triple', 'triple integral', AMSMATH],
  ['\\oint', '∮', 'intégrale curviligne', 'contour integral'],
  ['\\bigoplus', '⨁', 'grande somme directe', 'big circled plus'],
  ['\\bigotimes', '⨂', 'grand produit tensoriel', 'big tensor product'],
  ['\\partial', '∂', 'dérivée partielle', 'partial derivative', { keywords: 'd rond' }],
  ['\\nabla', '∇', 'nabla (gradient)', 'nabla', { keywords: 'gradient del' }],
  ['\\sqrt', '√', 'racine carrée', 'square root', { argument: true }],
  ['\\sin', 'sin', 'sinus', 'sine'],
  ['\\cos', 'cos', 'cosinus', 'cosine'],
  ['\\tan', 'tan', 'tangente', 'tangent'],
  ['\\arcsin', 'arcsin', 'arc sinus', 'arcsine'],
  ['\\arccos', 'arccos', 'arc cosinus', 'arccosine'],
  ['\\arctan', 'arctan', 'arc tangente', 'arctangent'],
  ['\\sinh', 'sinh', 'sinus hyperbolique', 'hyperbolic sine'],
  ['\\cosh', 'cosh', 'cosinus hyperbolique', 'hyperbolic cosine'],
  ['\\exp', 'exp', 'exponentielle', 'exponential'],
  ['\\ln', 'ln', 'logarithme népérien', 'natural logarithm'],
  ['\\log', 'log', 'logarithme', 'logarithm'],
  ['\\lim', 'lim', 'limite', 'limit'],
  ['\\max', 'max', 'maximum', 'maximum'],
  ['\\min', 'min', 'minimum', 'minimum'],
  ['\\sup', 'sup', 'borne supérieure', 'supremum'],
  ['\\inf', 'inf', 'borne inférieure', 'infimum'],
  ['\\det', 'det', 'déterminant', 'determinant'],
  ['\\gcd', 'gcd', 'plus grand commun diviseur', 'greatest common divisor', { keywords: 'pgcd' }],
]

const RELATIONS: Entry[] = [
  ['\\leq', '≤', 'inférieur ou égal', 'less than or equal'],
  ['\\geq', '≥', 'supérieur ou égal', 'greater than or equal'],
  ['\\leqslant', '⩽', 'inférieur ou égal (oblique)', 'less than or equal (slanted)', AMSSYMB],
  ['\\geqslant', '⩾', 'supérieur ou égal (oblique)', 'greater than or equal (slanted)', AMSSYMB],
  ['\\neq', '≠', 'différent', 'not equal'],
  ['\\equiv', '≡', 'équivalent (congru)', 'equivalent', { keywords: 'congruence modulo' }],
  ['\\approx', '≈', 'environ égal', 'approximately equal', { keywords: 'approximation' }],
  ['\\approxeq', '≊', 'presque égal', 'approximately equal or equal', AMSSYMB],
  ['\\sim', '∼', 'équivalent (tilde)', 'similar', { keywords: 'tilde' }],
  ['\\nsim', '≁', 'non équivalent', 'not similar', AMSSYMB],
  ['\\simeq', '≃', 'asymptotiquement égal', 'similar or equal'],
  ['\\cong', '≅', 'isomorphe (congruent)', 'congruent', { keywords: 'isomorphisme' }],
  ['\\ncong', '≆', 'non congruent', 'not congruent', AMSSYMB],
  ['\\propto', '∝', 'proportionnel à', 'proportional to'],
  ['\\ll', '≪', 'très inférieur', 'much less than'],
  ['\\gg', '≫', 'très supérieur', 'much greater than'],
  ['\\lesssim', '≲', 'inférieur ou équivalent', 'less than or similar', AMSSYMB],
  ['\\gtrsim', '≳', 'supérieur ou équivalent', 'greater than or similar', AMSSYMB],
  ['\\prec', '≺', 'précède', 'precedes'],
  ['\\succ', '≻', 'succède', 'succeeds'],
  ['\\preceq', '⪯', 'précède ou égal', 'precedes or equals'],
  ['\\succeq', '⪰', 'succède ou égal', 'succeeds or equals'],
  ['\\parallel', '∥', 'parallèle', 'parallel'],
  ['\\perp', '⊥', 'perpendiculaire', 'perpendicular', { keywords: 'orthogonal' }],
  ['\\mid', '∣', 'divise', 'divides', { keywords: 'barre tel que' }],
  ['\\nmid', '∤', 'ne divise pas', 'does not divide', AMSSYMB],
  ['\\models', '⊨', 'modélise', 'models'],
  ['\\vdash', '⊢', 'déduit (thèse)', 'proves', { keywords: 'turnstile' }],
  ['\\dashv', '⊣', 'déduit (inverse)', 'reverse turnstile'],
  ['\\doteq', '≐', 'égal par définition (point)', 'dot equal'],
  ['\\triangleq', '≜', 'égal par définition', 'defined as', { ...AMSSYMB, keywords: 'def' }],
  ['\\coloneqq', '≔', 'défini comme', 'colon equals', { packages: ['mathtools'], keywords: 'def' }],
  ['\\asymp', '≍', 'asymptotique', 'asymptotically equivalent'],
  ['\\bowtie', '⋈', 'jointure', 'bowtie', { keywords: 'join' }],
  ['\\smile', '⌣', 'sourire', 'smile'],
  ['\\frown', '⌢', 'froncement', 'frown'],
]

const ARROWS: Entry[] = [
  ['\\rightarrow', '→', 'flèche droite', 'right arrow', { keywords: 'tend vers' }],
  ['\\to', '→', 'tend vers', 'to', { keywords: 'flèche' }],
  ['\\leftarrow', '←', 'flèche gauche', 'left arrow'],
  ['\\gets', '←', 'reçoit (affectation)', 'gets', { keywords: 'flèche' }],
  ['\\leftrightarrow', '↔', 'flèche double sens', 'left right arrow'],
  [
    '\\Rightarrow',
    '⇒',
    'implique (double flèche)',
    'double right arrow',
    { keywords: 'implication' },
  ],
  ['\\Leftarrow', '⇐', 'est impliqué par', 'double left arrow'],
  [
    '\\Leftrightarrow',
    '⇔',
    'équivaut (double flèche)',
    'double left right arrow',
    { keywords: 'équivalence ssi' },
  ],
  ['\\implies', '⟹', 'implique', 'implies', AMSMATH],
  ['\\iff', '⟺', 'si et seulement si', 'if and only if', { keywords: 'équivalence ssi' }],
  ['\\longrightarrow', '⟶', 'longue flèche droite', 'long right arrow'],
  ['\\longleftarrow', '⟵', 'longue flèche gauche', 'long left arrow'],
  ['\\Longrightarrow', '⟹', 'longue double flèche droite', 'long double right arrow'],
  ['\\Longleftrightarrow', '⟺', 'longue double flèche double sens', 'long double left right arrow'],
  ['\\mapsto', '↦', 'associe à', 'maps to'],
  ['\\longmapsto', '⟼', 'associe à (long)', 'long maps to'],
  ['\\mapsfrom', '↤', 'associé depuis', 'maps from', STMARYRD],
  ['\\uparrow', '↑', 'flèche haut', 'up arrow'],
  ['\\downarrow', '↓', 'flèche bas', 'down arrow'],
  ['\\updownarrow', '↕', 'flèche haut bas', 'up down arrow'],
  ['\\Uparrow', '⇑', 'double flèche haut', 'double up arrow'],
  ['\\Downarrow', '⇓', 'double flèche bas', 'double down arrow'],
  ['\\nearrow', '↗', 'flèche nord-est', 'north east arrow'],
  ['\\searrow', '↘', 'flèche sud-est', 'south east arrow'],
  ['\\swarrow', '↙', 'flèche sud-ouest', 'south west arrow'],
  ['\\nwarrow', '↖', 'flèche nord-ouest', 'north west arrow'],
  ['\\hookrightarrow', '↪', 'injection (crochet)', 'hook right arrow', { keywords: 'inclusion' }],
  ['\\hookleftarrow', '↩', 'crochet gauche', 'hook left arrow'],
  ['\\twoheadrightarrow', '↠', 'surjection', 'two head right arrow', AMSSYMB],
  ['\\rightarrowtail', '↣', 'injection (queue)', 'right arrow tail', AMSSYMB],
  ['\\leadsto', '⇝', 'mène à', 'leads to', AMSSYMB],
  [
    '\\rightleftharpoons',
    '⇌',
    'équilibre (harpons)',
    'right left harpoons',
    { keywords: 'réaction chimie' },
  ],
  ['\\rightharpoonup', '⇀', 'harpon droit', 'right harpoon'],
  ['\\leftharpoonup', '↼', 'harpon gauche', 'left harpoon'],
  ['\\circlearrowleft', '↺', 'flèche circulaire gauche', 'circle arrow left', AMSSYMB],
  ['\\circlearrowright', '↻', 'flèche circulaire droite', 'circle arrow right', AMSSYMB],
  ['\\curvearrowright', '↷', 'flèche courbe droite', 'curved arrow right', AMSSYMB],
  ['\\nrightarrow', '↛', 'flèche droite barrée', 'not right arrow', AMSSYMB],
  ['\\nRightarrow', '⇏', 'n’implique pas', 'not implies', AMSSYMB],
  [
    '\\xrightarrow',
    '→',
    'flèche annotée',
    'extensible right arrow',
    { ...AMSMATH, argument: true },
  ],
]

const SETS: Entry[] = [
  ['\\in', '∈', 'appartient à', 'element of', { keywords: 'dans' }],
  ['\\notin', '∉', 'n’appartient pas à', 'not element of'],
  ['\\ni', '∋', 'contient (élément)', 'contains as member'],
  ['\\subset', '⊂', 'inclus dans', 'subset'],
  ['\\supset', '⊃', 'contient', 'superset'],
  ['\\subseteq', '⊆', 'inclus ou égal', 'subset or equal'],
  ['\\supseteq', '⊇', 'contient ou égal', 'superset or equal'],
  ['\\subsetneq', '⊊', 'inclus strictement', 'proper subset', AMSSYMB],
  ['\\nsubseteq', '⊈', 'non inclus', 'not subset', AMSSYMB],
  ['\\sqsubseteq', '⊑', 'inclus (carré)', 'square subset or equal'],
  ['\\cup', '∪', 'union', 'union'],
  ['\\cap', '∩', 'intersection', 'intersection'],
  ['\\bigcup', '⋃', 'grande union', 'big union'],
  ['\\bigcap', '⋂', 'grande intersection', 'big intersection'],
  ['\\setminus', '∖', 'privé de (différence)', 'set minus', { keywords: 'moins différence' }],
  ['\\emptyset', '∅', 'ensemble vide', 'empty set'],
  ['\\varnothing', '∅', 'ensemble vide (rond)', 'empty set (variant)', AMSSYMB],
  ['\\complement', '∁', 'complémentaire', 'complement', AMSSYMB],
  ['\\mathbb{N}', 'ℕ', 'entiers naturels', 'natural numbers', { ...AMSSYMB, keywords: 'n' }],
  ['\\mathbb{Z}', 'ℤ', 'entiers relatifs', 'integers', { ...AMSSYMB, keywords: 'z' }],
  ['\\mathbb{Q}', 'ℚ', 'rationnels', 'rational numbers', { ...AMSSYMB, keywords: 'q' }],
  ['\\mathbb{R}', 'ℝ', 'réels', 'real numbers', { ...AMSSYMB, keywords: 'r' }],
  ['\\mathbb{C}', 'ℂ', 'complexes', 'complex numbers', { ...AMSSYMB, keywords: 'c' }],
  ['\\forall', '∀', 'pour tout', 'for all', { keywords: 'quantificateur universel' }],
  ['\\exists', '∃', 'il existe', 'there exists', { keywords: 'quantificateur existentiel' }],
  ['\\nexists', '∄', 'il n’existe pas', 'there does not exist', AMSSYMB],
  ['\\neg', '¬', 'non (négation)', 'not', { keywords: 'négation' }],
  ['\\land', '∧', 'et (logique)', 'logical and', { keywords: 'conjonction wedge' }],
  ['\\lor', '∨', 'ou (logique)', 'logical or', { keywords: 'disjonction vee' }],
  ['\\aleph', 'ℵ', 'aleph', 'aleph', { keywords: 'cardinal' }],
  ['\\wp', '℘', 'parties (Weierstrass)', 'Weierstrass p'],
]

/** Accents : la commande prend la lettre en argument. */
const ACCENTS: Entry[] = [
  ['\\hat', 'x̂', 'chapeau', 'hat', { argument: true }],
  ['\\widehat', 'x̂', 'grand chapeau', 'wide hat', { argument: true }],
  ['\\bar', 'x̄', 'barre', 'bar', { argument: true, keywords: 'moyenne' }],
  ['\\overline', 'x̅', 'surlignement', 'overline', { argument: true, keywords: 'conjugué' }],
  ['\\underline', 'x̲', 'soulignement', 'underline', { argument: true }],
  ['\\tilde', 'x̃', 'tilde', 'tilde', { argument: true }],
  ['\\widetilde', 'x̃', 'grand tilde', 'wide tilde', { argument: true }],
  ['\\vec', 'x⃗', 'vecteur', 'vector', { argument: true, keywords: 'flèche' }],
  ['\\overrightarrow', 'AB⃗', 'vecteur (long)', 'over right arrow', { argument: true }],
  ['\\dot', 'ẋ', 'point (dérivée)', 'dot', { argument: true }],
  ['\\ddot', 'ẍ', 'deux points', 'double dot', { argument: true }],
  ['\\acute', 'x́', 'accent aigu (maths)', 'acute', { argument: true }],
  ['\\grave', 'x̀', 'accent grave (maths)', 'grave', { argument: true }],
  ['\\breve', 'x̆', 'brève', 'breve', { argument: true }],
  ['\\check', 'x̌', 'caron (maths)', 'check', { argument: true }],
  ['\\mathring', 'x̊', 'rond en chef', 'ring', { argument: true }],
  ['\\overbrace', '⏞', 'accolade au-dessus', 'overbrace', { argument: true }],
  ['\\underbrace', '⏟', 'accolade au-dessous', 'underbrace', { argument: true }],
  ["\\'", 'é', 'accent aigu', 'acute accent', { argument: true, mode: 'text' }],
  ['\\`', 'è', 'accent grave', 'grave accent', { argument: true, mode: 'text' }],
  ['\\^', 'ê', 'accent circonflexe', 'circumflex', { argument: true, mode: 'text' }],
  ['\\"', 'ë', 'tréma', 'umlaut', { argument: true, mode: 'text', keywords: 'diérèse' }],
  ['\\~', 'ñ', 'tilde (texte)', 'tilde accent', { argument: true, mode: 'text' }],
  ['\\c', 'ç', 'cédille', 'cedilla', { argument: true, mode: 'text' }],
  ['\\r', 'å', 'rond en chef (texte)', 'ring accent', { argument: true, mode: 'text' }],
  ['\\v', 'č', 'caron', 'caron', { argument: true, mode: 'text', keywords: 'hacek' }],
  ['\\u', 'ă', 'brève (texte)', 'breve accent', { argument: true, mode: 'text' }],
  ['\\H', 'ő', 'double accent aigu', 'Hungarian umlaut', { argument: true, mode: 'text' }],
  ['\\=', 'ā', 'macron', 'macron', { argument: true, mode: 'text' }],
  ['\\.', 'ż', 'point en chef', 'dot accent', { argument: true, mode: 'text' }],
]

const MISC: Entry[] = [
  ['\\infty', '∞', 'infini', 'infinity'],
  ['\\hbar', 'ℏ', 'h barre (Planck)', 'h bar', { keywords: 'planck' }],
  ['\\ell', 'ℓ', 'l cursif', 'script l'],
  ['\\Re', 'ℜ', 'partie réelle', 'real part'],
  ['\\Im', 'ℑ', 'partie imaginaire', 'imaginary part'],
  ['\\angle', '∠', 'angle', 'angle'],
  ['\\triangle', '△', 'triangle', 'triangle'],
  ['\\square', '□', 'carré', 'square', AMSSYMB],
  [
    '\\blacksquare',
    '■',
    'carré plein (CQFD)',
    'black square',
    { ...AMSSYMB, keywords: 'cqfd qed' },
  ],
  ['\\checkmark', '✓', 'coche', 'check mark', AMSSYMB],
  ['\\therefore', '∴', 'donc', 'therefore', AMSSYMB],
  ['\\because', '∵', 'car', 'because', AMSSYMB],
  ['\\ldots', '…', 'points de suspension', 'ellipsis', { keywords: 'dots' }],
  ['\\cdots', '⋯', 'points médians', 'centered dots'],
  ['\\vdots', '⋮', 'points verticaux', 'vertical dots'],
  ['\\ddots', '⋱', 'points diagonaux', 'diagonal dots'],
  ['\\prime', '′', 'prime', 'prime'],
  ['\\top', '⊤', 'vrai (haut)', 'top'],
  ['\\bot', '⊥', 'faux (bas)', 'bottom'],
  ['\\lfloor', '⌊', 'partie entière (gauche)', 'left floor'],
  ['\\rfloor', '⌋', 'partie entière (droite)', 'right floor'],
  ['\\lceil', '⌈', 'plafond (gauche)', 'left ceiling'],
  ['\\rceil', '⌉', 'plafond (droite)', 'right ceiling'],
  ['\\langle', '⟨', 'chevron gauche', 'left angle bracket', { keywords: 'produit scalaire' }],
  ['\\rangle', '⟩', 'chevron droit', 'right angle bracket'],
  [
    '\\llbracket',
    '⟦',
    'double crochet gauche',
    'left double bracket',
    { ...STMARYRD, keywords: 'intervalle entier' },
  ],
  ['\\rrbracket', '⟧', 'double crochet droit', 'right double bracket', STMARYRD],
  ['\\mathscr{L}', 'ℒ', 'L calligraphique (rond)', 'script L', { packages: ['mathrsfs'] }],
  ['\\mathcal{L}', 'ℒ', 'L calligraphique', 'calligraphic L'],
  ['\\clubsuit', '♣', 'trèfle', 'club'],
  ['\\diamondsuit', '♢', 'carreau', 'diamond'],
  ['\\heartsuit', '♡', 'cœur', 'heart'],
  ['\\spadesuit', '♠', 'pique', 'spade'],
  ['\\flat', '♭', 'bémol', 'flat'],
  ['\\sharp', '♯', 'dièse', 'sharp'],
  ['\\natural', '♮', 'bécarre', 'natural'],
  ['\\textdegree', '°', 'degré', 'degree', { mode: 'text' }],
  ['\\S', '§', 'paragraphe (section)', 'section sign', { mode: 'text' }],
  ['\\P', '¶', 'pied-de-mouche', 'pilcrow', { mode: 'text' }],
  ['\\dag', '†', 'dague (texte)', 'dagger (text)', { mode: 'text' }],
  ['\\copyright', '©', 'copyright', 'copyright', { mode: 'text' }],
  ['\\textregistered', '®', 'marque déposée', 'registered', { mode: 'text' }],
  ['\\texttrademark', '™', 'marque commerciale', 'trademark', { mode: 'text' }],
  ['\\texteuro', '€', 'euro', 'euro', { mode: 'text' }],
  ['\\pounds', '£', 'livre sterling', 'pound sterling', { mode: 'text' }],
  ['\\textperthousand', '‰', 'pour mille', 'per mille', { mode: 'text' }],
  ['\\textmu', 'µ', 'micro', 'micro', { mode: 'text' }],
  ['\\textbackslash', '\\', 'barre oblique inverse', 'backslash', { mode: 'text' }],
  [
    '\\cancel',
    '∕',
    'barré (simplification)',
    'cancel',
    { packages: ['cancel'], argument: true, keywords: 'simplifier' },
  ],
]

const GROUPS: Record<SymbolCategory, Entry[]> = {
  greek: GREEK,
  operators: OPERATORS,
  relations: RELATIONS,
  arrows: ARROWS,
  sets: SETS,
  accents: ACCENTS,
  misc: MISC,
}

/** Tous les symboles, par catégorie (ordre de `SYMBOL_CATEGORIES`). */
export const SYMBOLS: readonly LatexSymbol[] = SYMBOL_CATEGORIES.flatMap(({ id: category }) =>
  GROUPS[category].map(([command, glyph, fr, en, extra = {}]) => ({
    id: command,
    command,
    glyph,
    name: { fr, en },
    keywords: extra.keywords?.split(' ') ?? [],
    category,
    mode: extra.mode ?? 'math',
    packages: extra.packages ?? [],
    argument: extra.argument ?? false,
  })),
)

const BY_ID = new Map(SYMBOLS.map((symbol) => [symbol.id, symbol]))

/** Symbole par identifiant. */
export function symbolById(id: string): LatexSymbol | undefined {
  return BY_ID.get(id)
}

/** Minuscules sans accents (« Thêta » → « theta »). */
export function foldText(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().trim()
}

/**
 * Recherche dans le catalogue, insensible à la casse et aux accents, par commande (`\alpha` ou
 * `alpha`), nom français ou anglais et synonymes. Les commandes exactes viennent en premier, puis
 * les débuts de mot, puis les sous-chaînes. Tous les mots de la requête doivent correspondre.
 */
export function searchSymbols(
  query: string,
  options: { category?: SymbolCategory; symbols?: readonly LatexSymbol[] } = {},
): LatexSymbol[] {
  const pool = (options.symbols ?? SYMBOLS).filter(
    (symbol) => options.category === undefined || symbol.category === options.category,
  )
  const folded = foldText(query)
  if (folded === '') return [...pool]
  const terms = folded.split(/\s+/)
  const scored: { symbol: LatexSymbol; score: number; index: number }[] = []
  pool.forEach((symbol, index) => {
    const command = foldText(symbol.command)
    const bare = command.replace(/^\\/, '')
    const words = [symbol.name.fr, symbol.name.en, ...symbol.keywords].map(foldText)
    const haystack = `${command} ${words.join(' ')}`
    if (!terms.every((term) => haystack.includes(term))) return
    let score = 3
    if (folded === command || folded === bare) score = 0
    else if (bare.startsWith(folded.replace(/^\\/, ''))) score = 1
    else if (words.some((word) => word === folded || word.startsWith(folded))) score = 1
    else if (
      words.some((word) => word.split(/[\s()'’-]+/).some((part) => part.startsWith(terms[0] ?? '')))
    )
      score = 2
    scored.push({ symbol, score, index })
  })
  return scored.sort((a, b) => a.score - b.score || a.index - b.index).map((item) => item.symbol)
}

/** Nombre de symboles récents gardés par défaut. */
export const RECENT_SYMBOLS_LIMIT = 24

/** Ajoute un symbole en tête des récents (sans doublon, liste bornée). */
export function pushRecentSymbol(
  recent: readonly string[],
  id: string,
  limit = RECENT_SYMBOLS_LIMIT,
): string[] {
  return [id, ...recent.filter((item) => item !== id)].slice(0, Math.max(0, limit))
}

/**
 * Relit des symboles récents stockés par l'application (JSON ou tableau) : identifiants inconnus,
 * doublons et valeurs invalides ignorés, liste bornée.
 */
export function parseRecentSymbols(stored: unknown, limit = RECENT_SYMBOLS_LIMIT): string[] {
  let value = stored
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      return []
    }
  }
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value as unknown[]) {
    if (typeof item !== 'string' || !BY_ID.has(item) || out.includes(item)) continue
    out.push(item)
    if (out.length >= limit) break
  }
  return out
}

/** Texte JSON des symboles récents, pour le stockage de l'application. */
export function serializeRecentSymbols(recent: readonly string[]): string {
  return JSON.stringify(recent)
}

/** Symboles récents résolus dans le catalogue. */
export function recentSymbols(recent: readonly string[]): LatexSymbol[] {
  return recent.flatMap((id) => {
    const symbol = BY_ID.get(id)
    return symbol ? [symbol] : []
  })
}
