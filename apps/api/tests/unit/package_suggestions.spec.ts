import { test } from '@japa/runner'
import texliveConfig from '#config/texlive'
import { editDistance, maxDistanceFor, suggestPackages } from '#services/package_suggestions'
import { fileSource, TexliveIndexService } from '#services/texlive_index'

/** Index de la fixture (sous-ensemble réel de TeX Live 2026). */
function fixtureIndex() {
  return new TexliveIndexService({
    source: fileSource(texliveConfig.fixturePath),
    refreshIntervalMs: 60_000,
    retryAfterErrorMs: 1_000,
  })
}

test.group('package suggestions', () => {
  test('edit distance counts insertions, deletions, substitutions and transpositions', ({
    assert,
  }) => {
    assert.equal(editDistance('amsmth', 'amsmath'), 1)
    assert.equal(editDistance('graphix', 'graphicx'), 1)
    assert.equal(editDistance('hyperef', 'hyperref'), 1)
    assert.equal(editDistance('amsmaht', 'amsmath'), 1)
    assert.equal(editDistance('xcolour', 'xcolor'), 1)
    assert.equal(editDistance('tikz', 'tikz'), 0)
    assert.equal(editDistance('', 'abc'), 3)
    // Au-delà du plafond, le calcul s'arrête : max + 1.
    assert.equal(editDistance('amsmath', 'hyperref', 2), 3)
    assert.equal(editDistance('a', 'abcdef', 2), 3)
  })

  test('tolerates more mistakes in longer names', ({ assert }) => {
    assert.equal(maxDistanceFor('tikz'), 1)
    assert.equal(maxDistanceFor('graphix'), 2)
    assert.equal(maxDistanceFor('babel-french'), 3)
  })

  test('suggests the right package for common typos', async ({ assert }) => {
    const index = fixtureIndex()
    const cases: [string, string, string][] = [
      ['amsmth', 'amsmath', 'amsmath'],
      ['amsmth.sty', 'amsmath', 'amsmath'],
      ['graphix', 'graphicx', 'graphics'],
      ['hyperef', 'hyperref', 'hyperref'],
      ['geomtry', 'geometry', 'geometry'],
      ['biblatx', 'biblatex', 'biblatex'],
      ['xcolour', 'xcolor', 'xcolor'],
      ['fontspc', 'fontspec', 'fontspec'],
      ['Hyperref', 'hyperref', 'hyperref'],
    ]
    for (const [query, name, packageName] of cases) {
      const result = await index.suggest(query)
      assert.equal(result.kind, 'package', query)
      assert.deepInclude(result.suggestions[0] ?? {}, { name, package: packageName }, query)
    }
    const graphix = await index.suggest('graphix.sty')
    assert.deepEqual(graphix.suggestions[0], {
      name: 'graphicx',
      file: 'graphicx.sty',
      package: 'graphics',
      shortdesc: 'The LaTeX standard graphics bundle',
      distance: 1,
    })
    assert.isFalse(graphix.exists)
    assert.equal(graphix.query, 'graphix')
  })

  test('looks for classes when the missing file is a .cls', async ({ assert }) => {
    const result = await fixtureIndex().suggest('artcle.cls')
    assert.equal(result.kind, 'class')
    assert.deepInclude(result.suggestions[0] ?? {}, { name: 'article', file: 'article.cls' })
    assert.isTrue(result.suggestions.every((suggestion) => suggestion.file.endsWith('.cls')))
  })

  test('reports a file that exists in TeX Live, and completes a prefix', async ({ assert }) => {
    const index = fixtureIndex()
    const existing = await index.suggest('booktabs.sty')
    assert.isTrue(existing.exists)
    assert.deepInclude(existing.suggestions[0] ?? {}, { name: 'booktabs', distance: 0 })

    const prefix = await index.suggest('hyper')
    assert.include(
      prefix.suggestions.map((suggestion) => suggestion.name),
      'hyperref',
    )
    // Rien de proche : aucune suggestion plutôt qu'un nom au hasard.
    assert.deepEqual((await index.suggest('zzzzzzzzzz')).suggestions, [])
  })

  test('breaks ties with common packages, then by name', ({ assert }) => {
    const entries = ['graphbox', 'graphicx', 'graphics'].map((name) => ({
      name,
      file: `${name}.sty`,
      kind: 'package' as const,
      packages: [name],
    }))
    const names = suggestPackages('graphic', 'package', entries, () => null).map(
      (suggestion) => suggestion.name,
    )
    // graphicx et graphics : distance 1 et préfixe, graphicx est courant ; graphbox est trop loin.
    assert.deepEqual(names, ['graphicx', 'graphics'])
  })
})
