import type { ClerkMiddlewareOptions } from '@clerk/nextjs/server'

/**
 * En-têtes de sécurité de l'application web.
 *
 * - CSP stricte, posée sur chaque page par le proxy (`src/proxy.ts`) avec l'option
 *   `contentSecurityPolicy` de `clerkMiddleware` : nonce par requête et `'strict-dynamic'`
 *   (scripts de Next.js, de Clerk et ce qu'ils chargent), origines dont Clerk a besoin (Frontend
 *   API de l'instance tirée de la clé publique, `img.clerk.com`, Cloudflare Turnstile, Stripe pour
 *   Billing, workers `blob:`) ; `'unsafe-eval'` seulement en développement (rechargement à chaud
 *   de Next.js). Les directives ci-dessous s'y ajoutent.
 * - En-têtes fixes sur toutes les réponses (`next.config.ts`), statiques comprises.
 */

type CspOptions = NonNullable<ClerkMiddlewareOptions['contentSecurityPolicy']>
type CspDirectives = NonNullable<CspOptions['directives']>

/** Origines du navigateur à autoriser, tirées de la configuration du serveur Next.js. */
export interface WebCspSources {
  /** URL publique du service temps réel (`ws://` ou `wss://`), comme `REALTIME_PUBLIC_URL` de l'API. */
  realtimeUrl?: string | undefined
  /** Point d'accès public du stockage S3/R2 (URL présignées), comme `S3_PUBLIC_ENDPOINT` de l'API. */
  storageUrl?: string | undefined
  /** Fichiers publics des templates (miniatures, PDF), `TEMPLATES_PUBLIC_URL` ou dossier du catalogue. */
  templateUrls?: readonly (string | undefined)[]
}

/** Origine (`schéma://hôte:port`) d'une URL ; null si elle est absente ou invalide. */
export function originOf(url: string | undefined): string | null {
  if (url === undefined || url === '') return null
  try {
    const parsed = new URL(url)
    return parsed.origin === 'null' ? null : parsed.origin
  } catch {
    return null
  }
}

/**
 * Stockage : son origine, et pour un point d'accès https ses sous-domaines (URL présignées en
 * style « virtual-hosted », `bucket.hôte`).
 */
function storageSources(url: string | undefined): string[] {
  const origin = originOf(url)
  if (origin === null) return []
  const parsed = new URL(origin)
  return parsed.protocol === 'https:' ? [origin, `https://*.${parsed.host}`] : [origin]
}

const unique = (values: readonly (string | null)[]): string[] => [
  ...new Set(values.filter((value): value is string => value !== null)),
]

/** Directives propres à l'application, ajoutées à celles de Clerk. */
export function webCspDirectives(sources: WebCspSources): CspDirectives {
  const storage = storageSources(sources.storageUrl)
  const templates = unique((sources.templateUrls ?? []).map(originOf))
  return {
    'default-src': ["'self'"],
    // WebAssembly seulement (jamais d'eval JavaScript) : correcteur Hunspell et décodeurs de
    // pdf.js tournent dans des workers, que certains navigateurs soumettent à la politique de
    // la page.
    'script-src': ["'wasm-unsafe-eval'"],
    // API (même origine, /api), temps réel, PDF et journaux de compilation, envois de fichiers
    // (URL présignées), aperçu PDF des templates.
    'connect-src': unique(["'self'", originOf(sources.realtimeUrl), ...storage, ...templates]),
    // Aperçus des images du projet (URL présignées), miniatures des templates, avatars Clerk.
    'img-src': unique(["'self'", 'data:', 'blob:', ...storage, ...templates]),
    // Polices servies par l'application (@fontsource, MathLive) ; pdf.js peut charger les polices
    // d'un PDF en `data:`.
    'font-src': ["'self'", 'data:'],
    // Styles injectés par Clerk, CodeMirror et MathLive, attributs `style` de React.
    'style-src': ["'self'", "'unsafe-inline'"],
    // Workers : correcteur, pdf.js (fichiers de /_next/static), Clerk (`blob:`).
    'worker-src': ["'self'", 'blob:'],
    // Impression du PDF (cadre caché sur une copie locale `blob:`).
    'frame-src': ["'self'", 'blob:'],
    'media-src': ["'self'"],
    'manifest-src': ["'self'"],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    // Jamais affichée dans un cadre d'un autre site (comme X-Frame-Options: DENY).
    'frame-ancestors': ["'none'"],
  }
}

/** Option `contentSecurityPolicy` de `clerkMiddleware` pour l'application web. */
export function webContentSecurityPolicy(sources: WebCspSources): CspOptions {
  return { strict: true, directives: webCspDirectives(sources) }
}

/** Fonctions du navigateur refusées à la page ; paiement réservé à Stripe (Clerk Billing). */
export const WEB_PERMISSIONS_POLICY = [
  'camera=()',
  'microphone=()',
  'geolocation=()',
  'usb=()',
  'serial=()',
  'hid=()',
  'payment=(self "https://js.stripe.com")',
].join(', ')

/** En-têtes fixes de toutes les réponses (`headers()` de next.config.ts). */
export const WEB_SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Permissions-Policy', value: WEB_PERMISSIONS_POLICY },
]
