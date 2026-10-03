import type { ProjectFile } from './files'
import { PLOT_PNG, REFS_BIB } from './project'

/**
 * Projet de démonstration réaliste (article en français) : document principal avec figure,
 * tableau et bibliographie, deux sections incluses par `\input`, une image et un `.bib`. Il
 * compile avec l'image TeX Live medium.
 */
export const DEMO_MAIN = [
  '\\documentclass[11pt]{article}',
  '\\usepackage[T1]{fontenc}',
  '\\usepackage{lmodern}',
  '\\usepackage{amsmath}',
  '\\usepackage{graphicx}',
  '\\usepackage{booktabs}',
  '\\usepackage{hyperref}',
  '',
  '\\title{Propagation de la chaleur dans une barre métallique}',
  '\\author{Ada Lovelace \\and Grace Hopper}',
  '\\date{3 octobre 2026}',
  '',
  '\\begin{document}',
  '\\maketitle',
  '',
  '\\begin{abstract}',
  'Nous étudions la diffusion de la chaleur dans une barre homogène et comparons la solution',
  'analytique à une simulation numérique.',
  '\\end{abstract}',
  '',
  '\\input{sections/introduction}',
  '\\input{sections/methode}',
  '',
  '\\section{Résultats}',
  '\\label{sec:resultats}',
  'La figure~\\ref{fig:courbe} montre la température mesurée au centre de la barre.',
  '',
  '\\begin{figure}[ht]',
  '  \\centering',
  '  \\includegraphics[width=0.6\\linewidth]{figures/courbe.png}',
  '  \\caption{Température au centre de la barre en fonction du temps.}',
  '  \\label{fig:courbe}',
  '\\end{figure}',
  '',
  '\\begin{table}[ht]',
  '  \\centering',
  '  \\begin{tabular}{lrr}',
  '    \\toprule',
  '    Matériau & Conductivité (W/m/K) & Écart (\\%) \\\\',
  '    \\midrule',
  '    Cuivre & 401 & 1,2 \\\\',
  '    Aluminium & 237 & 2,8 \\\\',
  '    Acier & 50 & 4,1 \\\\',
  '    \\bottomrule',
  '  \\end{tabular}',
  '  \\caption{Conductivités et écart à la solution analytique.}',
  '  \\label{tab:materiaux}',
  '\\end{table}',
  '',
  '\\section{Conclusion}',
  'Le modèle reproduit les mesures à moins de 5~\\% près~\\cite{knuth}.',
  '',
  '\\bibliographystyle{plain}',
  '\\bibliography{refs}',
  '\\end{document}',
  '',
].join('\n')

export const DEMO_INTRODUCTION = [
  '\\section{Introduction}',
  '\\label{sec:introduction}',
  'L’équation de la chaleur décrit l’évolution de la température $u(x,t)$ :',
  '\\begin{equation}',
  '  \\frac{\\partial u}{\\partial t} = \\alpha \\frac{\\partial^2 u}{\\partial x^2}',
  '  \\label{eq:chaleur}',
  '\\end{equation}',
  'où $\\alpha$ est la diffusivité thermique du matériau.',
  '',
].join('\n')

export const DEMO_METHOD = [
  '\\section{Méthode}',
  '\\label{sec:methode}',
  '\\subsection{Schéma numérique}',
  'Nous discrétisons l’équation~\\eqref{eq:chaleur} par différences finies explicites.',
  '',
  '\\subsection{Mesures}',
  'Trois barres de 50~cm ont été chauffées à une extrémité pendant dix minutes.',
  '',
].join('\n')

/** Fichiers du projet de démonstration (zip importé depuis le tableau de bord). */
export function demoProjectFiles(): ProjectFile[] {
  return [
    { path: 'main.tex', data: DEMO_MAIN },
    { path: 'sections/introduction.tex', data: DEMO_INTRODUCTION },
    { path: 'sections/methode.tex', data: DEMO_METHOD },
    { path: 'refs.bib', data: REFS_BIB },
    { path: 'figures/courbe.png', data: PLOT_PNG },
  ]
}

/** Nom du projet de démonstration. */
export const DEMO_NAME = 'Propagation de la chaleur'
