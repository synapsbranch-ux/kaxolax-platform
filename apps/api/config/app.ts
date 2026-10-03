import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/core/http'

/** Origine publique de l'application, utilisée dans les liens des emails. */
export const appUrl = env.get('APP_URL')

export const http = defineConfig({
  generateRequestId: true,
  allowMethodSpoofing: false,
  useAsyncLocalStorage: false,
  /**
   * Derrière Next.js (local) ou Cloudflare puis le proxy de Railway (production), on ne fait
   * confiance qu'aux `TRUSTED_PROXY_HOPS` derniers intermédiaires pour l'IP, le protocole et l'hôte
   * d'origine (en-têtes X-Forwarded-*). En production, ces valeurs restent forgeables : Railway
   * n'authentifie pas Cloudflare, et une connexion directe à son edge (en contournant Cloudflare)
   * fait passer un X-Forwarded-For choisi pour l'IP du client. Aucune règle ne doit s'y fier tant
   * que l'origine n'est pas authentifiée (voir deploy/railway/README.md, note ‡).
   */
  trustProxy: (_address: string, distance: number) => distance < env.get('TRUSTED_PROXY_HOPS', 1),
  router: { matcher: 'tree' },
  redirect: { forwardQueryString: true },
  cookie: {
    domain: '',
    path: '/',
    maxAge: '2h',
    httpOnly: true,
    secure: app.inProduction,
    sameSite: 'lax',
  },
})
