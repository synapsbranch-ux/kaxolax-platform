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
   * L'API n'est joignable que derrière Next.js (local) ou CloudFront (staging). On ne fait confiance
   * qu'aux N derniers intermédiaires : l'IP du client (limitation de débit) ne peut pas être forgée.
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
