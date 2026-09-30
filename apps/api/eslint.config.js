import { createConfig } from '@kaxolax/config/eslint'

export default [
  { ignores: ['build/**', '.adonisjs/**', 'tmp/**'] },
  ...createConfig({ tsconfigRootDir: import.meta.dirname }),
  {
    rules: {
      // Conventions AdonisJS : contrôleurs et modèles sont des classes.
      '@typescript-eslint/no-extraneous-class': 'off',
    },
  },
  {
    // Cycle de vie de l'application (app.booting, app.listen) : callbacks asynchrones attendus.
    files: ['bin/**/*.ts'],
    rules: { '@typescript-eslint/no-misused-promises': 'off' },
  },
  {
    // Augmentation des types des paquets AdonisJS (interface X extends InferY<...> {}).
    files: ['config/**/*.ts'],
    rules: { '@typescript-eslint/no-empty-object-type': 'off' },
  },
  {
    // L'API des migrations Lucid impose des méthodes async, même sans await.
    files: ['database/migrations/**/*.ts'],
    rules: { '@typescript-eslint/require-await': 'off' },
  },
  {
    // Les corps de réponse HTTP des tests ne sont pas typés.
    files: ['tests/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
    },
  },
]
