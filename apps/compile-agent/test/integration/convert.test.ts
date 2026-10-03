import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  type CompileResource,
  type ConvertOptions,
  type ConvertResult,
  MAX_CONVERT_TIMEOUT_MS,
  projectFilesPrefix,
} from '@kaxolax/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compileRequest,
  createTestAgent,
  dockerAvailable,
  extractMaliciousCases,
  pandocAvailable,
  RUNTIME,
  type TestAgent,
} from './helpers.js'
import { CONVERT_DIR } from '../../src/compiler.js'
import { ConvertError } from '../../src/convert.js'
import { sha256Hex } from '../../src/workspace.js'

const available = (await dockerAvailable()) && pandocAvailable()

/** PNG 4×4 valide (rouge) et son nom une fois extrait (sha1). */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGM4IScHRwzEcQCxYxBBO0tjggAAAABJRU5ErkJggg=='
const PNG_NAME = '1630582cb4d9471b8d5c8ee5048ddc5b6b0662f8.png'

const RICH_MARKDOWN = `---
title: Conversion Markdown
author: Kaxolax
---

# Introduction

Un paragraphe avec de l'*emphase*, du **gras**, du \`code\`, un [lien](https://pandoc.org) et une
note[^note]. Accents : élève, cœur, « guillemets ».

[^note]: Le texte de la note.

- premier point
  1. sous-point numéroté
- [x] tâche faite

En ligne $e^{i\\pi} + 1 = 0$, et centrée :

$$
\\int_0^1 x^2 \\, dx = \\frac{1}{3}
$$

| Moteur   | Unicode |
|----------|:-------:|
| pdfLaTeX | non     |
| LuaLaTeX | oui     |

: Moteurs disponibles

\`\`\`python
def hello(name: str) -> str:
    return f"Bonjour {name}"
\`\`\`

> Une citation.

![Figure du projet](../figures/plot.png){width=40%}

![Image intégrée](data:image/png;base64,${PNG_BASE64})

![Absente](../figures/absente.png)
`

/** Format `convert` de case.json, partagé avec le runner de kaxolax-texlive-images. */
interface ConvertCase {
  convert?: ConvertOptions & {
    sourceDir?: string
    graphicsDir?: string
    mediaDir?: string
    compile?: 'pdflatex' | 'xelatex' | 'lualatex'
  }
  timeoutSeconds?: number
  expect: {
    status?: string[]
    texContains?: string[]
    texLacks?: string[]
    reportContains?: string[]
    absentFiles?: string[]
    noLeak?: string[]
  }
}

function textResource(path: string, content: string): CompileResource {
  return { path, kind: 'text', content, sha256: sha256Hex(content) }
}

/** Ressources binaires servies depuis le disque par le faux S3 de l'agent de test. */
async function binaryResource(
  agent: TestAgent,
  projectId: string,
  path: string,
  bytes: Buffer,
): Promise<CompileResource> {
  const file = join(agent.root, `${randomUUID()}.bin`)
  await writeFile(file, bytes)
  const s3Key = `${projectFilesPrefix(projectId)}${path}`
  agent.files.set(s3Key, file)
  return { path, kind: 'binary', s3Key, sha256: sha256Hex(bytes) }
}

describe.skipIf(!available)(`Markdown conversion with real pandoc (${RUNTIME})`, async () => {
  let agent: TestAgent
  let extracted = ''
  let casesDir = ''
  if (available) {
    extracted = await mkdtemp(join(tmpdir(), 'kaxolax-convert-cases-'))
    casesDir = extractMaliciousCases(extracted)
  }
  const cases = available
    ? (await readdir(casesDir)).filter((name) => name.startsWith('pandoc-')).sort()
    : []
  const plot = await readFile(join(import.meta.dirname, '../../examples/demo/figures/plot.png'))

  beforeAll(async () => {
    agent = await createTestAgent()
  })

  afterAll(async () => {
    await agent.cleanup()
    await rm(extracted, { recursive: true, force: true })
  })

  async function compileConverted(
    projectId: string,
    files: CompileResource[],
    media: ConvertResult['media'],
    root: string,
    compiler: 'pdflatex' | 'xelatex' | 'lualatex' = 'pdflatex',
  ) {
    const resources = [...files]
    for (const item of media) {
      resources.push(
        await binaryResource(
          agent,
          projectId,
          item.path,
          Buffer.from(item.contentBase64, 'base64'),
        ),
      )
    }
    return agent.compiler.compile(compileRequest(projectId, resources, { root, compiler }))
  }

  it('converts rich Markdown into a complete document that compiles', async () => {
    const projectId = randomUUID()
    const result = await agent.compiler.convert({
      projectId,
      sourcePath: 'notes/intro.md',
      targetPath: 'notes/intro.tex',
      markdown: RICH_MARKDOWN,
      media: ['figures/plot.png', 'notes/intro.md'],
    })
    expect(result.title).toBe('Conversion Markdown')
    expect(result.preamble).toBeNull()
    for (const text of [
      '\\documentclass[',
      '\\section{Introduction}',
      '\\footnote{Le texte de la note.}',
      '\\begin{longtable}',
      '\\begin{Shaded}',
      '\\int_0^1 x^2',
      '{../figures/plot.png}',
      `{media/${PNG_NAME}}`,
      'élève',
    ]) {
      expect(result.latex).toContain(text)
    }
    expect(result.latex).not.toContain('KAXOLAX')
    expect(result.media).toEqual([
      expect.objectContaining({ path: `notes/media/${PNG_NAME}`, contentType: 'image/png' }),
    ])
    expect(result.images.map((image) => [image.kind, image.path, image.found])).toEqual([
      ['project', 'figures/plot.png', true],
      ['embedded', `notes/media/${PNG_NAME}`, null],
      ['project', 'figures/absente.png', false],
    ])
    expect(result.warnings).toContain('Image not found in the project: figures/absente.png')
    expect(await readdir(join(agent.compilesDir, CONVERT_DIR))).toEqual([])

    // Le LaTeX produit compile dans le projet, avec l'image du projet et l'image extraite.
    const compiled = await compileConverted(
      projectId,
      [
        textResource('notes/intro.tex', result.latex),
        await binaryResource(agent, projectId, 'figures/plot.png', plot),
        await binaryResource(agent, projectId, 'figures/absente.png', plot),
      ],
      result.media,
      'notes/intro.tex',
    )
    expect(compiled.status).toBe('success')
    await agent.compiler.clearCache(projectId)
  })

  it('converts a fragment whose preamble makes it compile inside an existing document', async () => {
    const projectId = randomUUID()
    const result = await agent.compiler.convert({
      projectId,
      sourcePath: 'chapter.md',
      targetPath: 'chapters/one.tex',
      graphicsDir: '',
      markdown: RICH_MARKDOWN.replaceAll('../figures/', 'figures/'),
      options: { mode: 'fragment', documentClass: 'report', topLevelDivision: 'chapter' },
    })
    expect(result.latex).toMatch(/^\\chapter\{Introduction\}/)
    expect(result.latex).not.toMatch(/documentclass|begin\{document\}|maketitle/)
    expect(result.preamble).toContain('\\usepackage{longtable')
    expect(result.preamble).not.toMatch(/documentclass|\\title|\\author|secnumdepth/)
    expect(result.latex).toContain(`{chapters/media/${PNG_NAME}}`)

    const main = [
      '\\documentclass{report}',
      result.preamble ?? '',
      '\\begin{document}',
      '\\input{chapters/one}',
      '\\end{document}',
    ].join('\n')
    const compiled = await compileConverted(
      projectId,
      [
        textResource('main.tex', main),
        textResource('chapters/one.tex', result.latex),
        await binaryResource(agent, projectId, 'figures/plot.png', plot),
        await binaryResource(agent, projectId, 'figures/absente.png', plot),
      ],
      result.media,
      'main.tex',
      'lualatex',
    )
    expect(compiled.status).toBe('success')
    await agent.compiler.clearCache(projectId)
  })

  it('ships the pandoc malicious cases', () => {
    for (const name of [
      'pandoc-read-files',
      'pandoc-raw-latex',
      'pandoc-math-latex',
      'pandoc-filters',
      'pandoc-extract-media',
      'pandoc-yaml-bomb',
      'pandoc-citation-keys',
    ]) {
      expect(cases).toContain(name)
    }
  })

  it('flags the file and engine commands copied from formulas and metadata', async () => {
    const markdown = await readFile(join(casesDir, 'pandoc-math-latex', 'input.md'), 'utf8')
    const projectId = randomUUID()
    for (const mode of ['document', 'fragment'] as const) {
      const result = await agent.compiler.convert({
        projectId,
        sourcePath: 'input.md',
        targetPath: 'output.tex',
        markdown,
        options: { mode },
      })
      // Recopiées sans échappement (formules, header-includes) : signalées, jamais exécutées ici.
      expect(result.warnings[0]).toBe(
        'Formulas or metadata contain LaTeX commands copied as is: \\input, \\write, ' +
          '\\write18, \\immediate, \\directlua, \\catcode (file and shell access stay ' +
          'blocked when compiling)',
      )
    }
    // Sans formule sensible : aucun avertissement de ce type, même avec un verbatim qui en parle.
    const benign = await agent.compiler.convert({
      projectId,
      sourcePath: 'input.md',
      targetPath: 'output.tex',
      markdown: '# Code\n\n```\n\\input{chapitre}\n```\n\nEt $x^2$.\n',
    })
    expect(benign.warnings.join('\n')).not.toContain('copied as is')
    await agent.compiler.clearCache(projectId)
  })

  it.each(cases)('%s is converted safely through the agent', async (name) => {
    const dir = join(casesDir, name)
    const spec = JSON.parse(await readFile(join(dir, 'case.json'), 'utf8')) as ConvertCase
    const convert = spec.convert ?? {}
    const projectId = randomUUID()
    const hostDir = await mkdtemp(join(tmpdir(), 'kaxolax-host-'))
    const canary = join(hostDir, 'host-canary.txt')
    const canaryContent = `KX-HOST-CANARY-${randomUUID()}`
    await writeFile(canary, canaryContent)
    try {
      const markdown = (await readFile(join(dir, 'input.md'), 'utf8')).replaceAll(
        '@@HOST_CANARY@@',
        canary,
      )
      const sourceDir = convert.sourceDir ?? ''
      let result: ConvertResult | null = null
      let status: string
      try {
        result = await agent.compiler.convert({
          projectId,
          sourcePath: sourceDir === '' ? 'input.md' : `${sourceDir}/input.md`,
          targetPath: 'output.tex',
          graphicsDir: convert.graphicsDir ?? '',
          mediaDir: convert.mediaDir ?? 'media',
          markdown,
          options: {
            mode: convert.mode,
            documentClass: convert.documentClass,
            citations: convert.citations,
            rawLatex: convert.rawLatex,
          },
          // Délai d'une étape, borné comme l'accepte l'API de l'agent.
          timeoutMs: Math.min((spec.timeoutSeconds ?? 30) * 1000, MAX_CONVERT_TIMEOUT_MS),
        })
        status = 'success'
      } catch (error) {
        if (!(error instanceof ConvertError)) throw error
        status = error.reason === 'timeout' ? 'timeout' : 'failure'
      }

      const outputs: string[] = [JSON.stringify(result)]
      if (result !== null && convert.compile !== undefined) {
        const compiled = await compileConverted(
          projectId,
          [textResource('output.tex', result.latex)],
          result.media,
          'output.tex',
          convert.compile,
        )
        status = compiled.status
        outputs.push(JSON.stringify(compiled))
        const files = join(agent.compilesDir, projectId, 'files')
        for (const file of ['output.log', 'output.pdf']) {
          outputs.push(await readFile(join(files, file), 'latin1').catch(() => ''))
        }
        for (const file of ['pwned.txt', 'inline.txt', ...(spec.expect.absentFiles ?? [])]) {
          expect(existsSync(join(files, file))).toBe(false)
        }
      }

      const expected = spec.expect
      expect(expected.status ?? ['success']).toContain(status)
      const latex = result?.latex ?? ''
      for (const text of expected.texContains ?? []) expect(latex).toContain(text)
      for (const text of expected.texLacks ?? []) expect(latex).not.toContain(text)
      // Rapport du filtre tel que l'agent le restitue : images, clés citées, clés refusées
      // (dans les avertissements).
      const report = JSON.stringify({
        images: result?.images ?? [],
        citations: result?.citations ?? [],
        warnings: result?.warnings ?? [],
      })
      for (const text of expected.reportContains ?? []) expect(report).toContain(text)
      const markers = (expected.noLeak ?? []).map((marker) =>
        marker.replace('@@HOST_CANARY_CONTENT@@', canaryContent),
      )
      for (const marker of markers) {
        expect(
          outputs.some((output) => output.includes(marker)),
          `leak of ${marker}`,
        ).toBe(false)
      }
      // Rien ne reste du répertoire de conversion, et rien n'est écrit chez l'hôte.
      expect(await readdir(join(agent.compilesDir, CONVERT_DIR))).toEqual([])
      expect(await readdir(hostDir)).toEqual(['host-canary.txt'])
    } finally {
      await rm(hostDir, { recursive: true, force: true })
      await agent.compiler.clearCache(projectId)
    }
  })
})
