import { crc32, inflateSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { buildZip, readZip, solidPng } from './files'

/** Lit le répertoire central d'une archive « stockée » : nom, CRC, taille et contenu. */
function centralDirectory(zip: Buffer) {
  const end = zip.length - 22
  expect(zip.readUInt32LE(end)).toBe(0x06054b50)
  const count = zip.readUInt16LE(end + 10)
  let cursor = zip.readUInt32LE(end + 16)
  return Array.from({ length: count }, () => {
    expect(zip.readUInt32LE(cursor)).toBe(0x02014b50)
    const checksum = zip.readUInt32LE(cursor + 16)
    const size = zip.readUInt32LE(cursor + 24)
    const nameLength = zip.readUInt16LE(cursor + 28)
    const localOffset = zip.readUInt32LE(cursor + 42)
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength
    expect(zip.readUInt32LE(localOffset)).toBe(0x04034b50)
    const localName = zip.readUInt16LE(localOffset + 26)
    const start = localOffset + 30 + localName
    return { name, checksum, data: zip.subarray(start, start + size) }
  })
}

describe('buildZip', () => {
  it('stores every file with its name, size and CRC', () => {
    const image = Buffer.from([0, 1, 2, 250, 251, 252])
    const zip = buildZip([
      { path: 'main.tex', data: '\\documentclass{article}\n' },
      { path: 'chapitres/introduction.tex', data: 'Élégant, déjà prêt.\n' },
      { path: 'figures/plot.png', data: image },
    ])
    const entries = centralDirectory(zip)
    expect(entries.map((entry) => entry.name)).toEqual([
      'main.tex',
      'chapitres/introduction.tex',
      'figures/plot.png',
    ])
    expect(entries[1]?.data.toString('utf8')).toBe('Élégant, déjà prêt.\n')
    expect(entries[2]?.data.equals(image)).toBe(true)
    for (const entry of entries) expect(entry.checksum).toBe(crc32(entry.data))
  })

  it('writes an empty archive', () => {
    expect(centralDirectory(buildZip([]))).toEqual([])
  })
})

describe('readZip', () => {
  it('reads stored and deflated archives and checks every CRC', () => {
    const files = [
      { path: 'main.tex', data: '\\documentclass{article}\n'.repeat(20) },
      { path: 'figures/courbe.png', data: solidPng(8, 8, [10, 20, 30]) },
    ]
    for (const compress of [false, true]) {
      const read = readZip(buildZip(files, { compress }))
      expect([...read.keys()]).toEqual(['main.tex', 'figures/courbe.png'])
      expect(read.get('main.tex')?.toString('utf8')).toBe('\\documentclass{article}\n'.repeat(20))
      expect(read.get('figures/courbe.png')?.equals(solidPng(8, 8, [10, 20, 30]))).toBe(true)
    }
  })

  it('refuses a damaged archive', () => {
    const zip = buildZip([{ path: 'a.tex', data: 'abc' }])
    zip[30 + 'a.tex'.length] = 'x'.charCodeAt(0)
    expect(() => readZip(zip)).toThrow('bad CRC for a.tex')
    expect(() => readZip(Buffer.from('not a zip at all, definitely not one'))).toThrow(
      'not a zip archive',
    )
  })
})

describe('solidPng', () => {
  it('encodes a valid PNG of the requested size and colour', () => {
    const png = solidPng(3, 2, [200, 30, 40])
    expect(png.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a')
    expect(png.toString('ascii', 12, 16)).toBe('IHDR')
    expect(png.readUInt32BE(16)).toBe(3)
    expect(png.readUInt32BE(20)).toBe(2)
    const idatLength = png.readUInt32BE(33)
    expect(png.toString('ascii', 37, 41)).toBe('IDAT')
    const pixels = inflateSync(png.subarray(41, 41 + idatLength))
    expect([...pixels.subarray(0, 7)]).toEqual([0, 200, 30, 40, 200, 30, 40])
    expect(png.toString('ascii', png.length - 8, png.length - 4)).toBe('IEND')
  })

  it('gives different bytes for different colours', () => {
    expect(solidPng(4, 4, [0, 0, 0]).equals(solidPng(4, 4, [255, 255, 255]))).toBe(false)
  })
})
