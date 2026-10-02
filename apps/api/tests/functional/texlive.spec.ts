import {
  packageSuggestionsSchema,
  texlivePackageDetailSchema,
  texlivePackageListSchema,
} from '@kaxolax/contracts'
import { test } from '@japa/runner'
import { createUser } from '#tests/helpers'

// En test, aucun bucket n'est configuré : l'API sert la fixture (resources/fixtures).
test.group('TeX Live package index', () => {
  test('requires a signed-in user', async ({ client }) => {
    ;(await client.get('/api/v1/texlive/packages')).assertStatus(401)
    ;(await client.get('/api/v1/texlive/suggestions?name=amsmth')).assertStatus(401)
  })

  test('lists and searches packages, with pagination and filters', async ({ client, assert }) => {
    const user = await createUser()
    const all = await client.get('/api/v1/texlive/packages?perPage=5&page=2').loginAs(user)
    all.assertStatus(200)
    const list = texlivePackageListSchema.parse(all.body())
    assert.equal(list.texliveYear, 2026)
    assert.equal(list.page, 2)
    assert.lengthOf(list.packages, 5)
    assert.isAbove(list.total, 50)

    // Un nom de fichier .sty trouve le package qui le fournit, en premier.
    const graphicx = await client.get('/api/v1/texlive/packages?q=graphicx').loginAs(user)
    const found = texlivePackageListSchema.parse(graphicx.body())
    assert.deepInclude(found.packages[0] ?? {}, {
      name: 'graphics',
      ctanUrl: 'https://ctan.org/pkg/latex-graphics',
      docUrl: 'https://texdoc.org/pkg/graphics',
    })
    assert.include(found.packages[0]?.usepackage ?? [], 'graphicx')
    assert.equal(found.packages[0]?.usepackage[0], 'graphics')

    // Un .sty au-delà des premiers noms du résumé est rendu dans `matchingUsepackage`.
    const typearea = await client.get('/api/v1/texlive/packages?q=typear').loginAs(user)
    const koma = texlivePackageListSchema
      .parse(typearea.body())
      .packages.find((entry) => entry.name === 'koma-script')
    assert.notInclude(koma?.usepackage ?? [], 'typearea')
    assert.deepEqual(koma?.matchingUsepackage, ['typearea'])
    assert.isUndefined(list.packages[0]?.matchingUsepackage)

    // Tous les mots de la recherche, dans la description aussi.
    const described = await client
      .get('/api/v1/texlive/packages')
      .qs({ q: 'hypertext support' })
      .loginAs(user)
    assert.deepEqual(
      texlivePackageListSchema.parse(described.body()).packages.map((entry) => entry.name),
      ['hyperref'],
    )

    const maths = await client
      .get('/api/v1/texlive/packages')
      .qs({ topic: 'maths', perPage: 100 })
      .loginAs(user)
    const names = texlivePackageListSchema.parse(maths.body()).packages.map((entry) => entry.name)
    assert.include(names, 'amsmath')
    assert.notInclude(names, 'hyperref')

    const core = await client.get('/api/v1/texlive/packages?category=TLCore').loginAs(user)
    assert.deepEqual(
      texlivePackageListSchema.parse(core.body()).packages.map((entry) => entry.name),
      ['koma-script'],
    )
    ;(await client.get('/api/v1/texlive/packages?perPage=1000').loginAs(user)).assertStatus(422)
  })

  test('shows a package by name or by style file', async ({ client, assert }) => {
    const user = await createUser()
    const byName = await client.get('/api/v1/texlive/packages/amsmath').loginAs(user)
    byName.assertStatus(200)
    const detail = texlivePackageDetailSchema.parse(byName.body())
    assert.include(detail, {
      name: 'amsmath',
      shortdesc: 'AMS mathematical facilities for LaTeX',
      category: 'Package',
      ctanUrl: 'https://ctan.org/pkg/latex-amsmath',
      texliveYear: 2026,
    })
    assert.equal(detail.usepackage[0], 'amsmath')
    assert.include(detail.styles, 'amsmath.sty')

    const byStyle = await client.get('/api/v1/texlive/packages/graphicx').loginAs(user)
    assert.equal(byStyle.body().name, 'graphics')
    const missing = await client.get('/api/v1/texlive/packages/nothing-here').loginAs(user)
    missing.assertStatus(404)
    assert.equal(missing.body().code, 'E_PACKAGE_NOT_FOUND')
  })

  test('suggests close names for a missing package or class', async ({ client, assert }) => {
    const user = await createUser()
    for (const [name, expected] of [
      ['amsmth', 'amsmath'],
      ['graphix.sty', 'graphicx'],
      ['hyperef', 'hyperref'],
    ] as const) {
      const response = await client.get('/api/v1/texlive/suggestions').qs({ name }).loginAs(user)
      response.assertStatus(200)
      const body = packageSuggestionsSchema.parse(response.body())
      assert.equal(body.suggestions[0]?.name, expected, name)
    }
    const cls = await client
      .get('/api/v1/texlive/suggestions')
      .qs({ name: 'artcle.cls' })
      .loginAs(user)
    assert.include(cls.body(), { query: 'artcle', kind: 'class', exists: false })
    assert.equal(cls.body().suggestions[0].name, 'article')
    ;(
      await client.get('/api/v1/texlive/suggestions').qs({ name: 'a\\b' }).loginAs(user)
    ).assertStatus(422)
  })

  test('answers 304 to a request that already has the current version', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const first = await client.get('/api/v1/texlive/suggestions?name=amsmth').loginAs(user)
    const etag = String(first.header('etag'))
    assert.match(etag, /^W\/"[\w-]+"$/)
    assert.equal(first.header('cache-control'), 'private, max-age=3600')

    const again = await client
      .get('/api/v1/texlive/suggestions?name=amsmth')
      .header('if-none-match', etag)
      .loginAs(user)
    again.assertStatus(304)
    // Une autre URL a un autre ETag.
    const other = await client
      .get('/api/v1/texlive/suggestions?name=graphix')
      .header('if-none-match', etag)
      .loginAs(user)
    other.assertStatus(200)
    assert.notEqual(other.header('etag'), etag)
  })
})
