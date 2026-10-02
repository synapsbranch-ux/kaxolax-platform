import { StreamLanguage } from '@codemirror/language'
import { stex } from '@codemirror/legacy-modes/mode/stex'

/** Langage LaTeX (mode stex de CodeMirror), avec commentaires `%` et paires à fermer. */
export const latexLanguage = StreamLanguage.define(stex)

export const latexLanguageData = latexLanguage.data.of({
  commentTokens: { line: '%' },
  closeBrackets: { brackets: ['(', '[', '{', '$'] },
})
