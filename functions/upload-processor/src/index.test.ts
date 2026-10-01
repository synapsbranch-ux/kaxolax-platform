import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { MAX_TEXT_DOCUMENT_BYTES } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import { processUpload, UploadRejectedError, type UploadSource } from './index.js'

const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex')

/**
 * Stockage en mémoire ; `reportedSize` simule un objet remplacé après la vérification.
 * Morceaux de 7 octets par défaut : le calcul du hash ne dépend pas du découpage.
 */
function memory(
  objects: Record<string, Uint8Array>,
  { reportedSize, chunkSize = 7 }: { reportedSize?: number; chunkSize?: number } = {},
): UploadSource {
  return {
    size: (key) => Promise.resolve(objects[key] ? (reportedSize ?? objects[key].byteLength) : null),
    read: (key) => {
      const bytes = objects[key] ?? new Uint8Array()
      const chunks = Array.from({ length: Math.ceil(bytes.length / chunkSize) }, (_, index) =>
        Buffer.from(bytes.subarray(index * chunkSize, (index + 1) * chunkSize)),
      )
      return Promise.resolve(Readable.from(chunks))
    },
  }
}

const input = (filename: string, size: number) => ({
  key: 'uploads/1',
  filename,
  declaredSizeBytes: size,
  maxSizeBytes: 1024 * 1024 * 100,
})

describe('processUpload', () => {
  it('turns a UTF-8 text file into a text document', async () => {
    const bytes = new TextEncoder().encode('@book{knuth, title = {Le TeXbook é}}\n')
    const result = await processUpload(
      input('refs.bib', bytes.length),
      memory({ 'uploads/1': bytes }),
    )
    expect(result).toEqual({
      kind: 'text',
      content: '@book{knuth, title = {Le TeXbook é}}\n',
      sha256: sha256(bytes),
      sizeBytes: bytes.length,
    })
  })

  it('keeps images, invalid UTF-8 and large text files as binaries', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3])
    expect(
      await processUpload(input('plot.png', png.length), memory({ 'uploads/1': png })),
    ).toEqual({
      kind: 'binary',
      sha256: sha256(png),
      sizeBytes: png.length,
      mimeType: 'image/png',
    })

    const latin1 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9]) // « café » en Latin-1
    const invalid = await processUpload(input('notes.tex', 4), memory({ 'uploads/1': latin1 }))
    expect(invalid.kind).toBe('binary')

    const large = new Uint8Array(MAX_TEXT_DOCUMENT_BYTES).fill(0x61)
    const tooLarge = await processUpload(
      input('big.tex', large.length),
      // 2 Mio en morceaux de 64 Kio (et non de 7 octets, soit 300 000 morceaux, trop lent en CI).
      memory({ 'uploads/1': large }, { chunkSize: 64 * 1024 }),
    )
    expect(tooLarge).toMatchObject({ kind: 'binary', mimeType: 'application/octet-stream' })
  })

  it('rejects a missing object, a size mismatch and an object over the limit', async () => {
    const bytes = new TextEncoder().encode('hello')
    await expect(processUpload(input('a.txt', 5), memory({}))).rejects.toMatchObject({
      code: 'E_UPLOAD_MISSING',
    })
    await expect(
      processUpload(input('a.txt', 4), memory({ 'uploads/1': bytes })),
    ).rejects.toMatchObject({ code: 'E_UPLOAD_SIZE_MISMATCH' })
    await expect(
      processUpload({ ...input('a.txt', 5), maxSizeBytes: 4 }, memory({ 'uploads/1': bytes })),
    ).rejects.toBeInstanceOf(UploadRejectedError)
  })

  it('rejects an object that changed between the size check and the read', async () => {
    const bytes = new TextEncoder().encode('longer than announced')
    await expect(
      processUpload(input('a.txt', 5), memory({ 'uploads/1': bytes }, { reportedSize: 5 })),
    ).rejects.toMatchObject({ code: 'E_UPLOAD_SIZE_MISMATCH' })
  })
})
