import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  // Alias `@/` de tsconfig : les composants testés l'importent.
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
  test: { include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'e2e/**/*.test.ts'] },
})
