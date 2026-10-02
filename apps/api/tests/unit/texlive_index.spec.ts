import { randomUUID } from 'node:crypto'
import { test } from '@japa/runner'
import ObjectStorage from '#services/object_storage'
import {
  bucketSource,
  type IndexSource,
  PackageIndexUnavailableException,
  PackageNotFoundException,
  TexliveIndexService,
} from '#services/texlive_index'

function packageEntry(name: string, styles: string[], shortdesc = `${name} package`) {
  return {
    name,
    shortdesc,
    category: 'Package',
    topics: ['maths'],
    license: 'lppl1.3c',
    version: null,
    ctanUrl: `https://ctan.org/pkg/${name}`,
    docUrl: `https://texdoc.org/pkg/${name}`,
    styles,
    collection: 'collection-latex',
  }
}

function indexJson(packages: ReturnType<typeof packageEntry>[], year = 2026) {
  const byStyle: Record<string, string[]> = {}
  for (const entry of packages) {
    for (const style of entry.styles) (byStyle[style] ??= []).push(entry.name)
  }
  return JSON.stringify({ texliveYear: year, generatedFrom: 'texlive.tlpdb', packages, byStyle })
}

const AMSMATH = packageEntry('amsmath', ['amsmath.sty', 'amstext.sty'])
const GRAPHICS = packageEntry('graphics', ['graphics.sty', 'graphicx.sty'])

test.group('TeX Live package index (object storage)', () => {
  test('reads the published index, then revalidates it with its ETag', async ({ assert }) => {
    const storage = new ObjectStorage()
    const key = `test/texlive/${randomUUID()}/packages.json`
    await storage.putBuffer(key, Buffer.from(indexJson([AMSMATH])), 'application/json')
    let now = 0
    const source = bucketSource(storage.bucket, key)
    const reads: (string | null)[] = []
    const index = new TexliveIndexService({
      source: {
        read: async (etag) => {
          reads.push(etag)
          return source.read(etag)
        },
      },
      refreshIntervalMs: 1_000,
      retryAfterErrorMs: 100,
      now: () => now,
    })
    try {
      assert.equal((await index.show('amsmath')).name, 'amsmath')
      const firstEtag = await index.etag()
      assert.match(firstEtag, /^"[0-9a-f]+"$/)

      // Avant l'échéance : aucune lecture. Après : lecture conditionnelle, objet inchangé (304).
      await index.search({ page: 1, perPage: 20 })
      now = 1_500
      await index.search({ page: 1, perPage: 20 })
      await index.revalidate()
      assert.deepEqual(reads, [null, firstEtag])
      assert.equal(await index.etag(), firstEtag)

      // Nouvelle publication : servie après la revalidation suivante (en arrière-plan).
      await storage.putBuffer(key, Buffer.from(indexJson([AMSMATH, GRAPHICS])), 'application/json')
      now = 3_000
      // La copie en mémoire répond tout de suite ; la relecture se fait en arrière-plan.
      assert.equal((await index.current()).etag, firstEtag)
      await index.revalidate()
      assert.notEqual(await index.etag(), firstEtag)
      assert.equal((await index.show('graphicx')).name, 'graphics')
    } finally {
      await storage.delete([key])
    }
  })
})

test.group('TeX Live package index (failures)', () => {
  test('keeps serving the index in memory when the source fails', async ({ assert }) => {
    let now = 0
    let fail = false
    let calls = 0
    const source: IndexSource = {
      read: () => {
        calls++
        return fail
          ? Promise.reject(new Error('R2 is down'))
          : Promise.resolve({ text: indexJson([AMSMATH]), etag: '"v1"' })
      },
    }
    const index = new TexliveIndexService({
      source,
      refreshIntervalMs: 1_000,
      retryAfterErrorMs: 100,
      now: () => now,
    })
    await index.current()
    fail = true
    now = 2_000
    await index.revalidate()
    assert.equal((await index.show('amsmath')).name, 'amsmath')
    assert.equal(calls, 2)
    // Nouvel essai seulement après `retryAfterErrorMs`.
    now = 2_050
    await index.current()
    assert.equal(calls, 2)
    now = 2_200
    await index.current()
    assert.equal(calls, 3)
    assert.equal((await index.show('amsmath')).name, 'amsmath')
  })

  test('without any index, waits before reading the source again after a failure', async ({
    assert,
  }) => {
    let now = 0
    let fail = true
    let calls = 0
    const source: IndexSource = {
      read: () => {
        calls++
        return fail
          ? Promise.reject(new Error('NoSuchKey'))
          : Promise.resolve({ text: indexJson([AMSMATH]), etag: '"v1"' })
      },
    }
    const index = new TexliveIndexService({
      source,
      refreshIntervalMs: 1_000,
      retryAfterErrorMs: 100,
      now: () => now,
    })
    await assert.rejects(() => index.current(), PackageIndexUnavailableException)
    assert.equal(calls, 1)
    // Requêtes suivantes pendant `retryAfterErrorMs` : 503 immédiat, aucune lecture.
    now = 50
    await assert.rejects(
      () => index.search({ page: 1, perPage: 20 }),
      PackageIndexUnavailableException,
    )
    await assert.rejects(() => index.suggest('amsmth'), PackageIndexUnavailableException)
    assert.equal(calls, 1)
    // Nouvel essai après le délai, encore en échec, puis rétabli.
    now = 150
    await assert.rejects(() => index.current(), PackageIndexUnavailableException)
    assert.equal(calls, 2)
    fail = false
    now = 200
    await assert.rejects(() => index.current(), PackageIndexUnavailableException)
    assert.equal(calls, 2)
    now = 260
    assert.equal((await index.show('amsmath')).name, 'amsmath')
    assert.equal(calls, 3)
  })

  test('answers 503 without any index, and 404 for an unknown package', async ({ assert }) => {
    const broken = new TexliveIndexService({
      source: { read: () => Promise.resolve({ text: '{"packages": 3}', etag: null }) },
      refreshIntervalMs: 1_000,
      retryAfterErrorMs: 100,
    })
    await assert.rejects(() => broken.current(), PackageIndexUnavailableException)
    const absent = new TexliveIndexService({
      source: { read: () => Promise.reject(new PackageIndexUnavailableException()) },
      refreshIntervalMs: 1_000,
      retryAfterErrorMs: 100,
    })
    await assert.rejects(
      () => absent.search({ page: 1, perPage: 20 }),
      PackageIndexUnavailableException,
    )

    const index = new TexliveIndexService({
      source: { read: () => Promise.resolve({ text: indexJson([AMSMATH]), etag: null }) },
      refreshIntervalMs: 1_000,
      retryAfterErrorMs: 100,
    })
    await assert.rejects(() => index.show('nothing'), PackageNotFoundException)
    // Sans ETag de la source : empreinte du contenu.
    assert.match(await index.etag(), /^[0-9a-f]{64}$/)
  })
})
