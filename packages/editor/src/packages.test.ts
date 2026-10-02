import { describe, expect, it } from 'vitest'
import { findPreamble, loadedPackages, planPackage, usepackageCommand } from './packages.js'

/** Applique le plan d'ajout et renvoie le nouveau texte (inchangé sans modification). */
function add(doc: string, name: string, options: string[] = []): string {
  const plan = planPackage(doc, name, options)
  if (plan.status !== 'insert' && plan.status !== 'update') return doc
  const { from, insert } = plan.change
  return doc.slice(0, from) + insert + doc.slice(from)
}

const base = [
  '\\documentclass[11pt]{article}',
  '\\usepackage[utf8]{inputenc}',
  '\\usepackage{amsmath,amssymb}',
  '% \\usepackage{tikz}',
  '\\begin{document}',
  '\\usepackage{late} % après le préambule : ignoré',
  '\\end{document}',
].join('\n')

describe('preamble and packages', () => {
  it('finds the preamble and the loaded packages, ignoring comments', () => {
    expect(findPreamble(base)).toMatchObject({
      classFrom: 0,
      end: base.indexOf('\\begin{document}'),
    })
    expect(loadedPackages(base).map((loaded) => [loaded.names, loaded.options])).toEqual([
      [['inputenc'], ['utf8']],
      [['amsmath', 'amssymb'], []],
    ])
  })

  it('returns no-preamble for an included file', () => {
    expect(planPackage('\\section{A}', 'tikz').status).toBe('no-preamble')
  })

  it('inserts a new package after the last one', () => {
    expect(add(base, 'tikz')).toContain('\\usepackage{amsmath,amssymb}\n\\usepackage{tikz}\n%')
  })

  it('inserts after \\documentclass when no package is loaded yet', () => {
    expect(add('\\documentclass{article}\n\\begin{document}\n\\end{document}', 'graphicx')).toBe(
      '\\documentclass{article}\n\\usepackage{graphicx}\n\\begin{document}\n\\end{document}',
    )
  })

  it('inserts before hyperref, which must stay last', () => {
    const doc =
      '\\documentclass{article}\n\\usepackage{a}\n\\usepackage{hyperref}\n\\begin{document}'
    expect(add(doc, 'xcolor')).toBe(
      '\\documentclass{article}\n\\usepackage{a}\n\\usepackage{xcolor}\n\\usepackage{hyperref}\n\\begin{document}',
    )
  })

  it('does not duplicate a package already loaded, alone or in a list', () => {
    expect(planPackage(base, 'amssymb').status).toBe('present')
    expect(planPackage(base, 'inputenc', ['utf8']).status).toBe('present')
    // Un package seulement commenté n'est pas chargé.
    expect(planPackage(base, 'tikz').status).toBe('insert')
  })

  it('adds missing options to an existing command', () => {
    expect(add(base, 'inputenc', ['latin1'])).toContain('\\usepackage[utf8,latin1]{inputenc}')
    const doc = '\\documentclass{article}\n\\usepackage{geometry}\n\\begin{document}'
    expect(add(doc, 'geometry', ['margin=2cm', 'a4paper'])).toContain(
      '\\usepackage[margin=2cm,a4paper]{geometry}',
    )
  })

  it('reports a conflict for options on a package loaded in a list', () => {
    expect(planPackage(base, 'amsmath', ['fleqn'])).toMatchObject({
      status: 'conflict',
      missingOptions: ['fleqn'],
    })
  })

  it('writes the command with its options and places the name offset', () => {
    expect(usepackageCommand('geometry', ['margin=1in'])).toBe('\\usepackage[margin=1in]{geometry}')
    const plan = planPackage('\\documentclass{article}\n\\begin{document}', '')
    expect(plan.status).toBe('insert')
    if (plan.status === 'insert') {
      expect(plan.change.insert).toBe('\n\\usepackage{}')
      expect(plan.change.insert.slice(plan.nameOffset)).toBe('}')
    }
  })

  it('handles a document without \\begin{document} yet', () => {
    expect(add('\\documentclass{article}\n\\usepackage{a}', 'b')).toBe(
      '\\documentclass{article}\n\\usepackage{a}\n\\usepackage{b}',
    )
  })
})
