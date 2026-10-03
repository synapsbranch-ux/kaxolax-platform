import type { ClerkMiddlewareOptions } from '@clerk/nextjs/server'

/**
 * En-têtes de sécurité de l'admin.
 *
 * - CSP stricte, posée sur chaque page par le proxy (`src/proxy.ts`) avec l'option
 *   `contentSecurityPolicy` de `clerkMiddleware` : nonce par requête et `'strict-dynamic'`
 *   (scripts de Next.js, de Clerk et ce qu'ils chargent), origines dont Clerk a besoin (Frontend
 *   API de l'instance tirée de la clé publique, `img.clerk.com`, Cloudflare Turnstile, workers
 *   `blob:`) ; `'unsafe-eval'` seulement en développement (rechargement à chaud de Next.js).
 *   L'admin ne charge rien d'autre : tout passe par l'API sur la même origine (/api).
 * - En-têtes fixes sur toutes les réponses (`next.config.ts`) : jamais indexée, jamais dans un
 *   cadre, aucun référent.
 */

type CspOptions = NonNullable<ClerkMiddlewareOptions['contentSecurityPolicy']>
type CspDirectives = NonNullable<CspOptions['directives']>

/** Directives propres à l'admin, ajoutées à celles de Clerk. */
export const ADMIN_CSP_DIRECTIVES: CspDirectives = {
  'default-src': ["'self'"],
  'connect-src': ["'self'"],
  'img-src': ["'self'", 'data:'],
  'font-src': ["'self'", 'data:'],
  // Styles injectés par Clerk, attributs `style` de React.
  'style-src': ["'self'", "'unsafe-inline'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'self'"],
  'frame-ancestors': ["'none'"],
}

/** Option `contentSecurityPolicy` de `clerkMiddleware` pour l'admin. */
export function adminContentSecurityPolicy(): CspOptions {
  return { strict: true, directives: ADMIN_CSP_DIRECTIVES }
}

/** En-têtes fixes de toutes les réponses (`headers()` de next.config.ts). */
export const ADMIN_SECURITY_HEADERS: readonly { key: string; value: string }[] = [
  { key: 'X-Robots-Tag', value: 'noindex, nofollow' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'Referrer-Policy', value: 'no-referrer' },
  {
    key: 'Permissions-Policy',
    value: 'camera=(), microphone=(), geolocation=(), usb=(), serial=(), hid=(), payment=()',
  },
]
