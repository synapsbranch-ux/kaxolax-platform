import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { defineConfig, stores } from '@adonisjs/session'

export default defineConfig({
  enabled: true,
  cookieName: 'kaxolax-session',
  clearWithBrowser: false,
  age: '14d',
  cookie: {
    path: '/',
    httpOnly: true,
    secure: app.inProduction,
    sameSite: 'lax',
  },
  /** Redis en développement et en staging ; « memory » (intégré) pour les tests. */
  store: env.get('SESSION_DRIVER'),
  stores: {
    redis: stores.redis({ connection: 'main' }),
  },
})
