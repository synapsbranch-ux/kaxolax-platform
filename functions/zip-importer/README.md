# @kaxolax/zip-importer

`importZip()` lit le zip d'un projet et renvoie son plan d'import : dossiers, documents texte,
binaires (confiés à `storeBinary`), document principal et compilateur probable.

- Tout est vérifié avant le premier envoi vers S3 : chemins (absolus, `..`, antislash, liens
  symboliques), noms, doublons, 5 000 fichiers au plus, 500 Mio décompressés au plus (taille
  annoncée, puis taille réelle de chaque entrée).
- Document principal : `main.tex` à la racine, sinon le premier `.tex` avec un `\documentclass`.
- Refus : `ZipImportError` avec un code (`E_ZIP_UNSAFE_PATH`, `E_ZIP_TOO_LARGE`…).

À l'étape 1, l'API l'appelle directement. `handler` (export `./handler`) est le handler Lambda
fin des étapes suivantes.

```bash
pnpm --filter @kaxolax/zip-importer test
```
