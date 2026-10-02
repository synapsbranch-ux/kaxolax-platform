import { randomUUID } from 'node:crypto'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestAgent, dockerAvailable, RUNTIME, type TestAgent } from './helpers.js'
import { WORD_COUNT_DIR } from '../../src/compiler.js'
import { sha256Hex } from '../../src/workspace.js'

const available = await dockerAvailable()

function text(files: Record<string, string>) {
  return Object.entries(files).map(([path, content]) => ({
    path,
    kind: 'text' as const,
    content,
    sha256: sha256Hex(content),
  }))
}

describe.skipIf(!available)(`word count with real texcount (${RUNTIME})`, () => {
  let agent: TestAgent

  beforeAll(async () => {
    agent = await createTestAgent()
  })

  afterAll(async () => {
    await agent.cleanup()
  })

  it('counts the main document and its included files, by section', async () => {
    const projectId = randomUUID()
    const result = await agent.compiler.wordCount({
      projectId,
      rootResourcePath: 'thesis/main.tex',
      resources: text({
        'thesis/main.tex': [
          '\\documentclass{article}',
          '\\begin{document}',
          '\\section{Introduction générale}',
          'Voici cinq mots accentués : élève.',
          '\\begin{figure}\\caption{Une légende courte}\\end{figure}',
          '\\input{chapters/one}',
          '\\end{document}',
        ].join('\n'),
        'thesis/chapters/one.tex': '\\section{Inclus}\nSept mots dans le fichier inclus ici.\n',
      }),
    })
    expect(result.total).toMatchObject({ text: 12, headers: 3, captions: 3, floatCount: 1 })
    expect(result.sections.map((section) => [section.kind, section.title, section.text])).toEqual([
      ['section', 'Introduction générale', 5],
      ['section', 'Inclus', 7],
    ])
    expect(await readdir(join(agent.compilesDir, WORD_COUNT_DIR))).toEqual([])
  })

  it('never reads a file outside the counted directory', async () => {
    const result = await agent.compiler.wordCount({
      projectId: randomUUID(),
      rootResourcePath: 'thesis/main.tex',
      resources: text({
        'thesis/main.tex': [
          '\\documentclass{article}',
          '\\begin{document}',
          '\\section{Un}',
          'Trois mots ici.',
          '\\input{/etc/hostname}',
          '\\input{../../x}',
          '\\input{/usr/bin/id |}',
          '\\input{../shared/common}',
          '\\end{document}',
        ].join('\n'),
        // Remonter dans le projet reste permis.
        'shared/common.tex': 'Deux mots.\n',
      }),
    })
    expect(result.total).toMatchObject({ text: 5, headers: 1 })
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        'File /etc/hostname not readable.',
        'File /usr/bin/id | not readable.',
      ]),
    )
  })
})
