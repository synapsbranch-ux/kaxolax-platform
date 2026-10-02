/** Modificateurs, dans l'ordre d'affichage du système. */
type Modifier = 'ctrl' | 'alt' | 'shift' | 'meta'

const MODIFIER_NAMES: Record<string, Modifier | 'mod'> = {
  mod: 'mod',
  ctrl: 'ctrl',
  control: 'ctrl',
  c: 'ctrl',
  alt: 'alt',
  a: 'alt',
  shift: 'shift',
  s: 'shift',
  meta: 'meta',
  cmd: 'meta',
  m: 'meta',
}

const MAC_MODIFIERS: Record<Modifier, string> = { ctrl: '⌃', alt: '⌥', shift: '⇧', meta: '⌘' }
const OTHER_MODIFIERS: Record<Modifier, string> = {
  ctrl: 'Ctrl',
  alt: 'Alt',
  shift: 'Maj',
  meta: 'Méta',
}
const ORDER: Record<'mac' | 'other', Modifier[]> = {
  mac: ['ctrl', 'alt', 'shift', 'meta'],
  other: ['ctrl', 'meta', 'alt', 'shift'],
}

/** Libellés des touches nommées (noms `KeyboardEvent.key`, comme CodeMirror). */
const KEY_LABELS: Record<string, { mac: string; other: string }> = {
  Enter: { mac: '↩', other: 'Entrée' },
  Escape: { mac: 'Échap', other: 'Échap' },
  Backspace: { mac: '⌫', other: 'Retour' },
  Delete: { mac: '⌦', other: 'Suppr' },
  Tab: { mac: '⇥', other: 'Tab' },
  Space: { mac: 'Espace', other: 'Espace' },
  ' ': { mac: 'Espace', other: 'Espace' },
  ArrowUp: { mac: '↑', other: '↑' },
  ArrowDown: { mac: '↓', other: '↓' },
  ArrowLeft: { mac: '←', other: '←' },
  ArrowRight: { mac: '→', other: '→' },
  PageUp: { mac: '⇞', other: 'Pg. préc.' },
  PageDown: { mac: '⇟', other: 'Pg. suiv.' },
  Home: { mac: '↖', other: 'Début' },
  End: { mac: '↘', other: 'Fin' },
}

/**
 * Découpe un raccourci au format CodeMirror (`Mod-Shift-k`, `Ctrl-Enter`, `Alt-ArrowUp`, `F3`)
 * en libellés de touches à afficher. `Mod` vaut ⌘ sur Mac et Ctrl ailleurs.
 * Exemple : `Mod-Shift-k` → Mac `['⇧', '⌘', 'K']`, autres `['Ctrl', 'Maj', 'K']`.
 */
export function formatShortcut(shortcut: string, mac: boolean): string[] {
  // Comme CodeMirror : le dernier segment est la touche, et peut être « - » lui-même.
  const parts = shortcut.split(/-(?!$)/)
  const key = parts.pop() ?? ''
  const modifiers = new Set<Modifier>()
  for (const part of parts) {
    const name = MODIFIER_NAMES[part.toLowerCase()]
    if (name === undefined) continue
    modifiers.add(name === 'mod' ? (mac ? 'meta' : 'ctrl') : name)
  }
  const platform = mac ? 'mac' : 'other'
  const labels = ORDER[platform]
    .filter((modifier) => modifiers.has(modifier))
    .map((modifier) => (mac ? MAC_MODIFIERS : OTHER_MODIFIERS)[modifier])
  const named = KEY_LABELS[key]
  labels.push(named ? named[platform] : key.length === 1 ? key.toUpperCase() : key)
  return labels
}

/** Raccourci en une chaîne : « ⇧⌘K » sur Mac, « Ctrl+Maj+K » ailleurs (attribut title, aria). */
export function formatShortcutText(shortcut: string, mac: boolean): string {
  return formatShortcut(shortcut, mac).join(mac ? '' : '+')
}

/** Plateforme Apple (⌘ au lieu de Ctrl), d'après le navigateur ; `false` côté serveur. */
export function isMacPlatform(): boolean {
  if (typeof navigator === 'undefined') return false
  return /Mac|iPhone|iPad|iPod/.test(navigator.userAgent)
}
