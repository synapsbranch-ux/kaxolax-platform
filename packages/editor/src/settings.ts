import { Prec, type Extension } from '@codemirror/state'
import { emacs } from '@replit/codemirror-emacs'
import { vim } from '@replit/codemirror-vim'
import type { SpellcheckConfig } from './spellcheck/extension.js'
import {
  type EditorAppearance,
  syntaxThemeId,
  type SyntaxThemeId,
  type ThemeMode,
} from './theme.js'

/** Raccourcis clavier de l'éditeur (`editor.keymap` des préférences). */
export type EditorKeymapMode = 'default' | 'vim' | 'emacs'

export const EDITOR_KEYMAPS: readonly { id: EditorKeymapMode; label: string }[] = [
  { id: 'default', label: 'Par défaut' },
  { id: 'vim', label: 'Vim' },
  { id: 'emacs', label: 'Emacs' },
]

/**
 * Raccourcis Vim ou Emacs, en priorité la plus haute (avant ceux de CodeMirror et du registre
 * d'actions) ; aucun pour `default`.
 */
export function editorKeymap(mode: EditorKeymapMode): Extension {
  if (mode === 'vim') return Prec.highest(vim())
  if (mode === 'emacs') return Prec.highest(emacs())
  return []
}

const MONOSPACE = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'

/** Polices proposées (`editor.fontFamily` : identifiant, ou pile CSS saisie par l'utilisateur). */
export const EDITOR_FONTS: readonly { id: string; label: string; stack: string }[] = [
  { id: 'monospace', label: 'Police système', stack: MONOSPACE },
  { id: 'jetbrains-mono', label: 'JetBrains Mono', stack: `'JetBrains Mono', ${MONOSPACE}` },
  { id: 'fira-code', label: 'Fira Code', stack: `'Fira Code', ${MONOSPACE}` },
  { id: 'source-code-pro', label: 'Source Code Pro', stack: `'Source Code Pro', ${MONOSPACE}` },
  { id: 'ibm-plex-mono', label: 'IBM Plex Mono', stack: `'IBM Plex Mono', ${MONOSPACE}` },
  { id: 'courier', label: 'Courier', stack: `'Courier New', Courier, monospace` },
]

/**
 * Pile CSS d'une police : préréglage par identifiant, ou nom saisi (lettres, chiffres, espaces,
 * virgules, tirets et guillemets seulement : rien qui sorte de la déclaration CSS) suivi de la
 * police à chasse fixe du système.
 */
export function fontStack(fontFamily: string | undefined): string {
  const preset = EDITOR_FONTS.find((font) => font.id === fontFamily)
  if (preset) return preset.stack
  const custom = fontFamily?.trim() ?? ''
  if (custom === '' || !/^[\p{L}\p{N} ,'"-]{1,100}$/u.test(custom)) return MONOSPACE
  return `${custom}, ${MONOSPACE}`
}

/** Préférences `editor` de l'utilisateur (forme de `ResolvedPreferences['editor']`). */
export interface EditorPreferencesInput {
  fontFamily?: string
  fontSize?: number
  lineHeight?: number
  keymap?: EditorKeymapMode
  wrap?: boolean
  spellcheck?: boolean
  syntaxTheme?: string
}

/** Réglages applicables d'un coup par `reconfigureEditor`. */
export interface EditorSettings {
  theme: ThemeMode
  appearance: Required<EditorAppearance>
  syntaxTheme: SyntaxThemeId
  keymap: EditorKeymapMode
  lineWrapping: boolean
  /** Correcteur : configuration si activé et disponible, null sinon. */
  spellcheck: SpellcheckConfig | null
}

/**
 * Traduit les préférences de l'utilisateur en réglages de l'éditeur (valeurs hors bornes
 * ramenées dans les bornes du schéma). `spellcheck` : configuration du correcteur (client du
 * worker et langue du projet), appliquée seulement si `editor.spellcheck` est vrai.
 */
export function editorSettings(
  preferences: EditorPreferencesInput,
  theme: ThemeMode,
  spellcheck: SpellcheckConfig | null = null,
): EditorSettings {
  const clamp = (value: number | undefined, fallback: number, min: number, max: number) =>
    value === undefined || !Number.isFinite(value) ? fallback : Math.min(max, Math.max(min, value))
  return {
    theme,
    appearance: {
      fontFamily: fontStack(preferences.fontFamily),
      fontSize: clamp(preferences.fontSize, 14, 8, 32),
      lineHeight: clamp(preferences.lineHeight, 1.5, 1, 3),
    },
    syntaxTheme: syntaxThemeId(preferences.syntaxTheme),
    keymap: preferences.keymap ?? 'default',
    lineWrapping: preferences.wrap ?? true,
    spellcheck: preferences.spellcheck === false ? null : spellcheck,
  }
}
