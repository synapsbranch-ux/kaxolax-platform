import { describe, expect, it } from 'vitest'
import {
  MAX_TEXLIVE_PACKAGES_PER_PAGE,
  packageSuggestionsQuerySchema,
  texliveIndexSchema,
  texlivePackagesQuerySchema,
} from './texlive.js'

describe('texliveIndexSchema', () => {
  it('lit le format de package-index.py et ignore les champs inconnus', () => {
    const index = texliveIndexSchema.parse({
      texliveYear: 2026,
      generatedFrom: 'texlive.tlpdb',
      future: true,
      packages: [
        {
          name: 'graphics',
          shortdesc: 'The LaTeX standard graphics bundle',
          category: 'Package',
          topics: ['graphics'],
          license: 'lppl1.3c',
          version: null,
          ctanUrl: 'https://ctan.org/pkg/latex-graphics',
          docUrl: 'https://texdoc.org/pkg/graphics',
          styles: ['graphics.sty', 'graphicx.sty'],
          collection: 'collection-latex',
        },
      ],
      byStyle: { 'graphicx.sty': ['graphics'] },
    })
    expect(index.packages[0]?.name).toBe('graphics')
    expect(index).not.toHaveProperty('future')
  })
})

describe('texlivePackagesQuerySchema', () => {
  it('applique les valeurs par défaut et borne la pagination', () => {
    expect(texlivePackagesQuerySchema.parse({})).toEqual({ page: 1, perPage: 20 })
    expect(texlivePackagesQuerySchema.parse({ page: '3', perPage: '50', q: ' tikz ' })).toEqual({
      page: 3,
      perPage: 50,
      q: 'tikz',
    })
    expect(
      texlivePackagesQuerySchema.safeParse({ perPage: MAX_TEXLIVE_PACKAGES_PER_PAGE + 1 }).success,
    ).toBe(false)
  })
})

describe('packageSuggestionsQuerySchema', () => {
  it('accepte un nom ou un fichier, refuse le code TeX', () => {
    expect(packageSuggestionsQuerySchema.safeParse({ name: 'amsmth.sty' }).success).toBe(true)
    expect(packageSuggestionsQuerySchema.safeParse({ name: 'a}b' }).success).toBe(false)
    expect(packageSuggestionsQuerySchema.safeParse({ name: '' }).success).toBe(false)
  })
})
