import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3'
import { type APIRequestContext, expect } from '@playwright/test'

/**
 * Boîte de réception des tests. En local : Mailpit. Sur staging : SES reçoit les emails des
 * adresses en @E2E_MAIL_DOMAIN et les dépose, bruts, dans le bucket E2E_MAIL_S3_BUCKET
 * (préfixe inbound/, voir kaxolax-infra). Identifiants AWS : chaîne par défaut du SDK.
 */
const MAILPIT_URL = process.env.E2E_MAILPIT_URL ?? 'http://localhost:8025'
const MAIL_BUCKET = process.env.E2E_MAIL_S3_BUCKET
const MAIL_DOMAIN = process.env.E2E_MAIL_DOMAIN ?? 'example.test'

export function testAddress(prefix: string): string {
  return `${prefix}-${String(Date.now())}@${MAIL_DOMAIN}`
}

/** Parties MIME décodées (quoted-printable ou base64), en-têtes compris : de quoi y chercher un lien. */
export function decodeMessage(raw: string): string {
  const quotedPrintable = raw
    .replace(/=\r?\n/g, '')
    .replace(/=([0-9A-F]{2})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)))
  const base64Parts = [
    ...raw.matchAll(
      /Content-Transfer-Encoding: base64\r?\n(?:\S[^\r\n]*\r?\n)*\r?\n([A-Za-z0-9+/=\r\n]+)/gi,
    ),
  ].map((match) => Buffer.from((match[1] ?? '').replace(/\s/g, ''), 'base64').toString('utf8'))
  return [quotedPrintable, ...base64Parts].join('\n')
}

async function fromMailpit(request: APIRequestContext, address: string): Promise<string> {
  const search = await request.get(`${MAILPIT_URL}/api/v1/search`, {
    params: { query: `to:${address}` },
  })
  const { messages } = (await search.json()) as { messages: { ID: string }[] }
  const id = messages[0]?.ID
  if (id === undefined) return ''
  const message = (await (await request.get(`${MAILPIT_URL}/api/v1/message/${id}`)).json()) as {
    Text: string
  }
  return message.Text
}

async function fromS3(bucket: string, address: string, since: Date): Promise<string> {
  const s3 = new S3Client({})
  const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'inbound/' }))
  const recent = (listing.Contents ?? [])
    .filter((object) => object.Key !== undefined && (object.LastModified ?? since) >= since)
    .sort((a, b) => (b.LastModified?.getTime() ?? 0) - (a.LastModified?.getTime() ?? 0))
  for (const object of recent) {
    const body = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }))
    const raw = (await body.Body?.transformToString('utf8')) ?? ''
    if (raw.toLowerCase().includes(address.toLowerCase())) return decodeMessage(raw)
  }
  return ''
}

/** Attend l'email envoyé à `address` et renvoie le premier lien qui correspond à `pattern`. */
export async function waitForLink(
  request: APIRequestContext,
  address: string,
  pattern: RegExp,
): Promise<URL> {
  // Horloges du poste et de S3 : une minute de marge.
  const since = new Date(Date.now() - 60_000)
  let link: URL | null = null
  await expect(async () => {
    const text =
      MAIL_BUCKET === undefined
        ? await fromMailpit(request, address)
        : await fromS3(MAIL_BUCKET, address, since)
    const found = pattern.exec(text)?.[0]
    expect(found, `email to ${address}`).toBeTruthy()
    link = new URL(found ?? '')
  }).toPass({ timeout: MAIL_BUCKET === undefined ? 20_000 : 90_000 })
  const result = link as URL | null
  if (result === null) throw new Error(`no link in the email sent to ${address}`)
  return result
}
