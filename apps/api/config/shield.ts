import { defineConfig } from '@adonisjs/shield'

export default defineConfig({
  csp: { enabled: false, directives: {}, reportOnly: false },
  /**
   * Protection CSRF : le navigateur lit le cookie XSRF-TOKEN et le renvoie dans l'en-tête
   * X-XSRF-TOKEN pour chaque requête qui modifie l'état.
   */
  csrf: {
    enabled: true,
    exceptRoutes: [],
    enableXsrfCookie: true,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
  },
  xFrame: { enabled: true, action: 'DENY' },
  hsts: { enabled: true, maxAge: '180 days' },
  contentTypeSniffing: { enabled: true },
})
