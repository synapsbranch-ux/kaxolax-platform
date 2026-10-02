/**
 * Dictionnaires Hunspell du correcteur orthographique (`/dictionaries/fr.aff`, `fr.dic`, `en.aff`,
 * `en.dic`), servis par l'application elle-même (jamais par un CDN) et chargés par le worker du
 * correcteur à la première vérification d'une langue. Générés au build (route statique) depuis
 * les paquets `dictionary-fr` (MPL-2.0) et `dictionary-en` (MIT et BSD).
 */
export const dynamic = 'force-static'
export const dynamicParams = false

type DictionaryFile = 'fr.aff' | 'fr.dic' | 'en.aff' | 'en.dic'

const FILES: readonly DictionaryFile[] = ['fr.aff', 'fr.dic', 'en.aff', 'en.dic']

function isDictionaryFile(value: string): value is DictionaryFile {
  return (FILES as readonly string[]).includes(value)
}

export function generateStaticParams(): { file: DictionaryFile }[] {
  return FILES.map((file) => ({ file }))
}

async function load(file: DictionaryFile): Promise<Uint8Array> {
  const dictionary = file.startsWith('fr.')
    ? (await import('dictionary-fr')).default
    : (await import('dictionary-en')).default
  return file.endsWith('.aff') ? dictionary.aff : dictionary.dic
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ file: string }> },
): Promise<Response> {
  const { file } = await params
  if (!isDictionaryFile(file)) return new Response('Not found', { status: 404 })
  const body = await load(file)
  // Copie dans un ArrayBuffer propre (le Buffer de Node peut partager un tampon plus grand).
  const bytes = new Uint8Array(body.byteLength)
  bytes.set(body)
  return new Response(bytes, {
    headers: {
      // Texte (UTF-8 pour le français) : compressible par le serveur et le proxy.
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=86400, stale-while-revalidate=604800',
    },
  })
}
