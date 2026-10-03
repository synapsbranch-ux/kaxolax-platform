# @kaxolax/zip-importer

`importZip()` lit le zip d'un projet et renvoie son plan d'import : dossiers, documents texte,
binaires (confiés à `storeBinary`), document principal et compilateur probable.

- Tout est vérifié avant le premier envoi vers S3 : chemins (absolus, `..`, antislash, liens
  symboliques), noms, doublons, 5 000 fichiers au plus, 500 Mio décompressés au plus (taille
  annoncée, puis taille réelle de chaque entrée).
- Document principal : `main.tex` à la racine, sinon le premier `.tex` avec un `\documentclass`.
- Refus : `ZipImportError` avec un code (`E_ZIP_UNSAFE_PATH`, `E_ZIP_TOO_LARGE`…).

L'API l'appelle dans son propre processus, avec son client S3 (R2 en production), en local
comme en production. `handler` (export `./handler`), un handler au format AWS Lambda écrit à
l'étape 1, **n'est pas déployé** : la production tourne sur Railway et Cloudflare, sans
fonctions Lambda, et rien ne l'appelle.

```bash
pnpm --filter @kaxolax/zip-importer test
```
