import { describe, expect, it } from 'vitest'
import { isThemePreference, resolveTheme, themeScript } from './theme.js'

describe('theme helpers', () => {
  it('resolves the system preference', () => {
    expect(resolveTheme('system', true)).toBe('dark')
    expect(resolveTheme('system', false)).toBe('light')
    expect(resolveTheme('light', true)).toBe('light')
    expect(isThemePreference('sepia')).toBe(false)
  })

  it('produces a script that cannot close its tag', () => {
    const script = themeScript({ storageKey: '</script><script>alert(1)</script>' })
    expect(script).not.toContain('</script>')
    expect(script).toContain('data-theme')
  })
})
