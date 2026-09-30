// @ts-check
import js from '@eslint/js'
import prettier from 'eslint-config-prettier/flat'
import { defineConfig, globalIgnores } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

/**
 * Configuration ESLint commune, avec règles typées.
 *
 * @param {{ tsconfigRootDir: string, browser?: boolean }} options
 */
export function createConfig({ tsconfigRootDir, browser = false }) {
  return defineConfig(
    globalIgnores(['**/dist/**', '**/build/**', '**/.next/**', '**/coverage/**', '**/.turbo/**']),
    js.configs.recommended,
    tseslint.configs.strictTypeChecked,
    tseslint.configs.stylisticTypeChecked,
    {
      languageOptions: {
        globals: browser ? { ...globals.browser } : { ...globals.node },
        parserOptions: {
          projectService: true,
          tsconfigRootDir,
        },
      },
      rules: {
        '@typescript-eslint/consistent-type-imports': [
          'error',
          { fixStyle: 'inline-type-imports' },
        ],
        '@typescript-eslint/restrict-template-expressions': ['error', { allowNumber: true }],
        '@typescript-eslint/no-unused-vars': [
          'error',
          { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
        ],
        eqeqeq: ['error', 'always'],
        'no-console': 'off',
      },
    },
    {
      files: ['**/*.js', '**/*.mjs', '**/*.cjs'],
      extends: [tseslint.configs.disableTypeChecked],
      languageOptions: { globals: { ...globals.node } },
    },
    prettier,
  )
}
