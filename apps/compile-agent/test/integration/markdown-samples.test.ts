import { randomUUID } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  type CompileResource,
  missingRequirements,
  pandocRequirements,
  projectFilesPrefix,
} from '@kaxolax/contracts'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  compileRequest,
  createTestAgent,
  dockerAvailable,
  pandocAvailable,
  RUNTIME,
  type TestAgent,
} from './helpers.js'
import { sha256Hex } from '../../src/workspace.js'

/**
 * Jeu d'exemples Markdown (titres, listes, tableaux, maths, notes, liens, images, blocs de
 * citation, citations bibliographiques `[@clé]` rendues avec natbib) :
 * chaque `<nom>.md` de test/fixtures/markdown est converti en fragment comme le fait l'API
 * (titres `\section` numérotés, images relatives au document principal) et comparé exactement à
 * `<nom>.expected.tex`. Le fragment est ensuite inclus dans le document de départ d'un projet,
 * complété du seul préambule que l'API demande (`pandocRequirements`), et doit compiler.
 * `KAXOLAX_UPDATE_EXPECTED=1` réécrit les résultats attendus (à relire avant de les garder).
 */

const available = (await dockerAvailable()) && pandocAvailable()
const FIXTURES = join(import.meta.dirname, '../fixtures/markdown')
const UPDATE = process.env.KAXOLAX_UPDATE_EXPECTED === '1'
const SAMPLES = readdirSync(FIXTURES)
  .filter((name) => name.endsWith('.md'))
  .map((name) => name.slice(0, -'.md'.length))
  .sort()

/** main.tex d'un nouveau projet (apps/api, `starterDocument`). */
const STARTER = [
  '\\documentclass{article}',
  '\\usepackage[T1]{fontenc}',
  '',
  '\\title{Exemples}',
  '\\author{}',
  '\\date{\\today}',
  '',
  '\\begin{document}',
  '\\maketitle',
  '',
  '@@INPUT@@',
  '',
  '\\end{document}',
  '',
].join('\n')

/** Bibliographie du projet de l'exemple `citations` (compilée par BibTeX avec natbib). */
const REFS_BIB = [
  '@book{knuth84,',
  '  author = {Donald E. Knuth},',
  '  title = {The {\\TeX}book},',
  '  publisher = {Addison-Wesley},',
  '  year = {1984},',
  '}',
  '@book{lamport94,',
  '  author = {Leslie Lamport},',
  '  title = {{\\LaTeX}: A Document Preparation System},',
  '  publisher = {Addison-Wesley},',
  '  year = {1994},',
  '}',
  '',
].join('\n')

function textResource(path: string, content: string): CompileResource {
  return { path, kind: 'text', content, sha256: sha256Hex(content) }
}

describe.skipIf(!available)(`Markdown samples converted by pandoc (${RUNTIME})`, () => {
  let agent: TestAgent
  let plot: Buffer

  beforeAll(async () => {
    agent = await createTestAgent()
    plot = await readFile(join(import.meta.dirname, '../../examples/demo/figures/plot.png'))
  })

  afterAll(async () => {
    await agent.cleanup()
  })

  it('has the nine kinds of samples', () => {
    expect(SAMPLES).toEqual([
      'citations',
      'headings',
      'images',
      'links',
      'lists',
      'math',
      'notes',
      'quotes',
      'tables',
    ])
  })

  it.each(SAMPLES)('%s gives the expected LaTeX, which compiles in a project', async (name) => {
    const projectId = randomUUID()
    const markdown = await readFile(join(FIXTURES, `${name}.md`), 'utf8')
    const result = await agent.compiler.convert({
      projectId,
      sourcePath: `${name}.md`,
      targetPath: `chapters/${name}.tex`,
      graphicsDir: '',
      markdown,
      media: ['figures/plot.png', 'main.tex'],
      options: {
        mode: 'fragment',
        documentClass: 'article',
        topLevelDivision: 'section',
        numberSections: true,
      },
    })
    if (name === 'images') {
      // Image du projet trouvée, image distante changée en lien, image absente signalée.
      expect(result.images.map((image) => [image.kind, image.path, image.found])).toEqual([
        ['project', 'figures/plot.png', true],
        ['project', 'figures/plot.png', true],
        ['remote', null, null],
        ['project', 'figures/absente.png', false],
      ])
      expect(result.warnings).toContain('Image not found in the project: figures/absente.png')
    }
    if (name === 'citations') {
      // Commandes natbib (jamais du texte), clé dangereuse refusée et signalée.
      expect(result.citations).toEqual(['knuth84', 'lamport94'])
      expect(result.latex).toContain('\\citep[p.~3]{knuth84}')
      expect(result.latex).not.toContain('\\input')
      expect(result.warnings).toContain('Citations kept as text (unsupported key): x\\input{main}')
      expect(pandocRequirements(result.latex).packages.map((entry) => entry.name)).toContain(
        'natbib',
      )
    }
    const expectedFile = join(FIXTURES, `${name}.expected.tex`)
    if (UPDATE) await writeFile(expectedFile, result.latex)
    expect(result.latex).toBe(await readFile(expectedFile, 'utf8'))

    // Préambule ajouté au document de départ : seulement ce qui lui manque.
    const required = pandocRequirements(result.latex, result.preamble)
    const missing = missingRequirements(STARTER, required)
    const additions = [
      ...missing.packages.map(
        (entry) =>
          `\\usepackage${entry.options.length > 0 ? `[${entry.options.join(',')}]` : ''}{${entry.name}}`,
      ),
      ...missing.definitions.map((entry) => entry.code),
    ]
    const bibliography =
      result.citations.length > 0 ? '\n\\bibliographystyle{plainnat}\n\\bibliography{refs}' : ''
    const main = STARTER.replace(
      '\\begin{document}',
      `${additions.join('\n')}\n\\begin{document}`,
    ).replace('@@INPUT@@', `\\input{chapters/${name}}${bibliography}`)

    const resources: CompileResource[] = [
      textResource('main.tex', main),
      textResource(`chapters/${name}.tex`, result.latex),
      ...(bibliography === '' ? [] : [textResource('refs.bib', REFS_BIB)]),
    ]
    // L'image signalée absente est ajoutée ensuite par l'utilisateur : le document compile.
    for (const path of ['figures/plot.png', 'figures/absente.png']) {
      const s3Key = `${projectFilesPrefix(projectId)}${path}`
      const file = join(agent.root, `${randomUUID()}.png`)
      await writeFile(file, plot)
      agent.files.set(s3Key, file)
      resources.push({ path, kind: 'binary', s3Key, sha256: sha256Hex(plot) })
    }
    for (const media of result.media) {
      const bytes = Buffer.from(media.contentBase64, 'base64')
      const key = `${projectFilesPrefix(projectId)}${media.path}`
      const mediaFile = join(agent.root, `${randomUUID()}.bin`)
      await writeFile(mediaFile, bytes)
      agent.files.set(key, mediaFile)
      resources.push({ path: media.path, kind: 'binary', s3Key: key, sha256: sha256Hex(bytes) })
    }
    const compiled = await agent.compiler.compile(compileRequest(projectId, resources))
    expect(compiled.status, JSON.stringify(compiled.entries.slice(0, 5))).toBe('success')
    if (name === 'citations') {
      // Références résolues par BibTeX : aucune citation indéfinie.
      expect(JSON.stringify(compiled.entries)).not.toMatch(/Citation .* undefined/)
    }
    await agent.compiler.clearCache(projectId)
  })
})
