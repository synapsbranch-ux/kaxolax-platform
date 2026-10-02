/**
 * Commandes et environnements proposés par l'autocomplétion : LaTeX de base et packages courants
 * (proposés seulement quand le package est chargé). Les gabarits suivent la syntaxe des snippets
 * de @codemirror/autocomplete : `${}` ou `${nom}` pour un champ, parcouru avec Tab.
 */

/** Commande connue : nom sans `\`, gabarit des arguments, description courte. */
export interface CommandSpec {
  name: string
  /** Arguments insérés après le nom (`{${titre}}`) ; vide : commande sans argument. */
  args: string
  detail?: string
  /** Commande de mode mathématique. */
  math?: boolean
}

/** Environnement connu : nom, arguments après `\begin{nom}`, contenu initial. */
export interface EnvironmentSpec {
  name: string
  args: string
  /** Corps inséré entre `\begin` et `\end` (`\item ${}` pour une liste). */
  body: string
  detail?: string
}

/** Commandes et environnements d'un package (ou d'une classe, préfixée par `class:`). */
export interface PackageCompletions {
  commands: readonly CommandSpec[]
  environments: readonly EnvironmentSpec[]
}

type CommandEntry = readonly [name: string, args?: string, detail?: string]
type EnvironmentEntry = readonly [name: string, args?: string, body?: string, detail?: string]

function commands(entries: readonly CommandEntry[], math = false): CommandSpec[] {
  return entries.map(([name, args = '', detail]) => ({
    name,
    args,
    ...(detail === undefined ? {} : { detail }),
    ...(math ? { math } : {}),
  }))
}

function environments(entries: readonly EnvironmentEntry[]): EnvironmentSpec[] {
  return entries.map(([name, args = '', body = '${}', detail]) => ({
    name,
    args,
    body,
    ...(detail === undefined ? {} : { detail }),
  }))
}

const ARG = '{${}}'
const ITEM = '\\item ${}'
const MATRIX = '${} & ${} \\\\\n${} & ${}'

/** LaTeX de base (noyau et classes standard). */
export const BASE_COMMANDS: readonly CommandSpec[] = [
  ...commands([
    ['documentclass', '[${options}]{${article}}', 'Classe du document'],
    ['usepackage', '{${package}}', 'Charger un package'],
    ['part', '{${titre}}', 'Partie'],
    ['chapter', '{${titre}}', 'Chapitre'],
    ['section', '{${titre}}', 'Section'],
    ['section*', '{${titre}}', 'Section non numérotée'],
    ['subsection', '{${titre}}', 'Sous-section'],
    ['subsection*', '{${titre}}', 'Sous-section non numérotée'],
    ['subsubsection', '{${titre}}', 'Sous-sous-section'],
    ['paragraph', '{${titre}}', 'Paragraphe'],
    ['subparagraph', '{${titre}}', 'Sous-paragraphe'],
    ['title', '{${titre}}'],
    ['author', '{${auteur}}'],
    ['date', '{${date}}'],
    ['maketitle'],
    ['tableofcontents'],
    ['listoffigures'],
    ['listoftables'],
    ['appendix'],
    ['textbf', ARG, 'Gras'],
    ['textit', ARG, 'Italique'],
    ['textsl', ARG, 'Penché'],
    ['textsc', ARG, 'Petites capitales'],
    ['texttt', ARG, 'Machine à écrire'],
    ['textrm', ARG],
    ['textsf', ARG],
    ['textup', ARG],
    ['textmd', ARG],
    ['textnormal', ARG],
    ['emph', ARG, 'Mise en valeur'],
    ['underline', ARG, 'Souligné'],
    ['footnote', ARG, 'Note de bas de page'],
    ['footnotemark'],
    ['footnotetext', ARG],
    ['label', '{${label}}', 'Étiquette'],
    ['ref', '{${label}}', 'Référence'],
    ['pageref', '{${label}}', 'Page d’une référence'],
    ['cite', '{${clé}}', 'Citation'],
    ['nocite', '{${clé}}'],
    ['bibliography', '{${fichier}}'],
    ['bibliographystyle', '{${plain}}'],
    ['bibitem', '{${clé}}'],
    ['input', '{${fichier}}', 'Inclure un fichier'],
    ['include', '{${fichier}}', 'Inclure un chapitre'],
    ['includeonly', '{${fichiers}}'],
    ['caption', ARG, 'Légende'],
    ['centering'],
    ['item'],
    ['newcommand', '{\\${nom}}[${1}]{${définition}}', 'Nouvelle commande'],
    ['renewcommand', '{\\${nom}}{${définition}}'],
    ['providecommand', '{\\${nom}}{${définition}}'],
    ['newenvironment', '{${nom}}{${début}}{${fin}}'],
    ['renewenvironment', '{${nom}}{${début}}{${fin}}'],
    ['newcounter', ARG],
    ['setcounter', '{${compteur}}{${valeur}}'],
    ['addtocounter', '{${compteur}}{${valeur}}'],
    ['setlength', '{\\${longueur}}{${valeur}}'],
    ['addtolength', '{\\${longueur}}{${valeur}}'],
    ['newlength', '{\\${longueur}}'],
    ['hspace', '{${longueur}}', 'Espace horizontal'],
    ['vspace', '{${longueur}}', 'Espace vertical'],
    ['hfill'],
    ['vfill'],
    ['newline'],
    ['newpage', '', 'Nouvelle page'],
    ['clearpage'],
    ['cleardoublepage'],
    ['linebreak'],
    ['pagebreak'],
    ['noindent'],
    ['indent'],
    ['smallskip'],
    ['medskip'],
    ['bigskip'],
    ['pagestyle', '{${plain}}'],
    ['thispagestyle', '{${empty}}'],
    ['pagenumbering', '{${arabic}}'],
    ['tiny'],
    ['scriptsize'],
    ['footnotesize'],
    ['small'],
    ['normalsize'],
    ['large'],
    ['Large'],
    ['LARGE'],
    ['huge'],
    ['Huge'],
    ['bfseries'],
    ['itshape'],
    ['ttfamily'],
    ['LaTeX'],
    ['TeX'],
    ['today'],
    ['ldots', '', 'Points de suspension'],
    ['makebox', '[${largeur}]{${texte}}'],
    ['mbox', ARG],
    ['fbox', ARG],
    ['framebox', '[${largeur}]{${texte}}'],
    ['parbox', '{${largeur}}{${texte}}'],
    ['raisebox', '{${hauteur}}{${texte}}'],
    ['rule', '{${largeur}}{${épaisseur}}'],
    ['verb', '|${}|'],
    ['hline', '', 'Filet horizontal'],
    ['cline', '{${1-2}}'],
    ['multicolumn', '{${n}}{${c}}{${texte}}', 'Cellule fusionnée'],
    ['thanks', ARG],
    ['and'],
    ['protect'],
    ['url', '{${url}}'],
  ]),
  ...commands(
    [
      ['frac', '{${num}}{${den}}', 'Fraction'],
      ['sqrt', ARG, 'Racine'],
      ['sum', '_{${i=1}}^{${n}}', 'Somme'],
      ['prod', '_{${i=1}}^{${n}}', 'Produit'],
      ['int', '_{${a}}^{${b}}', 'Intégrale'],
      ['oint'],
      ['lim', '_{${x \\to \\infty}}', 'Limite'],
      ['left'],
      ['right'],
      ['mathrm', ARG],
      ['mathbf', ARG],
      ['mathit', ARG],
      ['mathsf', ARG],
      ['mathtt', ARG],
      ['mathcal', ARG],
      ['overline', ARG],
      ['underbrace', '{${}}_{${}}'],
      ['overbrace', '{${}}^{${}}'],
      ['hat', ARG],
      ['bar', ARG],
      ['vec', ARG],
      ['tilde', ARG],
      ['dot', ARG],
      ['ddot', ARG],
      ['widehat', ARG],
      ['widetilde', ARG],
      ['quad'],
      ['qquad'],
      ['cdot'],
      ['cdots'],
      ['vdots'],
      ['ddots'],
      ['infty'],
      ['partial'],
      ['nabla'],
      ['sin'],
      ['cos'],
      ['tan'],
      ['log'],
      ['ln'],
      ['exp'],
      ['min'],
      ['max'],
      ['sup'],
      ['inf'],
      ['det'],
    ],
    true,
  ),
]

export const BASE_ENVIRONMENTS: readonly EnvironmentSpec[] = environments([
  ['document'],
  ['itemize', '', ITEM, 'Liste à puces'],
  ['enumerate', '', ITEM, 'Liste numérotée'],
  ['description', '', '\\item[${terme}] ${}', 'Liste de définitions'],
  ['figure', '[${htbp}]', '\\centering\n${}\n\\caption{${légende}}\n\\label{${fig:}}', 'Figure'],
  ['figure*', '[${htbp}]', '\\centering\n${}\n\\caption{${légende}}'],
  ['table', '[${htbp}]', '\\centering\n\\caption{${légende}}\n\\label{${tab:}}\n${}', 'Tableau'],
  ['table*', '[${htbp}]'],
  ['tabular', '{${ll}}', '${} & ${} \\\\'],
  ['tabular*', '{${\\textwidth}}{${ll}}'],
  ['array', '{${cc}}', MATRIX],
  ['center'],
  ['flushleft'],
  ['flushright'],
  ['quote'],
  ['quotation'],
  ['verse'],
  ['verbatim'],
  ['verbatim*'],
  ['minipage', '{${0.5\\textwidth}}'],
  ['abstract', '', '${}', 'Résumé'],
  ['equation', '', '${}', 'Équation numérotée'],
  ['equation*', '', '${}'],
  ['eqnarray'],
  ['displaymath'],
  ['math'],
  ['thebibliography', '{${99}}', '\\bibitem{${clé}} ${}'],
  ['titlepage'],
  ['tabbing'],
  ['list', '{${}}{${}}'],
  ['picture', '(${100},${100})'],
  ['footnotesize'],
  ['small'],
])

const AMSMATH: PackageCompletions = {
  commands: commands(
    [
      ['text', ARG, 'Texte dans une formule'],
      ['eqref', '{${label}}', 'Référence d’équation'],
      ['dfrac', '{${num}}{${den}}'],
      ['tfrac', '{${num}}{${den}}'],
      ['binom', '{${n}}{${k}}', 'Coefficient binomial'],
      ['operatorname', ARG],
      ['DeclareMathOperator', '{\\${nom}}{${texte}}'],
      ['numberwithin', '{${equation}}{${section}}'],
      ['tag', ARG],
      ['notag'],
      ['nonumber'],
      ['intertext', ARG],
      ['iint'],
      ['iiint'],
      ['boldsymbol', ARG],
      ['xrightarrow', ARG],
      ['xleftarrow', ARG],
      ['overset', '{${}}{${}}'],
      ['underset', '{${}}{${}}'],
      ['substack', ARG],
      ['allowdisplaybreaks'],
    ],
    true,
  ),
  environments: environments([
    ['align', '', '${} &= ${}', 'Équations alignées'],
    ['align*', '', '${} &= ${}'],
    ['aligned', '', '${} &= ${}'],
    ['gather'],
    ['gather*'],
    ['gathered'],
    ['multline'],
    ['multline*'],
    ['flalign'],
    ['flalign*'],
    ['alignat', '{${2}}'],
    ['alignat*', '{${2}}'],
    ['split'],
    ['cases', '', '${} & ${} \\\\\n${} & ${}', 'Système, cas'],
    ['matrix', '', MATRIX],
    ['pmatrix', '', MATRIX, 'Matrice ( )'],
    ['bmatrix', '', MATRIX, 'Matrice [ ]'],
    ['Bmatrix', '', MATRIX],
    ['vmatrix', '', MATRIX, 'Déterminant'],
    ['Vmatrix', '', MATRIX],
    ['smallmatrix', '', MATRIX],
    ['subequations'],
  ]),
}

/** Commandes et environnements des packages courants, par nom de package (ou `class:nom`). */
export const PACKAGE_COMPLETIONS: Readonly<Record<string, PackageCompletions>> = {
  amsmath: AMSMATH,
  mathtools: {
    commands: commands(
      [
        ['coloneqq'],
        ['eqqcolon'],
        ['mathclap', ARG],
        ['mathllap', ARG],
        ['mathrlap', ARG],
        ['DeclarePairedDelimiter', '{\\${nom}}{${\\lvert}}{${\\rvert}}'],
        ['shortintertext', ARG],
        ['prescript', '{${}}{${}}{${}}'],
      ],
      true,
    ),
    environments: [
      ...AMSMATH.environments,
      ...environments([
        ['dcases', '', '${} & ${} \\\\\n${} & ${}'],
        ['rcases', '', '${} & ${} \\\\\n${} & ${}'],
        ['pmatrix*', '[${r}]', MATRIX],
        ['bmatrix*', '[${r}]', MATRIX],
        ['multlined'],
      ]),
    ],
  },
  amsthm: {
    commands: commands([
      ['newtheorem', '{${theorem}}{${Théorème}}', 'Nouveau théorème'],
      ['newtheorem*', '{${remark}}{${Remarque}}'],
      ['theoremstyle', '{${plain}}'],
      ['qedhere'],
      ['qed'],
      ['proofname'],
    ]),
    environments: environments([['proof', '', '${}', 'Démonstration']]),
  },
  graphicx: {
    commands: commands([
      ['includegraphics', '[width=${\\linewidth}]{${fichier}}', 'Image'],
      ['graphicspath', '{{${figures/}}}'],
      ['rotatebox', '{${90}}{${}}'],
      ['scalebox', '{${0.5}}{${}}'],
      ['resizebox', '{${\\linewidth}}{${!}}{${}}'],
      ['reflectbox', ARG],
    ]),
    environments: [],
  },
  hyperref: {
    commands: commands([
      ['href', '{${url}}{${texte}}', 'Lien'],
      ['url', '{${url}}'],
      ['nolinkurl', '{${url}}'],
      ['hyperref', '[${label}]{${texte}}'],
      ['hypersetup', '{${colorlinks=true}}'],
      ['autoref', '{${label}}', 'Référence avec son type'],
      ['nameref', '{${label}}', 'Référence par le titre'],
      ['phantomsection'],
      ['pdfbookmark', '[${1}]{${texte}}{${nom}}'],
    ]),
    environments: [],
  },
  cleveref: {
    commands: commands([
      ['cref', '{${label}}', 'Référence intelligente'],
      ['Cref', '{${label}}'],
      ['crefrange', '{${début}}{${fin}}'],
      ['Crefrange', '{${début}}{${fin}}'],
      ['cpageref', '{${label}}'],
      ['labelcref', '{${label}}'],
      ['crefname', '{${type}}{${singulier}}{${pluriel}}'],
    ]),
    environments: [],
  },
  varioref: {
    commands: commands([
      ['vref', '{${label}}'],
      ['Vref', '{${label}}'],
      ['vpageref', '{${label}}'],
    ]),
    environments: [],
  },
  xcolor: {
    commands: commands([
      ['textcolor', '{${red}}{${texte}}', 'Texte en couleur'],
      ['color', '{${red}}'],
      ['colorbox', '{${yellow}}{${texte}}'],
      ['fcolorbox', '{${black}}{${yellow}}{${texte}}'],
      ['definecolor', '{${nom}}{${HTML}}{${FF0000}}'],
      ['pagecolor', '{${white}}'],
    ]),
    environments: [],
  },
  color: {
    commands: commands([
      ['textcolor', '{${red}}{${texte}}'],
      ['color', '{${red}}'],
      ['colorbox', '{${yellow}}{${texte}}'],
      ['definecolor', '{${nom}}{${rgb}}{${1,0,0}}'],
    ]),
    environments: [],
  },
  tikz: {
    commands: commands([
      ['tikz', '{${}}'],
      ['draw', ' ${(0,0) -- (1,1)};'],
      ['fill', ' ${(0,0) circle (1pt)};'],
      ['filldraw', ' ${};'],
      ['node', ' ${at (0,0)} {${}};'],
      ['path', ' ${};'],
      ['coordinate', ' (${nom}) at (${0,0});'],
      ['usetikzlibrary', '{${arrows.meta}}'],
      ['tikzset', '{${}}'],
      ['foreach', ' \\${x} in {${1,...,5}} {${}}'],
    ]),
    environments: environments([
      ['tikzpicture', '', '${}', 'Dessin TikZ'],
      ['scope', '[${}]'],
    ]),
  },
  pgfplots: {
    commands: commands([
      ['addplot', ' ${coordinates {(0,0) (1,1)}};'],
      ['addlegendentry', ARG],
      ['pgfplotsset', '{compat=${1.18}}'],
    ]),
    environments: environments([
      ['axis', '[${}]'],
      ['semilogxaxis', '[${}]'],
      ['semilogyaxis', '[${}]'],
      ['loglogaxis', '[${}]'],
    ]),
  },
  booktabs: {
    commands: commands([
      ['toprule', '', 'Filet du haut'],
      ['midrule', '', 'Filet central'],
      ['bottomrule', '', 'Filet du bas'],
      ['cmidrule', '(${lr}){${1-2}}'],
      ['addlinespace'],
      ['specialrule', '{${0.1em}}{${0pt}}{${0pt}}'],
    ]),
    environments: [],
  },
  multirow: {
    commands: commands([['multirow', '{${2}}{${*}}{${texte}}', 'Cellule sur plusieurs lignes']]),
    environments: [],
  },
  tabularx: {
    commands: [],
    environments: environments([['tabularx', '{${\\linewidth}}{${lX}}', '${} & ${} \\\\']]),
  },
  longtable: {
    commands: commands([['endhead'], ['endfirsthead'], ['endfoot'], ['endlastfoot']]),
    environments: environments([['longtable', '{${ll}}', '${} & ${} \\\\']]),
  },
  geometry: {
    commands: commands([
      ['geometry', '{${margin=2.5cm}}'],
      ['newgeometry', '{${margin=2cm}}'],
      ['restoregeometry'],
    ]),
    environments: [],
  },
  siunitx: {
    commands: commands([
      ['SI', '{${valeur}}{${\\metre}}'],
      ['si', '{${\\metre}}'],
      ['num', '{${12345}}'],
      ['qty', '{${valeur}}{${\\metre}}', 'Quantité avec unité'],
      ['unit', '{${\\metre}}'],
      ['ang', '{${45}}'],
      ['sisetup', '{${}}'],
      ['numlist', '{${1;2;3}}'],
      ['qtyrange', '{${1}}{${2}}{${\\metre}}'],
    ]),
    environments: [],
  },
  biblatex: {
    commands: commands([
      ['addbibresource', '{${references.bib}}', 'Fichier de bibliographie'],
      ['printbibliography'],
      ['parencite', '{${clé}}'],
      ['textcite', '{${clé}}'],
      ['autocite', '{${clé}}'],
      ['footcite', '{${clé}}'],
      ['citeauthor', '{${clé}}'],
      ['citeyear', '{${clé}}'],
      ['citetitle', '{${clé}}'],
      ['fullcite', '{${clé}}'],
      ['Textcite', '{${clé}}'],
      ['Parencite', '{${clé}}'],
      ['smartcite', '{${clé}}'],
      ['supercite', '{${clé}}'],
      ['nocite', '{${*}}'],
    ]),
    environments: environments([['refsection'], ['refsegment']]),
  },
  natbib: {
    commands: commands([
      ['citep', '{${clé}}', 'Citation entre parenthèses'],
      ['citet', '{${clé}}', 'Citation dans le texte'],
      ['citealt', '{${clé}}'],
      ['citealp', '{${clé}}'],
      ['citeauthor', '{${clé}}'],
      ['citeyear', '{${clé}}'],
      ['citeyearpar', '{${clé}}'],
      ['Citep', '{${clé}}'],
      ['Citet', '{${clé}}'],
      ['setcitestyle', '{${}}'],
    ]),
    environments: [],
  },
  enumitem: {
    commands: commands([
      ['setlist', '{${}}'],
      ['newlist', '{${nom}}{${itemize}}{${3}}'],
      ['setlistdepth', '{${9}}'],
    ]),
    environments: [],
  },
  subcaption: {
    commands: commands([
      ['subcaption', ARG],
      ['subcaptionbox', '{${légende}}{${}}'],
      ['subref', '{${label}}'],
    ]),
    environments: environments([
      [
        'subfigure',
        '[${b}]{${0.45\\linewidth}}',
        '\\centering\n${}\n\\caption{${légende}}',
        'Sous-figure',
      ],
      ['subtable', '[${b}]{${0.45\\linewidth}}', '\\centering\n${}\n\\caption{${légende}}'],
    ]),
  },
  caption: {
    commands: commands([
      ['captionsetup', '{${}}'],
      ['captionof', '{${figure}}{${légende}}'],
      ['caption*', ARG],
    ]),
    environments: [],
  },
  float: {
    commands: commands([
      ['floatstyle', '{${ruled}}'],
      ['restylefloat', '{${figure}}'],
      ['newfloat', '{${nom}}{${htbp}}{${ext}}'],
    ]),
    environments: [],
  },
  listings: {
    commands: commands([
      ['lstset', '{${language=Python}}'],
      ['lstinline', '|${}|'],
      ['lstinputlisting', '[${language=Python}]{${fichier}}'],
      ['lstlistoflistings'],
    ]),
    environments: environments([['lstlisting', '[${language=Python}]', '${}', 'Code source']]),
  },
  minted: {
    commands: commands([
      ['mint', '{${python}}|${}|'],
      ['mintinline', '{${python}}|${}|'],
      ['inputminted', '{${python}}{${fichier}}'],
      ['setminted', '{${}}'],
    ]),
    environments: environments([['minted', '{${python}}', '${}', 'Code source coloré']]),
  },
  algorithm: {
    commands: [],
    environments: environments([['algorithm', '[${htbp}]', '\\caption{${}}\n${}']]),
  },
  algpseudocode: {
    commands: commands([
      ['State', ' ${}'],
      ['If', '{${}}'],
      ['EndIf'],
      ['For', '{${}}'],
      ['EndFor'],
      ['While', '{${}}'],
      ['EndWhile'],
      ['Procedure', '{${nom}}{${}}'],
      ['EndProcedure'],
      ['Function', '{${nom}}{${}}'],
      ['EndFunction'],
      ['Return', ' ${}'],
      ['Require', ' ${}'],
      ['Ensure', ' ${}'],
    ]),
    environments: environments([['algorithmic', '[${1}]']]),
  },
  fancyhdr: {
    commands: commands([
      ['fancyhf', '{${}}'],
      ['fancyhead', '[${L}]{${}}'],
      ['fancyfoot', '[${C}]{${\\thepage}}'],
      ['lhead', ARG],
      ['chead', ARG],
      ['rhead', ARG],
      ['lfoot', ARG],
      ['cfoot', ARG],
      ['rfoot', ARG],
      ['fancypagestyle', '{${plain}}{${}}'],
    ]),
    environments: [],
  },
  babel: {
    commands: commands([
      ['selectlanguage', '{${french}}'],
      ['foreignlanguage', '{${english}}{${texte}}'],
    ]),
    environments: environments([['otherlanguage', '{${english}}']]),
  },
  csquotes: {
    commands: commands([
      ['enquote', ARG, 'Guillemets'],
      ['textquote', ARG],
      ['blockquote', ARG],
      ['MakeOuterQuote', '{${"}}'],
    ]),
    environments: environments([['displayquote']]),
  },
  setspace: {
    commands: commands([
      ['singlespacing'],
      ['onehalfspacing'],
      ['doublespacing'],
      ['setstretch', '{${1.25}}'],
    ]),
    environments: environments([['spacing', '{${1.5}}'], ['singlespace'], ['doublespace']]),
  },
  multicol: {
    commands: commands([['columnbreak']]),
    environments: environments([
      ['multicols', '{${2}}'],
      ['multicols*', '{${2}}'],
    ]),
  },
  wrapfig: {
    commands: [],
    environments: environments([
      ['wrapfigure', '{${r}}{${0.4\\textwidth}}', '\\centering\n${}\n\\caption{${légende}}'],
    ]),
  },
  todonotes: {
    commands: commands([['todo', ARG, 'Note à faire'], ['listoftodos'], ['missingfigure', ARG]]),
    environments: [],
  },
  lipsum: { commands: commands([['lipsum', '[${1-2}]']]), environments: [] },
  blindtext: { commands: commands([['blindtext'], ['Blindtext']]), environments: [] },
  microtype: { commands: commands([['microtypesetup', '{${}}']]), environments: [] },
  glossaries: {
    commands: commands([
      ['makeglossaries'],
      ['printglossaries'],
      ['printglossary'],
      ['newglossaryentry', '{${clé}}{name={${}}, description={${}}}'],
      ['newacronym', '{${clé}}{${SIGLE}}{${forme longue}}'],
      ['gls', '{${clé}}'],
      ['Gls', '{${clé}}'],
      ['glspl', '{${clé}}'],
      ['Glspl', '{${clé}}'],
    ]),
    environments: [],
  },
  amssymb: {
    commands: commands(
      [
        ['mathbb', ARG, 'Ensemble (ℝ, ℕ…)'],
        ['mathfrak', ARG],
      ],
      true,
    ),
    environments: [],
  },
  bm: { commands: commands([['bm', ARG]], true), environments: [] },
  url: {
    commands: commands([
      ['url', '{${url}}'],
      ['urlstyle', '{${same}}'],
    ]),
    environments: [],
  },
  xspace: { commands: commands([['xspace']]), environments: [] },
  ulem: {
    commands: commands([
      ['uline', ARG],
      ['sout', ARG],
      ['uwave', ARG],
      ['xout', ARG],
    ]),
    environments: [],
  },
  soul: {
    commands: commands([
      ['hl', ARG],
      ['st', ARG],
      ['ul', ARG],
      ['so', ARG],
    ]),
    environments: [],
  },
  appendix: {
    commands: commands([['appendixpage']]),
    environments: environments([['appendices']]),
  },
  'class:beamer': {
    commands: commands([
      ['frametitle', ARG, 'Titre de diapositive'],
      ['framesubtitle', ARG],
      ['pause'],
      ['only', '<${2-}>{${}}'],
      ['onslide', '<${2-}>{${}}'],
      ['uncover', '<${2-}>{${}}'],
      ['visible', '<${2-}>{${}}'],
      ['alert', ARG],
      ['usetheme', '{${Madrid}}'],
      ['usecolortheme', '{${default}}'],
      ['usefonttheme', '{${default}}'],
      ['institute', ARG],
      ['titlepage'],
    ]),
    environments: environments([
      ['frame', '{${titre}}', '${}', 'Diapositive'],
      ['block', '{${titre}}'],
      ['alertblock', '{${titre}}'],
      ['exampleblock', '{${titre}}'],
      ['columns'],
      ['column', '{${0.5\\textwidth}}'],
      ['overprint'],
    ]),
  },
  'class:memoir': {
    commands: commands([
      ['chapterstyle', '{${default}}'],
      ['epigraph', '{${}}{${}}'],
    ]),
    environments: [],
  },
}

/** Packages chargés implicitement par un autre (mathtools charge amsmath…). */
export const PACKAGE_IMPLIES: Readonly<Record<string, readonly string[]>> = {
  mathtools: ['amsmath'],
  amssymb: ['amsfonts'],
  pgfplots: ['tikz', 'xcolor', 'graphicx'],
  tikz: ['xcolor', 'graphicx'],
  'class:beamer': ['hyperref', 'xcolor', 'graphicx', 'amsmath', 'amsthm'],
  biblatex: [],
  subcaption: ['caption'],
  cleveref: [],
}

/** Packages dont les commandes sont proposées : avec les dépendances implicites. */
export function expandPackages(names: Iterable<string>): Set<string> {
  const result = new Set<string>()
  const pending = [...names]
  for (let name = pending.pop(); name !== undefined; name = pending.pop()) {
    if (result.has(name)) continue
    result.add(name)
    pending.push(...(PACKAGE_IMPLIES[name] ?? []))
  }
  return result
}

/** Noms des packages connus de l'autocomplétion (proposés après `\usepackage{`). */
export const KNOWN_PACKAGES: readonly string[] = [
  ...new Set([
    ...Object.keys(PACKAGE_COMPLETIONS).filter((name) => !name.startsWith('class:')),
    'amsfonts',
    'inputenc',
    'fontenc',
    'lmodern',
    'parskip',
    'titlesec',
    'tocloft',
    'pdfpages',
    'framed',
    'mdframed',
    'tcolorbox',
    'array',
    'colortbl',
    'xparse',
    'etoolbox',
    'fontspec',
    'polyglossia',
    'textcomp',
    'stmaryrd',
    'mathrsfs',
    'esint',
    'chemfig',
    'mhchem',
    'physics',
    'bookmark',
    'float',
    'placeins',
    'afterpage',
    'datetime2',
    'ragged2e',
    'calc',
    'ifthen',
    'graphics',
    'epstopdf',
    'svg',
    'pdflscape',
    'rotating',
    'adjustbox',
    'makecell',
    'threeparttable',
    'dcolumn',
    'tabulary',
    'diagbox',
    'nicematrix',
    'cancel',
    'empheq',
    'thmtools',
    'tikz-cd',
    'circuitikz',
    'forest',
    'qtree',
    'hyphenat',
    'footmisc',
    'sectsty',
    'enumerate',
    'paralist',
    'acro',
    'nomencl',
    'imakeidx',
    'makeidx',
    'biblatex',
  ]),
].sort()
