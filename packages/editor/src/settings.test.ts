// @vitest-environment happy-dom
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { getCM } from '@replit/codemirror-vim'
import { afterEach, describe, expect, it } from 'vitest'
import {
  editorSettings,
  fontStack,
  keymapCompartment,
  latexExtensions,
  reconfigureEditor,
  SYNTAX_THEMES,
  syntaxThemeId,
  themeSettings,
} from './index.js'

const views: EditorView[] = []
afterEach(() => {
  for (const view of views.splice(0)) view.destroy()
})

function editor(options: Parameters<typeof latexExtensions>[0] = {}): EditorView {
  const view = new EditorView({
    state: EditorState.create({ doc: 'abc\ndef', extensions: latexExtensions(options) }),
    parent: document.body,
  })
  views.push(view)
  return view
}

describe('editorSettings', () => {
  it('maps the user preferences to editor settings, within the schema bounds', () => {
    expect(
      editorSettings(
        {
          fontFamily: 'fira-code',
          fontSize: 40,
          lineHeight: 0.5,
          keymap: 'vim',
          wrap: false,
          spellcheck: true,
          syntaxTheme: 'monokai',
        },
        'light',
      ),
    ).toEqual({
      theme: 'light',
      appearance: {
        fontFamily: expect.stringMatching(/^'Fira Code', /) as unknown,
        fontSize: 32,
        lineHeight: 1,
      },
      syntaxTheme: 'monokai',
      keymap: 'vim',
      lineWrapping: false,
      spellcheck: null,
    })
    const defaults = editorSettings({}, 'dark')
    expect(defaults).toMatchObject({
      appearance: { fontSize: 14, lineHeight: 1.5 },
      syntaxTheme: 'default',
      keymap: 'default',
      lineWrapping: true,
    })
  })

  it('enables the spellchecker only when the preference allows it', () => {
    const config = { language: 'fr' } as unknown as NonNullable<
      Parameters<typeof editorSettings>[2]
    >
    expect(editorSettings({ spellcheck: true }, 'dark', config).spellcheck).toBe(config)
    expect(editorSettings({}, 'dark', config).spellcheck).toBe(config)
    expect(editorSettings({ spellcheck: false }, 'dark', config).spellcheck).toBeNull()
  })

  it('sanitizes custom fonts and unknown syntax themes', () => {
    expect(fontStack('Iosevka Term')).toMatch(/^Iosevka Term, ui-monospace/)
    expect(fontStack('x; } body { display: none')).toMatch(/^ui-monospace/)
    expect(fontStack(undefined)).toMatch(/^ui-monospace/)
    expect(syntaxThemeId('nope')).toBe('default')
    expect(SYNTAX_THEMES.map((theme) => theme.id)).toContain('solarized')
  })
})

describe('hot reconfiguration', () => {
  it('applies every setting without recreating the editor', () => {
    const view = editor({ theme: 'dark' })
    view.dispatch({ selection: { anchor: 5 } })
    const dom = view.dom
    reconfigureEditor(
      view,
      editorSettings(
        { fontSize: 18, keymap: 'vim', wrap: false, syntaxTheme: 'solarized' },
        'light',
      ),
    )
    expect(view.dom).toBe(dom)
    expect(view.state.doc.toString()).toBe('abc\ndef')
    expect(view.state.selection.main.head).toBe(5)
    expect(view.dom.getAttribute('data-theme')).toBe('light')
    expect(view.state.facet(themeSettings)).toMatchObject({
      mode: 'light',
      appearance: { fontSize: 18 },
      syntax: 'solarized',
    })
    expect(view.contentDOM.classList.contains('cm-lineWrapping')).toBe(false)
    expect(getCM(view)).not.toBeNull()

    reconfigureEditor(view, { keymap: 'emacs' })
    expect(getCM(view)).toBeNull()
    expect(keymapCompartment.get(view.state)).not.toEqual([])
    reconfigureEditor(view, { keymap: 'default', syntaxTheme: 'default' })
    expect(keymapCompartment.get(view.state)).toEqual([])
    expect(view.state.facet(themeSettings).syntax).toBeUndefined()
  })

  it('starts directly with a keymap and a syntax theme', () => {
    const view = editor({ keymap: 'vim', syntaxTheme: 'high-contrast' })
    expect(getCM(view)).not.toBeNull()
    expect(view.state.facet(themeSettings).syntax).toBe('high-contrast')
  })
})
