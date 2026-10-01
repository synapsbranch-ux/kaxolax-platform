import { defineConfig } from '@adonisjs/core/app'
import { indexEntities } from '@adonisjs/core/generators'

export default defineConfig({
  experimental: {},

  commands: [
    () => import('@adonisjs/core/commands'),
    () => import('@adonisjs/lucid/commands'),
    () => import('@adonisjs/mail/commands'),
  ],

  providers: [
    () => import('@adonisjs/core/providers/app_provider'),
    { file: () => import('@adonisjs/core/providers/repl_provider'), environment: ['repl', 'test'] },
    () => import('@adonisjs/core/providers/vinejs_provider'),
    () => import('@adonisjs/shield/shield_provider'),
    () => import('@adonisjs/lucid/database_provider'),
    () => import('@adonisjs/auth/auth_provider'),
    () => import('@adonisjs/mail/mail_provider'),
  ],

  preloads: [() => import('#start/routes'), () => import('#start/kernel')],

  tests: {
    suites: [
      { files: ['tests/unit/**/*.spec.ts'], name: 'unit', timeout: 5000 },
      { files: ['tests/functional/**/*.spec.ts'], name: 'functional', timeout: 30000 },
    ],
    forceExit: false,
  },

  metaFiles: [],

  hooks: {
    init: [indexEntities()],
  },
})
