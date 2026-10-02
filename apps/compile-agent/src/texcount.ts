import {
  type WordCountResult,
  type WordCounts,
  type WordCountSection,
  type WordCountSectionKind,
} from '@kaxolax/contracts'

/** Avertissements de texcount gardés au plus (un document cassé peut en produire des milliers). */
const MAX_WARNINGS = 50

/**
 * Garde Perl autour de texcount. texcount (Perl) ne lit pas texmf.cnf : `openin_any = p` ne
 * s'applique pas, et il ouvre les fichiers inclus (`\input`, `\include`, `\import`, `\subfile`,
 * `%TC:fileinclude`…) avec un `open` à deux arguments, qui suivrait un chemin absolu ou `..`,
 * voire lancerait une commande (`\input{/usr/bin/id |}`). Le script de texcount installé est
 * donc chargé avec sa fonction de lecture (`read_binary`, seule à lire les sources) précédée
 * d'un contrôle : nom sans caractère spécial du shell ni de contrôle, chemin réel (liens et `..`
 * résolus) sous `root`, le répertoire temporaire du comptage. Un fichier refusé devient un
 * avertissement « not readable ». Si la version installée n'a plus cette fonction, la garde
 * échoue (aucun comptage sans protection).
 */
export const TEXCOUNT_GUARD = String.raw`use strict;
use warnings;
use Cwd qw(abs_path);
my $root = abs_path(shift @ARGV);
die "kaxolax: invalid root\n" unless defined $root && -d $root;
my ($bin) = grep { -x "$_/texcount" } split /:/, ($ENV{PATH} // '');
die "kaxolax: texcount not found\n" unless defined $bin;
my $script = abs_path("$bin/texcount");
open(my $fh, '<:raw', $script) or die "kaxolax: cannot read texcount\n";
my $source = do { local $/; <$fh> };
close $fh;
my ($code, $data) = split /^__DATA__\n/m, $source, 2;
$code =~ s/(sub read_binary \{\s*my \$filename=shift \@_;)/$1 return undef unless main::kaxolax_inside(\$filename);/
  or die "kaxolax: unsupported texcount version\n";
sub kaxolax_inside {
  my ($name) = @_;
  return 0 if !defined $name || $name =~ /[|<>&;\x60\x00-\x1f]/ || $name =~ /^\s|\s$/;
  my $path = abs_path($name);
  return defined $path && ($path eq $root || index($path, "$root/") == 0);
}
{
  no warnings 'once';
  open(main::DATA, '<', \($data // '')) or die "kaxolax: no texcount data\n";
}
$0 = $script;
eval "#line 1 \"$script\"\n$code";
die $@ if $@;
`

/**
 * Commande texcount, sous la garde `TEXCOUNT_GUARD` (`root` : répertoire du comptage tel que le
 * sandbox le voit) : `-merge` insère les fichiers inclus à leur place, pour que le détail par
 * section les compte dans la bonne section ; `-sub=section` détaille par partie, chapitre et
 * section ; `-utf8` lit les sources en UTF-8 ; `-nocol` retire les couleurs ANSI. Le document
 * est passé en `./nom` : un nom commençant par `-` ne devient jamais une option. texcount
 * n'exécute pas le code TeX du document.
 */
export function texcountCommand(mainFile: string, root: string): string[] {
  return [
    'perl',
    '-e',
    TEXCOUNT_GUARD,
    '--',
    root,
    '-merge',
    '-sub=section',
    '-utf8',
    '-nocol',
    `./${mainFile}`,
  ]
}

export class TexcountOutputError extends Error {}

const TOTAL_LINES: [RegExp, keyof WordCounts][] = [
  [/^Words in text: (\d+)$/, 'text'],
  [/^Words in headers: (\d+)$/, 'headers'],
  [/^Words outside text \(captions, etc\.\): (\d+)$/, 'captions'],
  [/^Number of headers: (\d+)$/, 'headerCount'],
  [/^Number of floats\/tables\/figures: (\d+)$/, 'floatCount'],
  [/^Number of math inlines: (\d+)$/, 'inlineMathCount'],
  [/^Number of math displayed: (\d+)$/, 'displayMathCount'],
]

/** Ligne de détail : `11+2+6 (1/1/1/1) Section: Introduction`. */
const SUBCOUNT = /^\s*(\d+)\+(\d+)\+(\d+) \((\d+)\/(\d+)\/(\d+)\/(\d+)\) (.*)$/
const WARNING = /^!!! (.*?) !!!$/

const SECTION_KINDS: Record<string, WordCountSectionKind> = {
  part: 'part',
  chapter: 'chapter',
  section: 'section',
  subsection: 'subsection',
  subsubsection: 'subsubsection',
  paragraph: 'paragraph',
  subparagraph: 'paragraph',
}

function counts(text: number, headers: number, captions: number): WordCounts {
  return {
    words: text + headers + captions,
    text,
    headers,
    captions,
    headerCount: 0,
    floatCount: 0,
    inlineMathCount: 0,
    displayMathCount: 0,
  }
}

function section(label: string, values: number[]): WordCountSection | null {
  const [
    text = 0,
    headers = 0,
    captions = 0,
    headerCount = 0,
    floats = 0,
    inline = 0,
    display = 0,
  ] = values
  const base = {
    ...counts(text, headers, captions),
    headerCount,
    floatCount: floats,
    inlineMathCount: inline,
    displayMathCount: display,
  }
  if (label === '_top_') return { ...base, kind: 'top', title: '' }
  const separator = label.indexOf(': ')
  const name = separator === -1 ? '' : label.slice(0, separator)
  // Sans -merge, texcount détaille aussi par fichier : jamais demandé ici, ignoré.
  if (name === 'File' || name === 'Included file') return null
  const kind = SECTION_KINDS[name.toLowerCase()]
  return kind === undefined
    ? { ...base, kind: 'other', title: label.trim() }
    : { ...base, kind, title: label.slice(separator + 2).trim() }
}

/**
 * Analyse la sortie de texcount (stdout et stderr confondus) : totaux, détail par section,
 * avertissements (`!!! … !!!`). Les autres lignes (avertissements de Perl, en-têtes) sont
 * ignorées. Sans totaux (document introuvable, sortie tronquée) : `TexcountOutputError`.
 */
export function parseTexcountOutput(output: string): WordCountResult {
  const totals = new Map<keyof WordCounts, number>()
  const sections: WordCountSection[] = []
  const warnings: string[] = []
  let inSubcounts = false

  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd()
    const warning = WARNING.exec(line.trim())
    if (warning) {
      const message = warning[1] ?? ''
      if (warnings.length < MAX_WARNINGS && !warnings.includes(message)) warnings.push(message)
      continue
    }
    if (line === 'Subcounts:') {
      inSubcounts = true
      continue
    }
    if (inSubcounts) {
      const match = SUBCOUNT.exec(line)
      if (match) {
        const entry = section(match[8] ?? '', match.slice(1, 8).map(Number))
        if (entry) sections.push(entry)
        continue
      }
      // En-tête des colonnes, puis fin du bloc à la première ligne d'un autre format.
      if (line.trim().startsWith('text+headers+captions')) continue
      inSubcounts = false
    }
    for (const [pattern, key] of TOTAL_LINES) {
      const match = pattern.exec(line)
      // Le dernier bloc l'emporte : « File(s) total » suit les blocs par fichier sans -merge.
      if (match) totals.set(key, Number(match[1]))
    }
  }

  if (!totals.has('text') || !totals.has('headers') || !totals.has('captions')) {
    throw new TexcountOutputError(warnings[0] ?? 'texcount produced no word count')
  }
  const total = counts(
    totals.get('text') ?? 0,
    totals.get('headers') ?? 0,
    totals.get('captions') ?? 0,
  )
  total.headerCount = totals.get('headerCount') ?? 0
  total.floatCount = totals.get('floatCount') ?? 0
  total.inlineMathCount = totals.get('inlineMathCount') ?? 0
  total.displayMathCount = totals.get('displayMathCount') ?? 0
  return { total, sections, warnings }
}
