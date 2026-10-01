import { defineConfig } from '@adonisjs/shield'

export default defineConfig({
  csp: { enabled: false, directives: {}, reportOnly: false },
  /**
   * Pas de CSRF : l'API n'a ni session ni cookie d'authentification. Le jeton Clerk voyage dans
   * l'en-tête Authorization, qu'un autre site ne peut pas faire envoyer (pas de CORS).
   */
  csrf: { enabled: false },
  xFrame: { enabled: true, action: 'DENY' },
  hsts: { enabled: true, maxAge: '180 days' },
  contentTypeSniffing: { enabled: true },
})
