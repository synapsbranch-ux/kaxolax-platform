import { type ThemeOptions, themeScript } from '../lib/theme.js'

/**
 * Pose le thème sur <html> avant le premier rendu (voir `themeScript`). À rendre dans <head>
 * du layout racine (composant serveur), avec `suppressHydrationWarning` sur <html>.
 */
export function ThemeScript({ nonce, ...options }: ThemeOptions & { nonce?: string }) {
  return <script nonce={nonce} dangerouslySetInnerHTML={{ __html: themeScript(options) }} />
}
