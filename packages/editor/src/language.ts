import { HighlightStyle, StreamLanguage, syntaxHighlighting } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'
import { tags } from '@lezer/highlight'

/** Langage LaTeX (mode stex de CodeMirror), avec commentaires `%` et paires à fermer. */
export const latexLanguage = StreamLanguage.define(stex)

export const latexLanguageData = latexLanguage.data.of({
  commentTokens: { line: '%' },
  closeBrackets: { brackets: ['(', '[', '{', '$'] },
})

/** Couleurs de la coloration syntaxique (commandes, arguments, maths, commentaires). */
export const latexHighlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: '#7c3aed' },
  { tag: tags.tagName, color: '#0369a1' },
  { tag: tags.atom, color: '#0f766e' },
  { tag: tags.number, color: '#b45309' },
  { tag: tags.comment, color: '#6b7280', fontStyle: 'italic' },
  { tag: tags.string, color: '#15803d' },
  { tag: tags.bracket, color: '#9333ea' },
  { tag: tags.variableName, color: '#1d4ed8' },
  { tag: tags.invalid, color: '#dc2626' },
])

export const latexHighlighting = syntaxHighlighting(latexHighlightStyle)
