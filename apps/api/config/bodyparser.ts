import { defineConfig } from '@adonisjs/core/bodyparser'

export default defineConfig({
  allowedMethods: ['POST', 'PUT', 'PATCH', 'DELETE'],
  form: { convertEmptyStringsToNull: true, types: ['application/x-www-form-urlencoded'] },
  json: { convertEmptyStringsToNull: false, types: ['application/json'], limit: '5mb' },
  // Les fichiers passent par des URL présignées vers S3, jamais par l'API.
  multipart: {
    autoProcess: false,
    convertEmptyStringsToNull: true,
    processManually: [],
    limit: '1mb',
  },
})
