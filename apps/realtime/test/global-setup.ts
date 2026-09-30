import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'
import pg from 'pg'

/**
 * Base dédiée aux tests du service temps réel, recréée à chaque lancement avec les migrations de
 * l'API (seule source du schéma). Elle est distincte de kaxolax_test : les deux suites tournent en
 * parallèle sous Turborepo.
 */
export const TEST_DATABASE = 'kaxolax_realtime_test'

const apiDirectory = fileURLToPath(new URL('../../api/', import.meta.url))

export default async function setup(): Promise<void> {
  const apiEnv = parseEnv(readFileSync(`${apiDirectory}.env.example`, 'utf8'))
  const admin = new pg.Client({
    host: apiEnv.DB_HOST,
    port: Number(apiEnv.DB_PORT),
    user: apiEnv.DB_USER,
    password: apiEnv.DB_PASSWORD,
    database: 'postgres',
  })
  await admin.connect()
  try {
    await admin.query(`DROP DATABASE IF EXISTS ${TEST_DATABASE} WITH (FORCE)`)
    await admin.query(`CREATE DATABASE ${TEST_DATABASE} OWNER ${apiEnv.DB_USER ?? 'kaxolax'}`)
  } finally {
    await admin.end()
  }
  execFileSync('node', ['ace', 'migration:run', '--force'], {
    cwd: apiDirectory,
    env: {
      ...process.env,
      ...apiEnv,
      NODE_ENV: 'development',
      DB_DATABASE: TEST_DATABASE,
      LOG_LEVEL: 'silent',
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  })
}
