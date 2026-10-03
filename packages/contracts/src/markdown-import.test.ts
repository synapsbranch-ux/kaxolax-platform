import { describe, expect, it } from 'vitest'
import { MAX_MARKDOWN_BYTES } from './convert.js'
import {
  definesName,
  latexCode,
  loadedPackageNames,
  markdownImportBodySchema,
  missingRequirements,
  pandocRequirements,
  sensitiveLatexCommands,
  stripLatexComments,
} from './markdown-import.js'

const FRAGMENT = String.raw`\section{Titre}\label{titre}

Texte avec \textbf{gras}, un \href{https://example.com}{lien}\footnote{Une note.} et $\alpha$.

\begin{itemize}
\tightlist
\item \st{barré}
\end{itemize}

{\def\LTcaptype{none} % do not increment counter
\begin{longtable}[]{@{}
  >{\raggedright\arraybackslash}p{(\linewidth - 2\tabcolsep) * \real{0.5000}}@{}}
\toprule\noalign{}
A & B \\
\bottomrule\noalign{}
\end{longtable}
}

\pandocbounded{\includegraphics[keepaspectratio]{figures/plot.png}}

\begin{Shaded}
\begin{Highlighting}[]
\BuiltInTok{print}\NormalTok{(}\StringTok{"hi"}\NormalTok{)}
\end{Highlighting}
\end{Shaded}`

describe('markdownImportBodySchema', () => {
  it('needs exactly one source', () => {
    expect(markdownImportBodySchema.safeParse({ markdown: '# A' }).success).toBe(true)
    expect(
      markdownImportBodySchema.safeParse({ documentId: '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f' })
        .success,
    ).toBe(true)
    expect(markdownImportBodySchema.safeParse({}).success).toBe(false)
    expect(
      markdownImportBodySchema.safeParse({
        markdown: '# A',
        documentId: '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f',
      }).success,
    ).toBe(false)
  })

  it('refuses unsafe targets, oversized input and contradictory options', () => {
    const invalid = [
      { markdown: '# A', targetPath: '../x.tex' },
      { markdown: '# A', targetPath: 'notes.md' },
      { markdown: 'x'.repeat(MAX_MARKDOWN_BYTES + 1) },
      { markdown: '# A', output: 'insert', preamble: 'embedded' },
      { markdown: '# A', latex: 'x', cleanup: true },
      { markdown: '# A', unknown: true },
      { markdown: '# A', citations: 'citeproc' },
      { markdown: '# A', latex: 'x', sourceSha256: 'abc' },
    ]
    for (const body of invalid) expect(markdownImportBodySchema.safeParse(body).success).toBe(false)
  })

  it('needs the fingerprint of the Markdown with the validated LaTeX of a project file', () => {
    const documentId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'
    expect(markdownImportBodySchema.safeParse({ documentId, latex: 'x' }).success).toBe(false)
    expect(
      markdownImportBodySchema.safeParse({ documentId, latex: 'x', sourceSha256: 'a'.repeat(64) })
        .success,
    ).toBe(true)
    // Texte collé : le Markdown voyage avec la demande, l'empreinte est facultative.
    expect(markdownImportBodySchema.safeParse({ markdown: '# A', latex: 'x' }).success).toBe(true)
  })
})

describe('pandocRequirements', () => {
  it('derives packages and definitions from what the fragment uses', () => {
    const { packages, definitions } = pandocRequirements(FRAGMENT)
    expect(packages.map((entry) => entry.name)).toEqual([
      'amsmath',
      'amssymb',
      'graphicx',
      'longtable',
      'booktabs',
      'array',
      'calc',
      'xcolor',
      'fancyvrb',
      'soul',
      'hyperref',
    ])
    expect(definitions.map((entry) => entry.name)).toEqual([
      'tightlist',
      'pandocbounded',
      'none',
      'Shaded',
      'Highlighting',
      'BuiltInTok',
      'NormalTok',
      'StringTok',
    ])
    expect(definitions.every((entry) => !entry.code.includes('\\newcommand'))).toBe(true)
  })

  it('reuses the token colours of the pandoc preamble', () => {
    const preamble =
      '\\newcommand{\\StringTok}[1]{\\textcolor[rgb]{0.25,0.44,0.63}{#1}}\n\\newcommand{\\NormalTok}[1]{#1}'
    const { definitions } = pandocRequirements(FRAGMENT, preamble)
    expect(definitions.find((entry) => entry.name === 'StringTok')?.code).toBe(
      '\\providecommand{\\StringTok}[1]{\\textcolor[rgb]{0.25,0.44,0.63}{#1}}',
    )
    expect(definitions.find((entry) => entry.name === 'BuiltInTok')?.code).toBe(
      '\\providecommand{\\BuiltInTok}[1]{#1}',
    )
  })

  it('needs nothing for plain text, and ignores commented commands and escaped dollars', () => {
    expect(pandocRequirements('Du texte à 5 \\$.\n% \\href{x}{y} $a$')).toEqual({
      packages: [],
      definitions: [],
    })
  })
})

describe('missingRequirements', () => {
  const required = pandocRequirements(FRAGMENT)

  it('keeps only what the main document lacks, without duplicates', () => {
    const main = [
      '\\documentclass{article}',
      '\\usepackage[utf8]{inputenc}',
      '\\usepackage{mathtools,booktabs} % amsmath vient de mathtools',
      '% \\usepackage{hyperref}',
      '\\usepackage{tikz}',
      '\\providecommand{\\tightlist}{}',
      '\\begin{document}',
      '\\usepackage{soul}',
      '\\end{document}',
    ].join('\n')
    const missing = missingRequirements(main, required)
    expect(missing.packages.map((entry) => entry.name)).toEqual([
      'amssymb',
      'longtable',
      'array',
      'calc',
      'fancyvrb',
      'soul',
      'hyperref',
    ])
    expect(missing.definitions.map((entry) => entry.name)).not.toContain('tightlist')
    expect(missing.definitions.map((entry) => entry.name)).toContain('pandocbounded')

    // Une fois ajoutés, plus rien ne manque : pas de doublon au second import.
    const merged = main.replace(
      '\\begin{document}',
      [
        ...missing.packages.map((entry) => `\\usepackage{${entry.name}}`),
        ...missing.definitions.map((entry) => entry.code),
        '\\begin{document}',
      ].join('\n'),
    )
    expect(missingRequirements(merged, required)).toEqual({ packages: [], definitions: [] })
  })

  it('asks for everything when there is no main document or no preamble', () => {
    expect(missingRequirements(null, required)).toEqual(required)
    expect(missingRequirements('\\section{x}', required)).toEqual(required)
  })
})

describe('preamble helpers', () => {
  it('strips comments but keeps escaped percents', () => {
    expect(stripLatexComments('50\\% % commentaire')).toBe('50\\%              ')
  })

  it('empties verbatim and \\verb, in the order TeX reads them', () => {
    const code = latexCode(
      [
        'Avant % \\begin{verbatim}',
        '\\begin{verbatim}',
        '\\documentclass{article}',
        '\\begin{itemize} % 100%',
        '\\end{verbatim}',
        'Et \\verb|\\input{x}| puis \\Verb!\\begin{y}!.',
        '',
      ].join('\n'),
    )
    expect(code).toBe('Avant \n\\begin{verbatim}\\end{verbatim}\nEt \\verb|| puis \\verb||.\n')
    // Un `%` dans un verbatim ne masque pas sa fin : ce qui suit reste du code.
    expect(latexCode('\\begin{verbatim}\nx % \\end{verbatim}\n\\input{y}\n')).toContain(
      '\\input{y}',
    )
    // Verbatim non fermé, ou à `commandchars` (Highlighting de pandoc) : analysé.
    expect(latexCode('\\begin{verbatim}\n\\input{y}')).toContain('\\input{y}')
    expect(
      latexCode('\\begin{Verbatim}[commandchars=\\\\\\{\\}]\n\\input{y}\n\\end{Verbatim}'),
    ).toContain('\\input{y}')
    // `\fvset{commandchars=…}` rend actifs tous les `Verbatim` (pas les `verbatim`).
    const global = '\\fvset{commandchars=\\\\\\{\\}}\n'
    expect(latexCode(`${global}\\begin{Verbatim}\n\\input{y}\n\\end{Verbatim}`)).toContain(
      '\\input{y}',
    )
    expect(latexCode(`${global}\\begin{verbatim}\n\\input{y}\n\\end{verbatim}`)).not.toContain(
      '\\input{y}',
    )
    expect(latexCode('\\begin{Verbatim}\n\\input{y}\n\\end{Verbatim}')).not.toContain('\\input')
  })

  it('needs natbib or biblatex for the citations of pandoc, nothing for \\cite', () => {
    const names = (body: string) => pandocRequirements(body).packages.map((entry) => entry.name)
    expect(names('Voir \\citep[p.~3]{knuth84} et \\citet{lamport94}.')).toEqual(['natbib'])
    expect(names('\\citeyearpar{a} \\citealp*{b}')).toEqual(['natbib'])
    expect(names('Voir \\autocite[3]{knuth84}, \\textcite{a} \\autocites[voir][]{a}{b}.')).toEqual([
      'biblatex',
    ])
    expect(names('\\cite{knuth84} \\citeauthor{a}')).toEqual([])
    // natbib avant hyperref (chargé en dernier).
    expect(names('\\href{u}{l} \\citep{a}')).toEqual(['natbib', 'hyperref'])
  })

  it('lists the file and engine commands outside comments and verbatim', () => {
    expect(
      sensitiveLatexCommands(
        '\\(\\input{/etc/passwd}\\immediate\\write18{x}\\)\n% \\directlua{}\n\\inputenc \\verb|\\catcode|',
      ),
    ).toEqual(['input', 'write', 'write18', 'immediate'])
    expect(sensitiveLatexCommands('\\begin{verbatim}\n\\input{x}\n\\end{verbatim}\n')).toEqual([])
  })

  it('needs no package for LaTeX shown in a verbatim', () => {
    expect(
      pandocRequirements('\\begin{verbatim}\n\\href{a}{b} \\begin{longtable}\n\\end{verbatim}\n')
        .packages,
    ).toEqual([])
  })

  it('reads loaded packages from the preamble only', () => {
    expect(
      loadedPackageNames(
        '\\documentclass[11pt]{amsart}\n\\RequirePackage[x]{ hyperref , xcolor }\n\\begin{document}\\usepackage{late}',
      ),
    ).toEqual(new Set(['amsart', 'amsmath', 'hyperref', 'xcolor']))
    expect(loadedPackageNames('\\section{x}')).toBeNull()
  })

  it('finds a definition by name', () => {
    expect(definesName('\\providecommand{\\tightlist}{}', 'tightlist')).toBe(true)
    expect(definesName('\\providecommand{\\tightlists}{}', 'tightlist')).toBe(false)
    expect(definesName('\\newcounter{none}', 'none')).toBe(true)
  })
})
