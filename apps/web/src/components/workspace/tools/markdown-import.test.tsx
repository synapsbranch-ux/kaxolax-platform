import type { MarkdownImportResponse } from '@kaxolax/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { PreviewPane } from './markdown-import-dialog'
import { MarkdownProposal } from './markdown-proposal'

const RESULT: MarkdownImportResponse = {
  dryRun: true,
  output: 'file',
  targetPath: 'notes.tex',
  latex: '\\section{Notes}\n\\tightlist\n',
  pandocLatex: null,
  sourceSha256: 'a'.repeat(64),
  citations: [],
  title: null,
  document: null,
  media: [
    { id: null, path: 'media/a.png', contentType: 'image/png', sizeBytes: 10, created: true },
  ],
  images: [],
  warnings: ['Image not found in the project: figures/b.png'],
  preamble: {
    mode: 'main',
    mainDocumentId: null,
    mainDocumentPath: 'main.tex',
    packages: [{ name: 'hyperref', options: [] }],
    definitions: [{ name: 'tightlist', code: '\\providecommand{\\tightlist}{}' }],
    missingPackages: [{ name: 'hyperref', options: [] }],
    missingDefinitions: [{ name: 'tightlist', code: '\\providecommand{\\tightlist}{}' }],
  },
  cleanup: { applied: true, warning: null, credits: 0.42 },
  durationMs: 10,
}

describe('markdown import components', () => {
  it('previews the LaTeX, what the main preamble lacks and the warnings', () => {
    const html = renderToStaticMarkup(
      <PreviewPane
        result={RESULT}
        latex={RESULT.latex}
        cleaned
        useCleaned
        onUseCleaned={() => undefined}
        mainPath="main.tex"
      />,
    )
    expect(html).toContain('\\section{Notes}')
    expect(html).toContain('À ajouter au préambule de main.tex : hyperref, \\tightlist.')
    expect(html).toContain('Images extraites : media/a.png.')
    expect(html).toContain('0.42 crédit(s)')
    expect(html).toContain('Nettoyée par l’IA')
    expect(html).toContain('Image not found in the project: figures/b.png')
  })

  it('proposes the conversion of a pasted or uploaded Markdown text', () => {
    const html = renderToStaticMarkup(
      <MarkdownProposal
        proposal={{
          id: 'upload:1',
          message: 'notes.md est un fichier Markdown.',
          payload: { kind: 'markdown-import', documentId: '1' },
        }}
        onConvert={() => undefined}
        onDismiss={() => undefined}
      />,
    )
    expect(html).toContain('notes.md est un fichier Markdown.')
    expect(html).toContain('Convertir en LaTeX')
    expect(html).toContain('Ignorer')
    expect(
      renderToStaticMarkup(
        <MarkdownProposal
          proposal={null}
          onConvert={() => undefined}
          onDismiss={() => undefined}
        />,
      ),
    ).toBe('')
  })
})
