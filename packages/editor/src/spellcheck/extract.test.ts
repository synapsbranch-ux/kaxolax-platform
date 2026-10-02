import { describe, expect, it } from 'vitest'
import { extractWords, normalizeWord } from './extract.js'

function words(doc: string): string[] {
  return extractWords(doc).map((word) => word.word)
}

describe('extractWords', () => {
  it('keeps the text of a real document and ignores commands, arguments and the preamble options', () => {
    const doc = `\\documentclass[11pt,a4paper]{article}
\\usepackage[utf8]{inputenc}
\\usepackage[french]{babel}
\\usepackage{graphicx,hyperref}
\\title{Analyse des données}
\\begin{document}
\\maketitle
\\section[Court]{Introduction générale}\\label{sec:intro}
Comme le montre la figure~\\ref{fig:plot} et \\cite[p.~3]{knuth84,lamport94}, l'arbre
porte-monnaie est \\textbf{important} et \\emph{rapide}.
\\begin{figure}[htbp]
  \\centering
  \\includegraphics[width=0.8\\linewidth]{figures/plot_final.pdf}
  \\caption{Courbe obtenue}
\\end{figure}
Voir \\url{https://example.org/chemin} ou \\href{https://kaxolax.dev}{notre site}.
\\end{document}`
    expect(words(doc)).toEqual([
      'Analyse',
      'des',
      'données',
      'Court',
      'Introduction',
      'générale',
      'Comme',
      'le',
      'montre',
      'la',
      'figure',
      'et',
      "l'arbre",
      'porte-monnaie',
      'est',
      'important',
      'et',
      'rapide',
      'Courbe',
      'obtenue',
      'Voir',
      'ou',
      'notre',
      'site',
    ])
  })

  it('ignores inline, display and environment math', () => {
    const doc = `Soit $f(x) = \\sin x$ une fonction, $$\\int_a^b f \\, dx$$ puis \\(alpha\\) et
\\[ \\text{texte} \\]
\\begin{equation}\\label{eq:a} energie = mc^2 \\end{equation}
\\begin{align*} vitesse &= distance \\end{align*}
\\begin{multline} longue \\end{multline}
Prix : 5\\$ seulement.`
    expect(words(doc)).toEqual(['Soit', 'une', 'fonction', 'puis', 'et', 'Prix', 'seulement'])
  })

  it('ignores comments, verbatim, code and drawings', () => {
    const doc = `Texte % commentaire ignoréé
Réduction de 50\\% sur \\verb|motclef| ici.
\\begin{verbatim}
erreurr dans le code
\\end{verbatim}
\\begin{lstlisting}[language=Python]
prinnt("x")
\\end{lstlisting}
\\begin{tikzpicture}\\node at (0,0) {noeudd};\\end{tikzpicture}
\\begin{minted}{python}
deff f(): pass
\\end{minted}
\\lstinline{codee} et \\texttt{identifiant_long} fin.`
    expect(words(doc)).toEqual(['Texte', 'Réduction', 'de', 'sur', 'ici', 'et', 'fin'])
  })

  it('skips non-text arguments but keeps text arguments of unknown commands', () => {
    const doc = `\\setlength{\\parindent}{0pt}\\vspace{2em}\\textcolor{red}{rouge}
\\begin{tabular}{|lcr|} cellule & autre \\\\[2pt] \\end{tabular}
\\begin{minipage}{0.5\\textwidth} dedans \\end{minipage}
\\monmacro[option]{argument} \\newcommand{\\foo}[1]{definition} \\item[Puce] texte
\\usetikzlibrary{arrows.meta} \\multicolumn{2}{c}{fusion} \\multirow{2}{*}{lignes}`
    expect(words(doc)).toEqual([
      'rouge',
      'cellule',
      'autre',
      'dedans',
      'argument',
      'Puce',
      'texte',
      'fusion',
      'lignes',
    ])
  })

  it('skips acronyms, mixed case, single letters, glued numbers and accent commands', () => {
    const doc = "Le CNRS et LaTeX via iPhone : a b mot2 x_y caf\\'e \\'ecole hy\\-phen bien’s ok"
    expect(words(doc)).toEqual(['Le', 'et', 'via', 'bien’s', 'ok'])
  })

  it('returns exact positions in the document', () => {
    const doc = '\\textbf{Bonjour} monde'
    expect(extractWords(doc)).toEqual([
      { word: 'Bonjour', from: 8, to: 15 },
      { word: 'monde', from: 17, to: 22 },
    ])
  })

  it('stays fast on a long document', () => {
    const paragraph =
      'Le théorème \\ref{thm:a} montre que $x^2 \\geq 0$ pour tout réel, voir \\cite{k}.\n'
    const doc = paragraph.repeat(3000)
    const start = performance.now()
    expect(extractWords(doc)).toHaveLength(3000 * 8)
    expect(performance.now() - start).toBeLessThan(500)
  })
})

describe('normalizeWord', () => {
  it('uses the ASCII apostrophe and NFC', () => {
    expect(normalizeWord('l’arbre')).toBe("l'arbre")
    expect(normalizeWord('e\u0301te\u0301')).toBe('été')
  })
})
