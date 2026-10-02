import { DEFAULT_PREFERENCES, MAX_OPEN_TABS_PER_PROJECT } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import { columnsLayout, layoutPatch, PANEL_IDS } from './layout'
import {
  applyPatch,
  closeTab,
  combinePatches,
  openTab,
  pruneTabs,
  restoreTabs,
  tabsEntry,
} from './preferences'
import { compileStatusKind, zoomScale } from './pdf'
import { parseThemeCookie, themeCookie } from './theme'

const ids = (count: number) =>
  Array.from(
    { length: count },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
  )

describe('open tabs', () => {
  it('opens to the right of the active tab, activates an open tab without moving it', () => {
    let state = openTab({ ids: [], active: null }, 'a')
    state = openTab(state, 'b')
    state = openTab({ ...state, active: 'a' }, 'c')
    expect(state).toEqual({ ids: ['a', 'c', 'b'], active: 'c' })
    expect(openTab(state, 'b')).toEqual({ ids: ['a', 'c', 'b'], active: 'b' })
  })

  it('keeps at most the allowed number of tabs, dropping the leftmost', () => {
    const [first, ...rest] = ids(MAX_OPEN_TABS_PER_PROJECT + 1)
    const full = { ids: rest, active: rest.at(-1) ?? null }
    const next = openTab(full, first ?? '')
    expect(next.ids).toHaveLength(MAX_OPEN_TABS_PER_PROJECT)
    expect(next.ids).not.toContain(rest[0])
    expect(next.active).toBe(first)
  })

  it('activates the right neighbour (else the left one) when closing the active tab', () => {
    const state = { ids: ['a', 'b', 'c'], active: 'b' }
    expect(closeTab(state, 'b')).toEqual({ ids: ['a', 'c'], active: 'c' })
    expect(closeTab({ ...state, active: 'c' }, 'c')).toEqual({ ids: ['a', 'b'], active: 'b' })
    expect(closeTab(state, 'a')).toEqual({ ids: ['b', 'c'], active: 'b' })
    expect(closeTab({ ids: ['a'], active: 'a' }, 'a')).toEqual({ ids: [], active: null })
  })

  it('restores saved tabs that still exist, otherwise the main document', () => {
    const exists = (id: string) => id !== 'gone'
    expect(
      restoreTabs({ documentIds: ['a', 'gone', 'b'], activeDocumentId: 'gone' }, exists, 'm'),
    ).toEqual({ ids: ['a', 'b'], active: 'a' })
    expect(restoreTabs(undefined, exists, 'm')).toEqual({ ids: ['m'], active: 'm' })
    expect(restoreTabs({ documentIds: ['gone'], activeDocumentId: null }, exists, null)).toEqual({
      ids: [],
      active: null,
    })
    const state = { ids: ['a'], active: 'a' }
    expect(pruneTabs(state, exists)).toBe(state)
    expect(tabsEntry(state)).toEqual({ documentIds: ['a'], activeDocumentId: 'a' })
  })
})

describe('preferences', () => {
  it('applies a patch optimistically and combines pending patches', () => {
    const next = applyPatch(DEFAULT_PREFERENCES, { layout: { sidebarCollapsed: true } })
    expect(next.layout).toEqual({ ...DEFAULT_PREFERENCES.layout, sidebarCollapsed: true })
    expect(combinePatches({ layout: { sidebarSize: 20 } }, { layout: { editorSize: 30 } })).toEqual(
      { layout: { sidebarSize: 20, editorSize: 30 } },
    )
    // Une modification invalide ne casse pas l'état local.
    expect(applyPatch(DEFAULT_PREFERENCES, { layout: { sidebarSize: 500 } })).toBe(
      DEFAULT_PREFERENCES,
    )
  })

  it('reads and writes the theme cookie', () => {
    expect(parseThemeCookie('light')).toBe('light')
    expect(parseThemeCookie('purple')).toBeNull()
    expect(parseThemeCookie(undefined)).toBeNull()
    expect(themeCookie('dark')).toMatch(/^kaxolax-theme=dark; path=\//)
  })
})

describe('columns layout', () => {
  it('splits the remaining width between editor and PDF in their saved proportion', () => {
    expect(columnsLayout(DEFAULT_PREFERENCES.layout)).toEqual({
      [PANEL_IDS.sidebar]: 18,
      [PANEL_IDS.editor]: 41,
      [PANEL_IDS.pdf]: 41,
    })
    expect(
      columnsLayout({ sidebarSize: 20, editorSize: 60, pdfSize: 20, sidebarCollapsed: true }),
    ).toEqual({ [PANEL_IDS.sidebar]: 0, [PANEL_IDS.editor]: 75, [PANEL_IDS.pdf]: 25 })
    // Sidebar bornée.
    expect(
      columnsLayout({ sidebarSize: 80, editorSize: 50, pdfSize: 50, sidebarCollapsed: false })[
        PANEL_IDS.sidebar
      ],
    ).toBe(35)
  })

  it('keeps the expanded sidebar size when the user collapses it', () => {
    expect(
      layoutPatch({ [PANEL_IDS.sidebar]: 0, [PANEL_IDS.editor]: 50, [PANEL_IDS.pdf]: 50 }),
    ).toEqual({ layout: { sidebarCollapsed: true, editorSize: 50, pdfSize: 50 } })
    expect(
      layoutPatch({ [PANEL_IDS.sidebar]: 22.456, [PANEL_IDS.editor]: 40, [PANEL_IDS.pdf]: 37.544 }),
    ).toEqual({
      layout: { sidebarCollapsed: false, sidebarSize: 22.46, editorSize: 40, pdfSize: 37.54 },
    })
  })
})

describe('pdf column', () => {
  it('computes the zoom scale for fit modes and fixed levels', () => {
    const page = { width: 600, height: 800 }
    expect(zoomScale(1.5, page, { width: 100, height: 100 })).toBe(1.5)
    expect(zoomScale('page-width', page, { width: 632, height: 400 })).toBe(1)
    expect(zoomScale('page-fit', page, { width: 632, height: 432 })).toBe(0.5)
  })

  it('derives the status pill from the last result', () => {
    const base = { buildId: 'b', durationMs: 1, pdfUrl: null, logUrl: null, entries: [] }
    expect(compileStatusKind(null, false)).toBe('never')
    expect(compileStatusKind(null, true)).toBe('compiling')
    expect(compileStatusKind({ ...base, status: 'success' }, false)).toBe('success')
    expect(compileStatusKind({ ...base, status: 'timeout' }, false)).toBe('timeout')
    expect(
      compileStatusKind(
        {
          ...base,
          status: 'failure',
          entries: [{ level: 'error', file: null, line: null, message: 'x', raw: '' }],
        },
        false,
      ),
    ).toBe('errors')
    expect(compileStatusKind({ ...base, status: 'error' }, false)).toBe('failed')
  })
})
