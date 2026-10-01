process.env.NODE_ENV = 'test'

// Instance Clerk simulée : clé publique pour la vérification, clé privée pour signer les jetons de
// test. Générées à chaque lancement, jamais écrites sur disque.
import { generateClerkKeys, TEST_WEBHOOK_SECRET } from '../tests/clerk_keys.js'
const clerkKeys = generateClerkKeys()
process.env.CLERK_JWT_KEY = clerkKeys.publicKey
process.env.KAXOLAX_TEST_CLERK_PRIVATE_KEY = clerkKeys.privateKey
process.env.CLERK_WEBHOOK_SIGNING_SECRET = TEST_WEBHOOK_SECRET

import 'reflect-metadata'
import { Ignitor, prettyPrintError } from '@adonisjs/core/ignitor'
import { configure, processCLIArgs, run } from '@japa/runner'

const APP_ROOT = new URL('../', import.meta.url)
const IMPORTER = (filePath: string) => {
  if (filePath.startsWith('./') || filePath.startsWith('../')) {
    return import(new URL(filePath, APP_ROOT).href)
  }
  return import(filePath)
}

new Ignitor(APP_ROOT, { importer: IMPORTER })
  .tap((app) => {
    app.booting(async () => {
      await import('#start/env')
    })
    app.listen('SIGTERM', () => app.terminate())
    app.listenIf(app.managedByPm2, 'SIGINT', () => app.terminate())
  })
  .testRunner()
  .configure(async (app) => {
    const { runnerHooks, ...config } = await import('../tests/bootstrap.js')
    processCLIArgs(process.argv.splice(2))
    configure({
      ...app.rcFile.tests,
      ...config,
      ...{
        setup: runnerHooks.setup,
        teardown: runnerHooks.teardown.concat([() => app.terminate()]),
      },
    })
  })
  .run(() => run())
  .catch((error: unknown) => {
    process.exitCode = 1
    void prettyPrintError(error)
  })
