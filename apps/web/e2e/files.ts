import { crc32, deflateRawSync, deflateSync, inflateRawSync } from 'node:zlib'

/** Fichier d'un projet de test : chemin relatif (dossiers séparés par `/`) et contenu. */
export interface ProjectFile {
  path: string
  data: string | Buffer
}

function bytesOf(data: string | Buffer): Buffer {
  return typeof data === 'string' ? Buffer.from(data, 'utf8') : data
}

/**
 * Archive zip minimale (méthode « stocké », ou « deflate » avec `compress`, sans extension) : de
 * quoi semer un projet par l'import zip du tableau de bord sans dépendance. Noms en UTF-8.
 */
export function buildZip(files: readonly ProjectFile[], { compress = false } = {}): Buffer {
  const method = compress ? 8 : 0
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const name = Buffer.from(file.path, 'utf8')
    const raw = bytesOf(file.data)
    const checksum = crc32(raw)
    const data = compress ? deflateRawSync(raw) : raw

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4) // version nécessaire : 2.0
    local.writeUInt16LE(0x0800, 6) // noms en UTF-8
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10) // heure DOS
    local.writeUInt16LE(0x21, 12) // date DOS : 1980-01-01
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    locals.push(local, name, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4) // créé par : 2.0
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(name.length, 28)
    // Champ extra, commentaire, disque, attributs internes et externes : vides.
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + data.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

/**
 * Contenu d'une archive zip (méthodes « stocké » et « deflate », sans zip64 ni chiffrement), lu
 * par le répertoire central : tailles fiables même avec des descripteurs de données. Le CRC de
 * chaque fichier est vérifié.
 */
export function readZip(zip: Buffer): Map<string, Buffer> {
  let end = zip.length - 22
  while (end >= 0 && zip.readUInt32LE(end) !== 0x06054b50) end -= 1
  if (end < 0) throw new Error('not a zip archive')
  const count = zip.readUInt16LE(end + 10)
  let cursor = zip.readUInt32LE(end + 16)
  const files = new Map<string, Buffer>()
  for (let index = 0; index < count; index += 1) {
    if (zip.readUInt32LE(cursor) !== 0x02014b50) throw new Error('corrupt zip directory')
    const method = zip.readUInt16LE(cursor + 10)
    const checksum = zip.readUInt32LE(cursor + 16)
    const compressedSize = zip.readUInt32LE(cursor + 20)
    const nameLength = zip.readUInt16LE(cursor + 28)
    const extraLength = zip.readUInt16LE(cursor + 30)
    const commentLength = zip.readUInt16LE(cursor + 32)
    const localOffset = zip.readUInt32LE(cursor + 42)
    const name = zip.toString('utf8', cursor + 46, cursor + 46 + nameLength)
    cursor += 46 + nameLength + extraLength + commentLength
    const start =
      localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28)
    const stored = zip.subarray(start, start + compressedSize)
    if (method !== 0 && method !== 8) throw new Error(`unsupported zip method ${String(method)}`)
    const data = method === 8 ? inflateRawSync(stored) : Buffer.from(stored)
    if (crc32(data) !== checksum) throw new Error(`bad CRC for ${name}`)
    if (!name.endsWith('/')) files.set(name, data)
  }
  return files
}

function pngChunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, checksum])
}

/**
 * Image PNG unie (RVB 8 bits) : une seconde image distincte de la fixture, pour vérifier qu'une
 * restauration rend exactement les octets d'origine.
 */
export function solidPng(width: number, height: number, rgb: [number, number, number]): Buffer {
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header.writeUInt8(8, 8) // profondeur
  header.writeUInt8(2, 9) // couleur : RVB
  const row = Buffer.alloc(1 + width * 3) // octet de filtre (0), puis les pixels
  for (let x = 0; x < width; x += 1) row.set(rgb, 1 + x * 3)
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(pixels)),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}
