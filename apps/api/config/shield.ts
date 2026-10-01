import { defineConfig } from '@adonisjs/shield'

export default defineConfig({
  csp: { enabled: false, directives: {}, reportOnly: false },
  /**
   * Protection CSRF des sessions de l'étape 1 : le navigateur lit le cookie XSRF-TOKEN et le
   * renvoie dans l'en-tête X-XSRF-TOKEN. Une requête porteuse d'un jeton Clerk (en-tête, jamais
   * envoyé d'office par le navigateur) n'en a pas besoin, ni un webhook (signé).
   */
  csrf: {
    enabled: true,
    exceptRoutes: (ctx) =>
      /^Bearer\s/i.test(ctx.request.header('authorization') ?? '') ||
      ctx.request.url() === '/api/v1/webhooks/clerk',
    enableXsrfCookie: true,
    methods: ['POST', 'PUT', 'PATCH', 'DELETE'],
  },
  xFrame: { enabled: true, action: 'DENY' },
  hsts: { enabled: true, maxAge: '180 days' },
  contentTypeSniffing: { enabled: true },
})
