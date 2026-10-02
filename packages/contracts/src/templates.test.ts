import { describe, expect, it } from 'vitest'
import {
  createProjectFromTemplateSchema,
  filterTemplates,
  matchesTemplateQuery,
  normalizeTemplateText,
  templateCatalogSchema,
  templateListQuerySchema,
} from './templates.js'

const SHA = 'a'.repeat(64)

function entry(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    title: `Template ${id}`,
    category: 'article',
    description: 'Une description assez longue pour la galerie.',
    compiler: 'pdflatex',
    license: 'CC0-1.0',
    mainDocument: 'main.tex',
    tags: ['article'],
    language: 'fr',
    files: {
      pdf: { path: `${id}/${id}.pdf`, bytes: 10, sha256: SHA },
      thumbnail: { path: `${id}/${id}.png`, bytes: 10, sha256: SHA, width: 600, height: 849 },
      zip: { path: `${id}/${id}.zip`, bytes: 10, sha256: SHA },
    },
    ...overrides,
  }
}

function catalog(templates: unknown[], overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    generatedAt: '2026-10-01T18:27:20Z',
    source: { commit: '0123456789abcdef0123456789abcdef01234567', texliveImage: 'image:tag' },
    templates,
    ...overrides,
  }
}

describe('template catalog (contract v1)', () => {
  it('accepts a published catalog and ignores unknown fields', () => {
    const parsed = templateCatalogSchema.parse(
      catalog([{ ...entry('cv-moderne'), futureField: true }], { extra: 1 }),
    )
    expect(parsed.templates[0]?.id).toBe('cv-moderne')
    expect(parsed.templates[0]).not.toHaveProperty('futureField')
    expect(parsed).not.toHaveProperty('extra')
  })

  it('accepts a catalog built without commit nor image', () => {
    expect(
      templateCatalogSchema.safeParse(
        catalog([entry('a-b')], { source: { commit: null, texliveImage: null } }),
      ).success,
    ).toBe(true)
  })

  it('refuses another version, unsafe paths, bad hashes and duplicate ids', () => {
    expect(templateCatalogSchema.safeParse(catalog([entry('a-b')], { version: 2 })).success).toBe(
      false,
    )
    const unsafe = entry('a-b')
    unsafe.files.zip.path = '../secret.zip'
    expect(templateCatalogSchema.safeParse(catalog([unsafe])).success).toBe(false)
    const absolute = entry('a-b')
    absolute.files.pdf.path = '/etc/passwd'
    expect(templateCatalogSchema.safeParse(catalog([absolute])).success).toBe(false)
    for (const path of ['http:169.254.169.254', 'javascript:alert(1)%2F%2F', 'a/b.zip?x=1']) {
      const external = entry('a-b')
      external.files.zip.path = path
      expect(templateCatalogSchema.safeParse(catalog([external])).success).toBe(false)
    }
    const hash = entry('a-b')
    hash.files.thumbnail.sha256 = 'XYZ'
    expect(templateCatalogSchema.safeParse(catalog([hash])).success).toBe(false)
    expect(templateCatalogSchema.safeParse(catalog([entry('a-b'), entry('a-b')])).success).toBe(
      false,
    )
  })

  it('validates the metadata like the template repository', () => {
    const invalid = [
      { id: 'Not_Kebab' },
      { category: 'poster' },
      { compiler: 'context' },
      { license: 'GPL-3.0' },
      { mainDocument: 'main.pdf' },
      { mainDocument: '../main.tex' },
      { tags: [] },
      { tags: ['a-b', 'a-b'] },
      { description: 'trop court' },
      { language: 'de' },
    ]
    for (const overrides of invalid) {
      expect(
        templateCatalogSchema.safeParse(catalog([entry('a-b', overrides)])).success,
        JSON.stringify(overrides),
      ).toBe(false)
    }
    expect(
      templateCatalogSchema.safeParse(catalog([entry('a-b', { mainDocument: 'src/these_v2.tex' })]))
        .success,
    ).toBe(true)
  })
})

describe('template search', () => {
  type Searchable = Parameters<typeof matchesTemplateQuery>[0]
  const these = entry('these-doctorat', {
    title: 'Thèse de doctorat',
    category: 'these',
    tags: ['these', 'koma-script'],
  }) as Searchable
  const cv = entry('cv-moderne', {
    title: 'CV moderne',
    category: 'cv',
    compiler: 'xelatex',
    tags: ['cv', 'fontspec'],
  }) as Searchable
  const twoColumns = entry('article-deux-colonnes', {
    title: 'Two-column article',
    language: 'en',
    tags: ['ieee', 'conference'],
  }) as Searchable
  const article = entry('article-scientifique', {
    title: 'Article scientifique',
    tags: ['amsmath'],
  }) as Searchable
  const templates = [these, cv, twoColumns, article]

  it('normalizes accents, case and punctuation', () => {
    expect(normalizeTemplateText('  Thèse — DOCTORAT ! ')).toBe('these doctorat')
  })

  it('matches every word as a prefix, without accents', () => {
    expect(matchesTemplateQuery(these, { q: 'thèse doc' })).toBe(true)
    expect(matchesTemplateQuery(these, { q: 'THESE' })).toBe(true)
    expect(matchesTemplateQuery(these, { q: 'octorat' })).toBe(false)
    expect(matchesTemplateQuery(cv, { q: 'fontspec' })).toBe(true)
    expect(matchesTemplateQuery(cv, { q: 'cv', compiler: 'pdflatex' })).toBe(false)
    expect(matchesTemplateQuery(twoColumns, { language: 'en' })).toBe(true)
  })

  it('filters, sorts by gallery category then title, and counts per category', () => {
    const all = filterTemplates(templates, {})
    expect(all.templates.map((template) => template.id)).toEqual([
      'cv-moderne',
      'these-doctorat',
      'article-scientifique',
      'article-deux-colonnes',
    ])
    const articles = filterTemplates(templates, { category: 'article', language: 'fr' })
    expect(articles.templates.map((template) => template.id)).toEqual(['article-scientifique'])
    // Les compteurs ignorent le filtre de catégorie, pas les autres critères.
    expect(articles.categories).toEqual([
      { id: 'cv', count: 1 },
      { id: 'these', count: 1 },
      { id: 'article', count: 1 },
      { id: 'presentation', count: 0 },
      { id: 'lettre', count: 0 },
      { id: 'rapport', count: 0 },
    ])
  })

  it('validates list queries and creation bodies', () => {
    expect(templateListQuerySchema.parse({ q: '  cv  ' })).toEqual({ q: 'cv' })
    expect(templateListQuerySchema.safeParse({ category: 'poster' }).success).toBe(false)
    expect(
      createProjectFromTemplateSchema.parse({ templateId: 'cv-moderne', name: ' Mon CV ' }),
    ).toEqual({ templateId: 'cv-moderne', name: 'Mon CV' })
    expect(
      createProjectFromTemplateSchema.safeParse({ templateId: 'cv-moderne', name: 'a\nb' }).success,
    ).toBe(false)
    expect(
      createProjectFromTemplateSchema.safeParse({ templateId: 'cv-moderne', extra: 1 }).success,
    ).toBe(false)
  })
})
