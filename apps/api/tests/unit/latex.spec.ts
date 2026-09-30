import { test } from '@japa/runner'
import { escapeLatex, starterDocument } from '#services/latex'

test.group('latex helpers', () => {
  test('escapes every LaTeX special character', ({ assert }) => {
    assert.equal(
      escapeLatex('50% & #1 {x} $y$ a_b ~ ^ \\'),
      '50\\% \\& \\#1 \\{x\\} \\$y\\$ a\\_b \\textasciitilde{} \\textasciicircum{} \\textbackslash{}',
    )
    assert.equal(escapeLatex('Thèse — résultats'), 'Thèse — résultats')
  })

  test('builds a minimal main.tex', ({ assert }) => {
    const document = starterDocument('Paper', null)
    assert.include(document, '\\documentclass{article}')
    assert.include(document, '\\author{}')
    assert.include(document, '\\end{document}')
  })
})
