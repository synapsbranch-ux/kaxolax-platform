import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { decodeMessage } from './mail'

const LINK = /https?:\/\/\S+\/verify-email\?token=[\w-]+/
const TOKEN_URL =
  'https://d111111abcdef8.cloudfront.net/verify-email?token=example-token-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

describe('decodeMessage', () => {
  it('rejoins the link that quoted-printable splits across lines', () => {
    // Message produit par nodemailer (comme l'API), tel que SES le dépose dans S3 (CRLF).
    const raw = readFileSync(join(import.meta.dirname, 'fixtures', 'verify-email.eml'), 'utf8')
    expect(LINK.exec(raw)?.[0]).not.toBe(TOKEN_URL)
    expect(LINK.exec(decodeMessage(raw.replace(/\r?\n/g, '\r\n')))?.[0]).toBe(TOKEN_URL)
  })

  it('decodes base64 parts', () => {
    const body = Buffer.from(`Ouvrez ce lien : ${TOKEN_URL}\n`).toString('base64')
    const raw = [
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: base64',
      '',
      body.slice(0, 40),
      body.slice(40),
      '--boundary--',
    ].join('\r\n')
    expect(LINK.exec(decodeMessage(raw))?.[0]).toBe(TOKEN_URL)
  })
})
