import { SEARCH_PREVIEW_LENGTH } from '@kaxolax/contracts'
import { test } from '@japa/runner'
import {
  InvalidSearchPatternException,
  ProjectSearches,
  SearchSupersededException,
  TooManySearchesException,
} from '#services/project_search'
import { searchDocuments } from '#services/project_search_engine'

const doc = (content: string, path = 'main.tex') => ({
  id: '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f',
  path,
  content,
})
const query = (q: string, regex = false) => ({
  q,
  regex,
  caseSensitive: false,
  wholeWord: false,
})

test.group('searchDocuments', () => {
  test('skips empty matches without looping', ({ assert }) => {
    const result = searchDocuments([doc('ab\n\n😀c')], query('x*|^', true))
    assert.deepEqual(result.matches, [])
    assert.isFalse(result.truncated)
  })

  test('counts columns in UTF-16 units and handles CRLF', ({ assert }) => {
    const result = searchDocuments([doc('é😀 café\r\nCafé')], query('café'))
    assert.deepEqual(
      result.matches.map((match) => [match.line, match.column, match.length]),
      [
        [1, 4, 4],
        [2, 0, 4],
      ],
    )
  })

  test('centres the preview of a long line on the match', ({ assert }) => {
    const line = `${'a'.repeat(1000)}needle${'b'.repeat(1000)}`
    const [match] = searchDocuments([doc(line)], query('needle')).matches
    assert.lengthOf(match?.preview ?? '', SEARCH_PREVIEW_LENGTH)
    const start = match?.previewStart ?? 0
    assert.equal(match?.preview.slice(start, start + 6), 'needle')
  })

  test('matches whole words with Unicode letters', ({ assert }) => {
    const result = searchDocuments([doc('été étés _été été')], {
      ...query('été'),
      wholeWord: true,
    })
    assert.deepEqual(
      result.matches.map((match) => match.column),
      [0, 14],
    )
  })
})

test.group('ProjectSearches (worker)', (group) => {
  const searches = new ProjectSearches({ maxConcurrent: 1 })
  group.teardown(() => searches.close())
  const catastrophic = [doc(`${'a'.repeat(40)}!`)]
  const load = (documents: typeof catastrophic) => () => Promise.resolve(documents)

  test('runs off the main thread: the event loop keeps turning', async ({ assert }) => {
    let ticks = 0
    const interval = setInterval(() => {
      ticks += 1
    }, 10)
    const result = await searches.search('user-a', query('^(a+)+$', true), load(catastrophic), {
      timeLimitMs: 300,
    })
    clearInterval(interval)
    assert.isTrue(result.timedOut)
    // Recherche bloquante sur le fil principal : aucun tick pendant 300 ms.
    assert.isAbove(ticks, 10)
  })

  test('a newer search of the same user supersedes the running one', async ({ assert }) => {
    // Rejet observé dès le départ : il arrive pendant la seconde recherche.
    const slow = searches
      .search('user-a', query('^(a+)+$', true), load(catastrophic), { timeLimitMs: 2_000 })
      .then(
        () => null,
        (error: unknown) => error,
      )
    await new Promise((resolve) => setTimeout(resolve, 50))
    const fast = await searches.search('user-a', query('a'), load([doc('abc')]))
    assert.lengthOf(fast.matches, 1)
    assert.instanceOf(await slow, SearchSupersededException)
  })

  test('refuses a search when every slot of the process is busy', async ({ assert }) => {
    const slow = searches.search('user-a', query('^(a+)+$', true), load(catastrophic), {
      timeLimitMs: 300,
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    await assert.rejects(
      () => searches.search('user-b', query('a'), load([doc('abc')])),
      TooManySearchesException,
    )
    assert.isTrue((await slow).timedOut)
  })

  test('rejects an invalid pattern before running anything', async ({ assert }) => {
    await assert.rejects(
      () => searches.search('user-a', query('(unclosed', true), load([])),
      InvalidSearchPatternException,
    )
  })
})
