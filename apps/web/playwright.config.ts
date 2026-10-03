import { defineConfig, devices } from '@playwright/test'

/**
 * Parcours e2e de la « Définition de terminé » (projet `chromium`) et captures d'écran (projet
 * `screenshots`). Ils supposent la pile lancée (voir README) : en local, `pnpm dev` et un agent de
 * compilation ; E2E_BASE_URL vise une autre instance déjà déployée. Les comptes de test sont ceux
 * de l'instance Clerk de développement (adresses +clerk_test), créés et supprimés par les parcours.
 */
export default defineConfig({
  testDir: 'e2e',
  // Les *.test.ts d'e2e/ sont des tests unitaires (Vitest) des utilitaires du parcours.
  testMatch: '**/*.spec.ts',
  // Jeton de test Clerk (instance de développement), partagé par tous les parcours.
  globalSetup: './e2e/global-setup.ts',
  timeout: 240_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    acceptDownloads: true,
    launchOptions: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE
      ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE }
      : {},
  },
  projects: [
    {
      name: 'chromium',
      testIgnore: '**/screenshots.spec.ts',
      use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } },
    },
    {
      // `pnpm --filter @kaxolax/web screenshots` : PNG et index dans e2e/screenshots/.
      name: 'screenshots',
      testMatch: '**/screenshots.spec.ts',
      timeout: 600_000,
      use: { ...devices['Desktop Chrome'], locale: 'fr-FR', timezoneId: 'Europe/Paris' },
    },
  ],
})
