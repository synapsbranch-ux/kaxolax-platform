# @kaxolax/config

Configuration partagée par tous les paquets du monorepo.

- `@kaxolax/config/tsconfig/base.json` : TypeScript strict, ESM (`nodenext`).
- `@kaxolax/config/tsconfig/node.json` : services Node (ajoute les types `node`).
- `@kaxolax/config/tsconfig/library.json` : bibliothèques partagées, avec fichiers de déclaration.
- `@kaxolax/config/eslint` : `createConfig({ tsconfigRootDir })`, règles `strictTypeChecked`.
- `@kaxolax/config/prettier` : style commun.
