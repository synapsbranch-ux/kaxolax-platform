const SPECIAL: Record<string, string> = {
  '\\': '\\textbackslash{}',
  '{': '\\{',
  '}': '\\}',
  $: '\\$',
  '&': '\\&',
  '#': '\\#',
  '^': '\\textasciicircum{}',
  _: '\\_',
  '~': '\\textasciitilde{}',
  '%': '\\%',
}

/** Échappe un texte libre (nom de projet, nom d'auteur) pour l'insérer dans un document LaTeX. */
export function escapeLatex(text: string): string {
  return text.replace(/[\\{}$&#^_~%]/g, (character) => SPECIAL[character] ?? character)
}

/** main.tex d'un nouveau projet : minimal, et qui compile avec les trois compilateurs. */
export function starterDocument(title: string, author: string | null): string {
  return [
    '\\documentclass{article}',
    '\\usepackage[T1]{fontenc}',
    '',
    `\\title{${escapeLatex(title)}}`,
    `\\author{${escapeLatex(author ?? '')}}`,
    '\\date{\\today}',
    '',
    '\\begin{document}',
    '\\maketitle',
    '',
    '\\section{Introduction}',
    'Votre texte ici.',
    '',
    '\\end{document}',
    '',
  ].join('\n')
}
