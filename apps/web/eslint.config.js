import { createConfig } from '@kaxolax/config/eslint'

export default [
  ...createConfig({ tsconfigRootDir: import.meta.dirname, browser: true, next: true }),
  { ignores: ['next-env.d.ts', 'playwright-report/**', 'test-results/**'] },
]
