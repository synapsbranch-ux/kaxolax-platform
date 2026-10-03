import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  clearScreenshots,
  parseScreenshotName,
  renderScreenshotIndex,
  SCREENS,
  screenshotName,
} from './screens'

describe('screenshot names', () => {
  it('round-trips a screen, a theme and a viewport', () => {
    const name = screenshotName('04-project', 'light', '390x844')
    expect(name).toBe('04-project--light--390x844.png')
    expect(parseScreenshotName(name)).toEqual({
      id: '04-project',
      theme: 'light',
      viewport: '390x844',
    })
  })

  it('ignores files that are not captures of a known screen', () => {
    expect(parseScreenshotName('index.md')).toBeNull()
    expect(parseScreenshotName('99-unknown--dark--1440x900.png')).toBeNull()
    expect(parseScreenshotName('01-dashboard--sepia--1440x900.png')).toBeNull()
  })

  it('gives every screen a unique id', () => {
    expect(new Set(SCREENS.map((screen) => screen.id)).size).toBe(SCREENS.length)
  })
})

describe('renderScreenshotIndex', () => {
  const at = new Date('2026-10-03T08:30:00Z')

  it('lists the variants of each screen in a stable order', () => {
    const index = renderScreenshotIndex(
      [
        '01-dashboard--light--390x844.png',
        '01-dashboard--dark--1440x900.png',
        '01-dashboard--light--1440x900.png',
        'notes.txt',
      ],
      at,
    )
    expect(index).toContain('le 2026-10-03 à 08:30 (UTC)')
    expect(index).toContain(
      [
        '## Tableau de bord',
        '',
        '- [Sombre · 1440×900](01-dashboard--dark--1440x900.png)',
        '- [Clair · 1440×900](01-dashboard--light--1440x900.png)',
        '- [Clair · 390×844](01-dashboard--light--390x844.png)',
        '',
      ].join('\n'),
    )
    expect(index).toContain('3 captures.')
    expect(index.endsWith('\n')).toBe(true)
    expect(index.endsWith('\n\n')).toBe(false)
  })

  it('marks the screens without any capture', () => {
    const index = renderScreenshotIndex([], at)
    expect(index).toContain('## Admin : journal\n\nAucune capture.')
  })
})

describe('clearScreenshots', () => {
  it('removes the captures and the index of a previous run, nothing else', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'kaxolax-screens-'))
    try {
      for (const file of ['01-dashboard--dark--1440x900.png', 'index.md', 'notes.txt']) {
        await writeFile(join(directory, file), '')
      }
      await clearScreenshots(directory)
      expect(await readdir(directory)).toEqual(['notes.txt'])
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('creates the directory when it is missing', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'kaxolax-screens-'))
    try {
      const directory = join(parent, 'screenshots')
      await clearScreenshots(directory)
      expect(await readdir(directory)).toEqual([])
    } finally {
      await rm(parent, { recursive: true, force: true })
    }
  })
})
