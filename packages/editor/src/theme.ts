import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import { Facet, type Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags } from '@lezer/highlight'

export type ThemeMode = 'dark' | 'light'

/** Police de l'éditeur (paramètres de la tâche 10). */
export interface EditorAppearance {
  /** Taille en pixels. */
  fontSize?: number
  /** Pile de polices CSS. */
  fontFamily?: string
  /** Hauteur de ligne (multiple de la taille). */
  lineHeight?: number
}

/**
 * Couleurs de l'éditeur. Chaque jeton est lu dans une variable CSS de @kaxolax/ui
 * (`EDITOR_VARIABLES`) ; la palette du mode sert de repli quand la variable n'est pas définie.
 */
export const EDITOR_TOKENS = [
  'background',
  'foreground',
  'gutter-background',
  'gutter-foreground',
  'gutter-active-foreground',
  'active-line',
  'active-line-border',
  'selection',
  'selection-inactive',
  'cursor',
  'selection-match',
  'search-match',
  'search-match-selected',
  'bracket-match',
  'panel-background',
  'panel-foreground',
  'panel-border',
  'input-background',
  'accent',
  'fold-placeholder',
  'syntax-command',
  'syntax-math',
  'syntax-argument',
  'syntax-number',
  'syntax-comment',
  'syntax-string',
  'syntax-bracket',
  'syntax-math-variable',
  'syntax-invalid',
] as const

export type EditorToken = (typeof EDITOR_TOKENS)[number]

/** Palettes de repli (sombre : thème par défaut de l'éditeur ; claire : paramètres). */
export const EDITOR_PALETTES: Record<ThemeMode, Record<EditorToken, string>> = {
  dark: {
    background: '#1b1c20',
    foreground: '#d7dae0',
    'gutter-background': '#1b1c20',
    'gutter-foreground': '#5f6470',
    'gutter-active-foreground': '#c3c8d2',
    'active-line': 'rgba(255, 255, 255, 0.035)',
    'active-line-border': 'rgba(255, 255, 255, 0.12)',
    selection: 'rgba(77, 140, 255, 0.35)',
    'selection-inactive': 'rgba(77, 140, 255, 0.18)',
    cursor: '#e8eaf0',
    'selection-match': 'rgba(255, 255, 255, 0.09)',
    'search-match': 'rgba(234, 179, 8, 0.28)',
    'search-match-selected': 'rgba(234, 179, 8, 0.55)',
    'bracket-match': 'rgba(96, 165, 250, 0.3)',
    'panel-background': '#232429',
    'panel-foreground': '#d7dae0',
    'panel-border': '#33353c',
    'input-background': '#1b1c20',
    accent: '#3b82f6',
    'fold-placeholder': '#2c2e35',
    'syntax-command': '#7aa2f7',
    'syntax-math': '#c099ff',
    'syntax-argument': '#4fd6be',
    'syntax-number': '#ff9e64',
    'syntax-comment': '#7a8191',
    'syntax-string': '#9ece6a',
    'syntax-bracket': '#89a4c7',
    'syntax-math-variable': '#e0af68',
    'syntax-invalid': '#f7768e',
  },
  light: {
    background: '#ffffff',
    foreground: '#1f2328',
    'gutter-background': '#ffffff',
    'gutter-foreground': '#8c939d',
    'gutter-active-foreground': '#1f2328',
    'active-line': 'rgba(15, 23, 42, 0.03)',
    'active-line-border': 'rgba(15, 23, 42, 0.12)',
    selection: 'rgba(37, 99, 235, 0.22)',
    'selection-inactive': 'rgba(37, 99, 235, 0.12)',
    cursor: '#111827',
    'selection-match': 'rgba(15, 23, 42, 0.07)',
    'search-match': 'rgba(250, 204, 21, 0.4)',
    'search-match-selected': 'rgba(234, 179, 8, 0.7)',
    'bracket-match': 'rgba(37, 99, 235, 0.18)',
    'panel-background': '#f6f7f9',
    'panel-foreground': '#1f2328',
    'panel-border': '#e2e5e9',
    'input-background': '#ffffff',
    accent: '#2563eb',
    'fold-placeholder': '#eef0f3',
    'syntax-command': '#0369a1',
    'syntax-math': '#7c3aed',
    'syntax-argument': '#0f766e',
    'syntax-number': '#b45309',
    'syntax-comment': '#6b7280',
    'syntax-string': '#15803d',
    'syntax-bracket': '#9333ea',
    'syntax-math-variable': '#1d4ed8',
    'syntax-invalid': '#dc2626',
  },
}

/**
 * Variable CSS de chaque jeton. Les noms suivent `tokens.css` de @kaxolax/ui ; les jetons propres à
 * l'éditeur (recherche, repli, champs des panneaux) s'appellent `--editor-<jeton>`.
 */
export const EDITOR_VARIABLES: Record<EditorToken, string> = {
  background: '--editor',
  foreground: '--editor-foreground',
  'gutter-background': '--editor-gutter',
  'gutter-foreground': '--editor-gutter-foreground',
  'gutter-active-foreground': '--editor-gutter-active-foreground',
  'active-line': '--editor-active-line',
  'active-line-border': '--editor-active-line-border',
  selection: '--editor-selection',
  'selection-inactive': '--editor-selection-inactive',
  cursor: '--editor-cursor',
  'selection-match': '--editor-match',
  'search-match': '--editor-search-match',
  'search-match-selected': '--editor-search-match-selected',
  'bracket-match': '--editor-bracket-match',
  'panel-background': '--editor-toolbar',
  'panel-foreground': '--editor-toolbar-foreground',
  'panel-border': '--editor-border',
  'input-background': '--editor-input',
  accent: '--tools',
  'fold-placeholder': '--editor-fold-placeholder',
  'syntax-command': '--editor-syntax-tag',
  'syntax-math': '--editor-syntax-keyword',
  'syntax-argument': '--editor-syntax-atom',
  'syntax-number': '--editor-syntax-number',
  'syntax-comment': '--editor-syntax-comment',
  'syntax-string': '--editor-syntax-string',
  'syntax-bracket': '--editor-syntax-bracket',
  'syntax-math-variable': '--editor-syntax-variable',
  'syntax-invalid': '--editor-syntax-invalid',
}

/** Valeur CSS d'un jeton : variable de @kaxolax/ui, avec la palette du mode en repli. */
function token(mode: ThemeMode, name: EditorToken): string {
  return `var(${EDITOR_VARIABLES[name]}, ${EDITOR_PALETTES[mode][name]})`
}

/** Jetons de coloration syntaxique (changés par un thème de coloration). */
export type SyntaxToken = Extract<EditorToken, `syntax-${string}`>

/** Thèmes de coloration proposés dans les paramètres (`editor.syntaxTheme` des préférences). */
export const SYNTAX_THEMES = [
  { id: 'default', label: 'Kaxolax' },
  { id: 'classic', label: 'Classique' },
  { id: 'solarized', label: 'Solarized' },
  { id: 'monokai', label: 'Monokai' },
  { id: 'high-contrast', label: 'Contraste élevé' },
] as const

export type SyntaxThemeId = (typeof SYNTAX_THEMES)[number]['id']

/** Couleurs des thèmes de coloration autres que `default` (qui suit les variables de @kaxolax/ui). */
const SYNTAX_PALETTES: Record<
  Exclude<SyntaxThemeId, 'default'>,
  Record<ThemeMode, Record<SyntaxToken, string>>
> = {
  classic: {
    dark: {
      'syntax-command': '#569cd6',
      'syntax-math': '#c586c0',
      'syntax-argument': '#4ec9b0',
      'syntax-number': '#b5cea8',
      'syntax-comment': '#6a9955',
      'syntax-string': '#ce9178',
      'syntax-bracket': '#ffd700',
      'syntax-math-variable': '#9cdcfe',
      'syntax-invalid': '#f44747',
    },
    light: {
      'syntax-command': '#0000ff',
      'syntax-math': '#af00db',
      'syntax-argument': '#267f99',
      'syntax-number': '#098658',
      'syntax-comment': '#008000',
      'syntax-string': '#a31515',
      'syntax-bracket': '#795e26',
      'syntax-math-variable': '#001080',
      'syntax-invalid': '#cd3131',
    },
  },
  solarized: {
    dark: {
      'syntax-command': '#268bd2',
      'syntax-math': '#d33682',
      'syntax-argument': '#2aa198',
      'syntax-number': '#cb4b16',
      'syntax-comment': '#839496',
      'syntax-string': '#859900',
      'syntax-bracket': '#6c71c4',
      'syntax-math-variable': '#b58900',
      'syntax-invalid': '#dc322f',
    },
    light: {
      'syntax-command': '#268bd2',
      'syntax-math': '#d33682',
      'syntax-argument': '#2aa198',
      'syntax-number': '#cb4b16',
      'syntax-comment': '#657b83',
      'syntax-string': '#859900',
      'syntax-bracket': '#6c71c4',
      'syntax-math-variable': '#b58900',
      'syntax-invalid': '#dc322f',
    },
  },
  monokai: {
    dark: {
      'syntax-command': '#f92672',
      'syntax-math': '#ae81ff',
      'syntax-argument': '#a6e22e',
      'syntax-number': '#ae81ff',
      'syntax-comment': '#88846f',
      'syntax-string': '#e6db74',
      'syntax-bracket': '#f8f8f2',
      'syntax-math-variable': '#fd971f',
      'syntax-invalid': '#f44747',
    },
    light: {
      'syntax-command': '#c7254e',
      'syntax-math': '#6f42c1',
      'syntax-argument': '#4d8a0f',
      'syntax-number': '#6f42c1',
      'syntax-comment': '#75715e',
      'syntax-string': '#998a00',
      'syntax-bracket': '#272822',
      'syntax-math-variable': '#c45f00',
      'syntax-invalid': '#d32f2f',
    },
  },
  'high-contrast': {
    dark: {
      'syntax-command': '#7cc4ff',
      'syntax-math': '#ff9cf5',
      'syntax-argument': '#7dffb0',
      'syntax-number': '#ffd27a',
      'syntax-comment': '#c8c8c8',
      'syntax-string': '#b9ff7a',
      'syntax-bracket': '#ffffff',
      'syntax-math-variable': '#ffe14d',
      'syntax-invalid': '#ff6b6b',
    },
    light: {
      'syntax-command': '#00308f',
      'syntax-math': '#6a0080',
      'syntax-argument': '#005a32',
      'syntax-number': '#8a3b00',
      'syntax-comment': '#3d3d3d',
      'syntax-string': '#1e5c00',
      'syntax-bracket': '#000000',
      'syntax-math-variable': '#7a4d00',
      'syntax-invalid': '#b00000',
    },
  },
}

/** Identifiant de thème de coloration reconnu (`default` pour une valeur inconnue). */
export function syntaxThemeId(value: string | undefined): SyntaxThemeId {
  return SYNTAX_THEMES.find((theme) => theme.id === value)?.id ?? 'default'
}

/** Coloration syntaxique LaTeX (jetons du mode stex : commandes, maths, arguments…). */
function highlightStyle(mode: ThemeMode, syntax: SyntaxThemeId = 'default'): HighlightStyle {
  const palette = syntax === 'default' ? null : SYNTAX_PALETTES[syntax][mode]
  const color = (name: SyntaxToken) => palette?.[name] ?? token(mode, name)
  return HighlightStyle.define(
    [
      { tag: tags.tagName, color: color('syntax-command') },
      { tag: tags.keyword, color: color('syntax-math') },
      { tag: tags.atom, color: color('syntax-argument') },
      { tag: tags.number, color: color('syntax-number') },
      { tag: tags.comment, color: color('syntax-comment'), fontStyle: 'italic' },
      { tag: tags.string, color: color('syntax-string') },
      { tag: tags.bracket, color: color('syntax-bracket') },
      { tag: tags.variableName, color: color('syntax-math-variable') },
      { tag: tags.invalid, color: color('syntax-invalid') },
    ],
    { themeType: mode },
  )
}

const HIGHLIGHT_STYLES = new Map<string, HighlightStyle>()

function cachedHighlightStyle(mode: ThemeMode, syntax: SyntaxThemeId): HighlightStyle {
  const key = `${mode}:${syntax}`
  let style = HIGHLIGHT_STYLES.get(key)
  if (!style) {
    style = highlightStyle(mode, syntax)
    HIGHLIGHT_STYLES.set(key, style)
  }
  return style
}

/** Coloration du thème clair (export historique de l'étape 1). */
export const latexHighlightStyle = cachedHighlightStyle('light', 'default')

const DEFAULT_FONT = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** Règles du thème : couleurs lues dans les variables CSS, police en paramètre. */
function themeSpec(mode: ThemeMode, appearance: EditorAppearance) {
  const color = (name: EditorToken) => token(mode, name)
  return {
    '&': {
      height: '100%',
      color: color('foreground'),
      backgroundColor: color('background'),
      fontSize:
        appearance.fontSize === undefined
          ? 'var(--editor-font-size, 14px)'
          : `${String(appearance.fontSize)}px`,
    },
    '.cm-scroller': {
      fontFamily: appearance.fontFamily ?? `var(--editor-font-family, ${DEFAULT_FONT})`,
      lineHeight:
        appearance.lineHeight === undefined
          ? 'var(--editor-line-height, 1.6)'
          : String(appearance.lineHeight),
    },
    '.cm-content': { caretColor: color('cursor') },
    '.cm-cursor, .cm-dropCursor': { borderLeftColor: color('cursor'), borderLeftWidth: '2px' },
    '.cm-selectionBackground': { backgroundColor: color('selection-inactive') },
    '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground': {
      backgroundColor: color('selection'),
    },
    '.cm-content ::selection': { backgroundColor: 'transparent' },
    // Ligne courante encadrée.
    '.cm-activeLine': {
      backgroundColor: color('active-line'),
      boxShadow: `inset 0 1px 0 ${color('active-line-border')}, inset 0 -1px 0 ${color('active-line-border')}`,
    },
    '.cm-gutters': {
      backgroundColor: color('gutter-background'),
      color: color('gutter-foreground'),
      border: 'none',
    },
    '.cm-activeLineGutter': {
      backgroundColor: 'transparent',
      color: color('gutter-active-foreground'),
    },
    '.cm-lineNumbers .cm-gutterElement': { padding: '0 12px 0 16px' },
    '.cm-foldGutter .cm-gutterElement': { padding: '0 4px', cursor: 'pointer' },
    '.cm-foldPlaceholder': {
      backgroundColor: color('fold-placeholder'),
      border: 'none',
      color: color('gutter-active-foreground'),
      padding: '0 6px',
      borderRadius: '4px',
    },
    '.cm-selectionMatch': { backgroundColor: color('selection-match') },
    '.cm-searchMatch': {
      backgroundColor: color('search-match'),
      borderRadius: '2px',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: color('search-match-selected'),
    },
    '&.cm-focused .cm-matchingBracket': {
      backgroundColor: color('bracket-match'),
      outline: 'none',
    },
    '&.cm-focused .cm-nonmatchingBracket': { color: color('syntax-invalid') },
    // Panneaux (recherche, aller à la ligne) et infobulles (autocomplétion de la tâche 10).
    '.cm-panels': {
      backgroundColor: color('panel-background'),
      color: color('panel-foreground'),
    },
    '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${color('panel-border')}` },
    '.cm-panels.cm-panels-bottom': { borderTop: `1px solid ${color('panel-border')}` },
    '.cm-panel.cm-search, .cm-panel.cm-gotoLine': {
      padding: '6px 8px',
      fontFamily: 'inherit',
      fontSize: '13px',
    },
    '.cm-textfield': {
      backgroundColor: color('input-background'),
      color: color('panel-foreground'),
      border: `1px solid ${color('panel-border')}`,
      borderRadius: '6px',
      padding: '3px 6px',
      outline: 'none',
    },
    '.cm-textfield:focus': { borderColor: color('accent') },
    '.cm-button': {
      backgroundImage: 'none',
      backgroundColor: color('input-background'),
      color: color('panel-foreground'),
      border: `1px solid ${color('panel-border')}`,
      borderRadius: '6px',
      padding: '3px 10px',
    },
    '.cm-button:active': { backgroundImage: 'none', borderColor: color('accent') },
    '.cm-panel.cm-search label': { fontSize: '12px' },
    '.cm-panel.cm-search [name=close]': { color: color('gutter-foreground') },
    '.cm-tooltip': {
      backgroundColor: color('panel-background'),
      color: color('panel-foreground'),
      border: `1px solid ${color('panel-border')}`,
      borderRadius: '6px',
    },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': {
      backgroundColor: color('accent'),
      color: '#ffffff',
    },
    '.cm-completionDetail': { opacity: '0.7', marginLeft: '0.75em', fontStyle: 'normal' },
    '.cm-completionInfo': { maxWidth: '24em' },
    // Mots inconnus du correcteur orthographique.
    '.cm-spellError': {
      textDecorationLine: 'underline',
      textDecorationStyle: 'wavy',
      textDecorationColor: color('syntax-invalid'),
      textDecorationSkipInk: 'none',
      textUnderlineOffset: '3px',
    },
  }
}

/** Réglages du thème en place. */
export interface ThemeSettings {
  mode: ThemeMode
  appearance: EditorAppearance
  /** Thème de coloration (absent : `default`). */
  syntax?: SyntaxThemeId
}

/** Mode, police et coloration du thème en place (lus par `reconfigureEditor`). */
export const themeSettings = Facet.define<ThemeSettings, ThemeSettings>({
  combine: (values) => values.at(-1) ?? { mode: 'dark', appearance: {} },
})

/**
 * Thème de l'éditeur : couleurs (variables `--editor-*` de @kaxolax/ui, palettes de repli),
 * coloration syntaxique LaTeX et police (variables `--editor-font-*` par défaut). Pose
 * `data-theme` sur `.cm-editor` pour que les variables de @kaxolax/ui y prennent les valeurs du mode.
 */
export function editorTheme(
  mode: ThemeMode,
  appearance: EditorAppearance = {},
  syntax: SyntaxThemeId = 'default',
): Extension {
  // Même thème pour les mêmes réglages : CodeMirror ne recrée pas de feuille de style.
  const key = JSON.stringify([
    mode,
    appearance.fontSize,
    appearance.fontFamily,
    appearance.lineHeight,
    syntax,
  ])
  const cached = themeCache.get(key)
  if (cached) return cached
  const theme = [
    EditorView.theme(themeSpec(mode, appearance), { dark: mode === 'dark' }),
    syntaxHighlighting(cachedHighlightStyle(mode, syntax)),
    // Les variables de @kaxolax/ui suivent `data-theme` : l'éditeur garde son mode même si le
    // reste de la page est dans l'autre thème.
    EditorView.editorAttributes.of({ 'data-theme': mode }),
    themeSettings.of(syntax === 'default' ? { mode, appearance } : { mode, appearance, syntax }),
  ]
  themeCache.set(key, theme)
  return theme
}

const themeCache = new Map<string, Extension>()
