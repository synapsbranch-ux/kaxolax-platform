# @kaxolax/latex-log-parser

Parse les logs d'une compilation LaTeX et renvoie des entrées `LogEntry` (voir
`@kaxolax/contracts`) : erreurs, warnings et bad boxes, avec fichier et ligne.

```ts
import { parseCompileLogs } from '@kaxolax/latex-log-parser'

const entries = parseCompileLogs(
  { log: await readFile('output.log'), blg: await readFile('output.blg').catch(() => null) },
  { rootDir: '/compile', jobname: 'output' },
)
```

- **Lignes coupées** : TeX coupe le log à 79 unités (`max_print_line`). pdfTeX compte en octets et
  peut couper au milieu d'un caractère UTF-8, XeTeX et LuaTeX comptent en caractères. Passez le
  log en `Uint8Array` pour que le recollage se fasse avant le décodage.
- **Fichiers** : suivi de la pile `(./fichier.tex ... )` ; chemins relatifs au projet
  (`chapters/intro.tex`), absolus pour TeX Live, nuls pour les fichiers générés (`output.aux`…).
- **Formats** : `-file-line-error` (`./main.tex:12: ...`) et format classique (`! ...` + `l.12`),
  erreurs Lua (`[\directlua]:1: ...`), messages LaTeX3 sur plusieurs lignes (`(fontspec) ...`),
  warnings LaTeX, de paquet, de classe et de police, `Missing character`, bad boxes.
- **Bibliographie** : `.blg` de BibTeX (`Warning--`, `---line N of file`) et de Biber
  (`WARN`, `ERROR`, erreurs du sous-système BibTeX rattachées au `.bib` source).

## Tests

Les fixtures de `test/fixtures` sont de vrais logs TeX Live 2026, produits dans le sandbox à partir
des sources de `test/fixtures-src` :

```bash
pnpm --filter @kaxolax/latex-log-parser test
pnpm --filter @kaxolax/latex-log-parser fixtures   # régénère avec kaxolax-texlive:2026-medium
```
