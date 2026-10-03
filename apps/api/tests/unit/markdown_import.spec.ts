import { test } from '@japa/runner'
import { latexProblem } from '#services/markdown_cleanup'
import { bibKeys, citationsOf, citationWarning } from '#services/markdown_import_service'

/** Sortie de pandoc de référence : texte, image, bloc de code coloré et citation. */
const PANDOC = [
  '\\section{Intro}\\label{intro}',
  '',
  'Voir \\citep[p.~3]{knuth84}, $x^2$.',
  '',
  '\\begin{itemize}',
  '\\tightlist',
  '\\item',
  '  point',
  '\\end{itemize}',
  '',
  '\\pandocbounded{\\includegraphics[keepaspectratio]{media/plot.png}}',
  '',
  '\\begin{verbatim}',
  'code',
  '\\end{verbatim}',
  '',
].join('\n')

const KEPT = PANDOC.replace('\\tightlist\n', '')

test.group('markdown cleanup: checks of the AI output', () => {
  test('accepts a cleanup that only removes artefacts or uses the allowed commands', ({
    assert,
  }) => {
    assert.isNull(latexProblem(KEPT, 'fragment', PANDOC))
    const resized = KEPT.replace(
      '\\pandocbounded{\\includegraphics[keepaspectratio]{media/plot.png}}',
      '\\includegraphics[width=\\linewidth,keepaspectratio]{media/plot.png}',
    )
    assert.isNull(latexProblem(resized, 'fragment', PANDOC))
    const table = `${KEPT}\\begin{table}\n\\centering\n\\begin{tabular}{ll}\n\\toprule\na & b \\\\\n\\bottomrule\n\\end{tabular}\n\\end{table}\n`
    assert.isNull(latexProblem(table, 'fragment', PANDOC))
  })

  test('refuses every control sequence or environment that pandoc did not write', ({ assert }) => {
    const added: [string, string][] = [
      ['\\@@input{/etc/passwd}', '\\@@input was added'],
      ['\\csname input\\endcsname{secret}', '\\csname was added'],
      ['\\lstinputlisting{main.tex}', '\\lstinputlisting was added'],
      ['\\verbatiminput{main.tex}', '\\verbatiminput was added'],
      ['\\VerbatimInput{main.tex}', '\\VerbatimInput was added'],
      ['\\IfFileExists{x}{}{}', '\\IfFileExists was added'],
      ['\\InputIfFileExistsAt{x}{}{}', '\\InputIfFileExistsAt was added'],
      ['\\import{a/}{b}', '\\import was added'],
      ['\\subfile{b}', '\\subfile was added'],
      ['\\input{secret}', '\\input was added'],
      ['% \\input{secret}', '\\input was added'],
      ['\\begin{filecontents}{x.tex}\nx\n\\end{filecontents}', 'the environment filecontents'],
      ['^^5cinput{secret}', '^^ notation was added'],
    ]
    for (const [text, reason] of added) {
      assert.include(latexProblem(`${KEPT}${text}\n`, 'fragment', PANDOC) ?? '', reason, text)
    }
  })

  test('sees commands hidden in a Verbatim made active by \\fvset', ({ assert }) => {
    const pandoc = `${PANDOC}\\begin{Verbatim}\nx\n\\end{Verbatim}\n`
    const hidden = pandoc.replace(
      '\\begin{Verbatim}\nx\n',
      '\\fvset{commandchars=\\\\\\{\\}}\n\\begin{Verbatim}\n\\input{secret}\n',
    )
    assert.isNotNull(latexProblem(hidden, 'fragment', pandoc))
    // Même sans nouvelle commande : `\input` déjà présent dans un verbatim, recopié une fois de plus.
    const documented = `${PANDOC}\\begin{Verbatim}\n\\input{x}\n\\end{Verbatim}\n`
    assert.include(
      latexProblem(`${documented}\\input{x}\n`, 'fragment', documented) ?? '',
      '\\input was added',
    )
  })

  test('refuses an added or a lost image', ({ assert }) => {
    assert.include(
      latexProblem(`${KEPT}\\includegraphics{main.tex}\n`, 'fragment', PANDOC) ?? '',
      'the image main.tex was added',
    )
    assert.include(
      latexProblem(KEPT.replace('media/plot.png', 'media/other.png'), 'fragment', PANDOC) ?? '',
      'the image media/plot.png is missing',
    )
  })

  test('reads \\\\ as a line break, not as a command', ({ assert }) => {
    const pandoc = `${PANDOC}a \\\\ b\n`
    assert.isNull(latexProblem(`${KEPT}a \\\\input b\n`, 'fragment', pandoc))
  })
})

test.group('markdown import: citations', () => {
  test('uses biblatex when the main document loads it, natbib otherwise', ({ assert }) => {
    const preamble = (packages: string) =>
      `\\documentclass{article}\n${packages}\n\\begin{document}\n\\end{document}\n`
    assert.equal(citationsOf(preamble('\\usepackage[style=apa]{biblatex}')), 'biblatex')
    assert.equal(citationsOf(preamble('\\usepackage{natbib}')), 'natbib')
    assert.equal(citationsOf(preamble('% \\usepackage{biblatex}')), 'natbib')
    assert.equal(citationsOf(null), 'natbib')
  })

  test('reads the keys of the .bib files', ({ assert }) => {
    const keys = bibKeys([
      '@Book{knuth84,\n  title = {The TeXbook}}\n@string{tug = "TUG"}\n',
      '@article( lamport94 , title = {LaTeX})\n@comment{x, y}',
    ])
    assert.deepEqual([...keys].sort(), ['knuth84', 'lamport94'])
  })

  test('warns about keys missing from the bibliography', ({ assert }) => {
    assert.isNull(citationWarning([], []))
    assert.isNull(citationWarning(['knuth84'], ['@book{knuth84, title={T}}']))
    assert.equal(
      citationWarning(['knuth84', 'absent'], ['@book{knuth84, title={T}}']),
      'Citation keys not found in the .bib files of the project: absent',
    )
    assert.equal(
      citationWarning(['knuth84'], []),
      'Citations need a .bib file in the project: knuth84',
    )
  })
})
