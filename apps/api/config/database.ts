import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { defineConfig } from '@adonisjs/lucid'

export default defineConfig({
  connection: 'pg',
  connections: {
    pg: {
      client: 'pg',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_USER'),
        password: env.get('DB_PASSWORD').release(),
        database: env.get('DB_DATABASE'),
        ssl: env.get('DB_SSL') === true ? { rejectUnauthorized: true } : false,
      },
      migrations: { naturalSort: true, paths: ['database/migrations'] },
      // Modèles écrits à la main (décorateurs) : pas de fichier de schéma généré.
      schemaGeneration: { enabled: false },
      debug: app.inDev && env.get('LOG_LEVEL') === 'debug',
    },
  },
})
