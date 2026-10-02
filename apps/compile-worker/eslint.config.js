import { createConfig } from '@kaxolax/config/eslint'
import { globalIgnores } from 'eslint/config'

export default [
  ...createConfig({ tsconfigRootDir: import.meta.dirname }),
  // Bundles temporaires de wrangler.
  globalIgnores(['.wrangler/**']),
]
