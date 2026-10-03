import { test } from '@japa/runner'
import {
  appendBibEntry,
  assignCitationKey,
  bibEntries,
  bibKeys,
  firstBibEntry,
  MANAGED_BIB_HEADER,
  managedBibliography,
  shortCreators,
  withCitationKey,
  yearOf,
} from '#services/zotero/bib'

const ADA = '@article{lovelace_1843,\n  title = {Notes {on} the Engine},\n  year = {1843}\n}'
const CHARLES = '@book(babbage_1864, title = {Passages (life)}, year = 1864)'

test.group('zotero: bib helpers', () => {
  test('finds entries with braces or parentheses and skips string, preamble and comment', ({
    assert,
  }) => {
    const text = `% en-tête\n@string{ieee = "IEEE"}\n${ADA}\n@comment{rien}\n@preamble{"x"}\n${CHARLES}\n`
    assert.deepEqual(
      bibEntries(text).map((entry) => entry.key),
      ['lovelace_1843', 'babbage_1864'],
    )
    const [first] = bibEntries(text)
    assert.equal(text.slice(first?.from, first?.to), ADA)
    assert.deepEqual([...bibKeys(text)], ['lovelace_1843', 'babbage_1864'])
  })

  test('ignores malformed entries and resumes at the next one', ({ assert }) => {
    assert.deepEqual([...bibKeys('@article{unterminated, title = {x}\n@misc{ok, a = 1}')], ['ok'])
    assert.deepEqual([...bibKeys('@article{no_comma}\n@misc{ok, a = 1}')], ['ok'])
    assert.deepEqual([...bibKeys('mail@example.com @misc{ok, a = 1}')], ['ok'])
    assert.isNull(firstBibEntry('nothing here'))
    assert.deepEqual(firstBibEntry(`\n${CHARLES}\n`), { key: 'babbage_1864', text: CHARLES })
  })

  test('builds the managed bibliography once per Zotero item', ({ assert }) => {
    const built = managedBibliography(
      [
        { itemKey: 'AAAA2222', text: ADA },
        { itemKey: 'AAAA2222', text: ADA },
        { itemKey: 'BBBB3333', text: CHARLES },
        { itemKey: 'NOTE2345', text: '' },
      ],
      {},
    )
    assert.isTrue(built.content.startsWith(MANAGED_BIB_HEADER))
    assert.deepEqual(
      bibEntries(built.content).map((entry) => entry.key),
      ['lovelace_1843', 'babbage_1864'],
    )
    assert.deepEqual(built.citationKeys, { AAAA2222: 'lovelace_1843', BBBB3333: 'babbage_1864' })
    assert.equal(built.renamed, 0)
    assert.equal(managedBibliography([], {}).content, MANAGED_BIB_HEADER)
    // Mêmes éléments : même texte (synchro idempotente).
    const again = managedBibliography([{ itemKey: 'AAAA2222', text: ADA }], built.citationKeys)
    assert.equal(
      again.content,
      managedBibliography([{ itemKey: 'AAAA2222', text: ADA }], {}).content,
    )
  })

  test('gives distinct items with the same citation key distinct, stable keys', ({ assert }) => {
    const x = '@article{smith2020,\n  title = {X}\n}'
    const y = '@article{smith2020,\n  title = {Y}\n}'
    const first = managedBibliography(
      [
        { itemKey: 'XXXX2222', text: x },
        { itemKey: 'YYYY3333', text: y },
      ],
      {},
    )
    assert.deepEqual(first.citationKeys, { XXXX2222: 'smith2020', YYYY3333: 'smith2020a' })
    assert.equal(first.renamed, 1)
    assert.include(first.content, '@article{smith2020a,\n  title = {Y}')
    // L'élément choisi avant (Y = smith2020) garde sa clé quand X arrive dans la collection.
    const kept = managedBibliography(
      [
        { itemKey: 'XXXX2222', text: x },
        { itemKey: 'YYYY3333', text: y },
      ],
      { YYYY3333: 'smith2020' },
    )
    assert.deepEqual(kept.citationKeys, { XXXX2222: 'smith2020a', YYYY3333: 'smith2020' })
    assert.include(kept.content, '@article{smith2020,\n  title = {Y}')
    // Une clé attribuée qui ne dérive plus de celle de Zotero (année corrigée) est refaite.
    assert.deepEqual(
      managedBibliography([{ itemKey: 'YYYY3333', text: y }], { YYYY3333: 'smith2019' })
        .citationKeys,
      { YYYY3333: 'smith2020' },
    )
  })

  test('avoids the keys of the other .bib files for new keys only', ({ assert }) => {
    const x = '@article{smith2020,\n  title = {X}\n}'
    const reserved = new Set(['smith2020'])
    const fresh = managedBibliography([{ itemKey: 'XXXX2222', text: x }], {}, reserved)
    assert.deepEqual(fresh.citationKeys, { XXXX2222: 'smith2020a' })
    // Une clé déjà attribuée (citée dans le texte) ne change pas.
    const kept = managedBibliography(
      [{ itemKey: 'XXXX2222', text: x }],
      { XXXX2222: 'smith2020' },
      reserved,
    )
    assert.deepEqual(kept.citationKeys, { XXXX2222: 'smith2020' })
  })

  test('assigns free citation keys and rewrites an entry key', ({ assert }) => {
    assert.equal(assignCitationKey('smith2020', undefined, new Set()), 'smith2020')
    assert.equal(
      assignCitationKey('smith2020', undefined, new Set(['smith2020', 'smith2020a'])),
      'smith2020b',
    )
    const many = new Set(['k', ...'abcdefghijklmnopqrstuvwxyz'.split('').map((c) => `k${c}`)])
    assert.equal(assignCitationKey('k', undefined, many), 'kaa')
    assert.equal(assignCitationKey('smith2020', 'smith2020c', new Set(['smith2020'])), 'smith2020c')
    assert.equal(
      withCitationKey(CHARLES, 'babbage_1864a'),
      CHARLES.replace('babbage_1864', 'babbage_1864a'),
    )
    assert.equal(withCitationKey(`\n${ADA}`, 'x'), `\n${ADA.replace('lovelace_1843', 'x')}`)
  })

  test('appends an entry after a blank line', ({ assert }) => {
    assert.equal(appendBibEntry('', CHARLES), `${CHARLES}\n`)
    assert.equal(appendBibEntry(`${ADA}\n\n\n`, CHARLES), `${ADA}\n\n${CHARLES}\n`)
  })

  test('abbreviates creators and reads years', ({ assert }) => {
    assert.equal(shortCreators([]), '')
    assert.equal(shortCreators([{ lastName: 'Lovelace', creatorType: 'author' }]), 'Lovelace')
    assert.equal(
      shortCreators([
        { lastName: 'Lovelace', creatorType: 'author' },
        { lastName: 'Babbage', creatorType: 'author' },
        { lastName: 'Editor', creatorType: 'editor' },
      ]),
      'Lovelace et Babbage',
    )
    assert.equal(
      shortCreators([{ lastName: 'A' }, { lastName: 'B' }, { name: 'Royal Society' }]),
      'A et al.',
    )
    assert.equal(shortCreators([{ name: 'W3C', creatorType: 'contributor' }]), 'W3C')
    assert.equal(yearOf('1864-01-01'), '1864')
    assert.equal(yearOf('March 2020'), '2020')
    assert.isNull(yearOf('n.d.'))
  })
})
