// @vitest-environment happy-dom
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { latexExtensions } from '../index.js'
import { stateOf } from '../test-utils.js'
import { createDefaultRegistry } from './defaults.js'
import {
  isMarkdownImportPayload,
  looksLikeMarkdown,
  MARKDOWN_IMPORT_DIALOG,
  markdownImportPayload,
} from './markdown.js'
import type { ActionHost } from './registry.js'

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

function editor(doc: string, host: ActionHost = {}, readOnly = false): EditorView {
  const registry = createDefaultRegistry()
  const state = stateOf(
    doc,
    latexExtensions({ readOnly, theme: 'light', actions: { registry, host: () => host } }),
  )
  const view = new EditorView({ state, parent: document.body })
  views.push(view)
  return view
}

describe('looksLikeMarkdown', () => {
  it('recognises obvious Markdown', () => {
    for (const text of [
      '# Titre\n\nDu texte en **gras**.',
      '- un\n- deux\n\nVoir [la doc](https://pandoc.org).',
      '```python\nprint(1)\n```',
      '| A | B |\n|---|:-:|\n| 1 | 2 |',
      '> Une citation\n\n1. premier\n2. second',
      'Un `code` et une ![image](figures/plot.png)',
    ]) {
      expect(looksLikeMarkdown(text), text).toBe(true)
    }
  })

  it('leaves plain text and LaTeX alone', () => {
    for (const text of [
      'Une phrase ordinaire, sans rien de spécial.',
      '# seul',
      '\\section{Titre}\n- un\n- deux\n\\textbf{x} \\emph{y}',
      '\\begin{itemize}\n\\item **a** [b](c)\n\\end{itemize}',
      '- un\n- deux',
      'x',
    ]) {
      expect(looksLikeMarkdown(text), text).toBe(false)
    }
  })
})

describe('markdown import action', () => {
  const registry = createDefaultRegistry()

  it('is in the File menu and needs an editable project and the dialog', () => {
    expect(registry.byMenu('file').map((action) => action.id)).toContain(MARKDOWN_IMPORT_DIALOG)
    const openDialog = vi.fn()
    expect(registry.isEnabled(MARKDOWN_IMPORT_DIALOG, { view: null, host: {} })).toBe(false)
    expect(
      registry.isEnabled(MARKDOWN_IMPORT_DIALOG, {
        view: null,
        host: { openDialog, readOnly: true },
      }),
    ).toBe(false)
    // Relecteur en mode Suggérer : éditeur modifiable, mais pas la permission `edit` du projet.
    expect(
      registry.isEnabled(MARKDOWN_IMPORT_DIALOG, {
        view: null,
        host: { openDialog, readOnly: false, canEditProject: false },
      }),
    ).toBe(false)
    expect(registry.run(MARKDOWN_IMPORT_DIALOG, { view: null, host: { openDialog } })).toBe(true)
    expect(openDialog).toHaveBeenCalledWith(MARKDOWN_IMPORT_DIALOG, { kind: 'markdown-import' })
  })

  it('offers to convert a Markdown selection in place', () => {
    const view = editor('Avant «# Titre\n\n- un\n- deux» après')
    const payload = markdownImportPayload({ view, host: {} })
    expect(isMarkdownImportPayload(payload)).toBe(true)
    expect(payload).toEqual({
      kind: 'markdown-import',
      markdown: '# Titre\n\n- un\n- deux',
      replace: { text: '# Titre\n\n- un\n- deux', from: 6, to: 26 },
    })
    const plain = editor('«du texte»')
    expect(markdownImportPayload({ view: plain, host: {} })).toEqual({ kind: 'markdown-import' })
  })
})

describe('markdownPasteDetector', () => {
  const MARKDOWN = '## Résultats\n\n- **a**\n- b\n'

  it('reports a pasted Markdown text with its range', () => {
    const onMarkdownPaste = vi.fn()
    const view = editor('Début |fin', { onMarkdownPaste })
    view.dispatch(view.state.replaceSelection(MARKDOWN), { userEvent: 'input.paste' })
    expect(onMarkdownPaste).toHaveBeenCalledWith({
      text: MARKDOWN,
      from: 6,
      to: 6 + MARKDOWN.length,
    })
    expect(view.state.doc.toString()).toBe(`Début ${MARKDOWN}fin`)
  })

  it('ignores typing, LaTeX pastes, read-only editors and hosts without the callback', () => {
    const onMarkdownPaste = vi.fn()
    const view = editor('|', { onMarkdownPaste })
    view.dispatch({ changes: { from: 0, insert: MARKDOWN }, userEvent: 'input.type' })
    view.dispatch({
      changes: { from: 0, insert: '\\section{A}\n\\begin{itemize}\\item a\\end{itemize}' },
      userEvent: 'input.paste',
    })
    const readOnly = editor('|', { onMarkdownPaste, readOnly: true })
    readOnly.dispatch({ changes: { from: 0, insert: MARKDOWN }, userEvent: 'input.paste' })
    expect(onMarkdownPaste).not.toHaveBeenCalled()
    const none = editor('|')
    none.dispatch({ changes: { from: 0, insert: MARKDOWN }, userEvent: 'input.paste' })
  })
})
