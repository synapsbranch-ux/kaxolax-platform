import { defineConfig, devices } from '@playwright/test'

/**
 * Parcours de la « Définition de terminé ». Il suppose la pile lancée (voir README) : en local,
 * `pnpm dev` et un agent de compilation ; E2E_BASE_URL vise une autre instance déjà déployée.
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
      use: { ...devices['Desktop Chrome'], viewport: { width: 1600, height: 1000 } },
    },
  ],
})
