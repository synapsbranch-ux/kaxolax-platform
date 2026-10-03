import type { Suggestion } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import {
  adjacentSuggestion,
  applyDecisions,
  bulkDecision,
  decisionNotice,
  editModeChoice,
  editModeStorageKey,
  effectiveEditMode,
  filterSuggestions,
  mergeReloaded,
  orderSuggestions,
  readEditMode,
  suggestionAuthors,
  suggestionDocuments,
  suggestionNotice,
  upsertSuggestion,
  writeEditMode,
} from './suggestions'

const ADA = {
  id: '00000000-0000-4000-8000-00000000000a',
  fullName: 'Ada Lovelace',
  avatarUrl: null,
}
const GRACE = {
  id: '00000000-0000-4000-8000-00000000000b',
  fullName: 'Grace Hopper',
  avatarUrl: null,
}
const MAIN = '00000000-0000-4000-8000-0000000000d1'
const INTRO = '00000000-0000-4000-8000-0000000000d2'
const PROJECT = '00000000-0000-4000-8000-0000000000f0'

let serial = 0
function suggestion(overrides: Partial<Suggestion> = {}): Suggestion {
  serial += 1
  return {
    id: `00000000-0000-4000-8000-${String(serial).padStart(12, '0')}`,
    documentId: MAIN,
    author: GRACE,
    origin: 'user',
    kind: 'insert',
    anchor: 'AQ==',
    originalText: '',
    proposedText: 'x',
    status: 'open',
    decidedBy: null,
    decidedAt: null,
    aiMessageId: null,
    createdAt: `2026-10-03T10:00:${String(serial % 60).padStart(2, '0')}.000Z`,
    ...overrides,
  }
}

const tree = {
  documents: [
    { id: MAIN, folderId: null, name: 'main.tex', path: 'main.tex' },
    { id: INTRO, folderId: null, name: 'intro.tex', path: 'sections/intro.tex' },
  ],
}

/** Stockage local en mémoire. */
function memoryStorage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() {
      return values.size
    },
    clear: () => {
      values.clear()
    },
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => {
      values.delete(key)
    },
    setItem: (key, value) => {
      values.set(key, value)
    },
  }
}

describe('edit mode', () => {
  it('follows the role: editors choose, reviewers suggest, readers neither', () => {
    expect(editModeChoice('owner')).toBe('choose')
    expect(editModeChoice('editor')).toBe('choose')
    expect(editModeChoice('reviewer')).toBe('suggest-only')
    expect(editModeChoice('viewer')).toBe('none')
    expect(editModeChoice(null)).toBe('none')
    expect(effectiveEditMode('editor', null)).toBe('edit')
    expect(effectiveEditMode('editor', 'suggest')).toBe('suggest')
    expect(effectiveEditMode('reviewer', 'edit')).toBe('suggest')
    expect(effectiveEditMode('viewer', 'suggest')).toBeNull()
  })

  it('is remembered per user and per project', () => {
    const storage = memoryStorage()
    writeEditMode(storage, ADA.id, PROJECT, 'suggest')
    expect(readEditMode(storage, ADA.id, PROJECT)).toBe('suggest')
    expect(readEditMode(storage, GRACE.id, PROJECT)).toBeNull()
    expect(readEditMode(storage, ADA.id, MAIN)).toBeNull()
    storage.setItem(editModeStorageKey(ADA.id, MAIN), 'nonsense')
    expect(readEditMode(storage, ADA.id, MAIN)).toBeNull()
    // Stockage indisponible (navigation privée stricte) : aucun mode mémorisé, pas d'erreur.
    const broken = {
      getItem: () => {
        throw new Error('denied')
      },
      setItem: () => {
        throw new Error('denied')
      },
    }
    expect(readEditMode(broken, ADA.id, PROJECT)).toBeNull()
    expect(() => {
      writeEditMode(broken, ADA.id, PROJECT, 'edit')
    }).not.toThrow()
  })
})

describe('suggestion list', () => {
  it('keeps open and stale suggestions only', () => {
    const first = suggestion()
    let list = upsertSuggestion([], first.id, first)
    expect(list).toHaveLength(1)
    list = upsertSuggestion(list, first.id, { ...first, proposedText: 'y' })
    expect(list[0]?.proposedText).toBe('y')
    list = upsertSuggestion(list, first.id, { ...first, status: 'stale' })
    expect(list[0]?.status).toBe('stale')
    expect(upsertSuggestion(list, first.id, { ...first, status: 'accepted' })).toEqual([])
    expect(upsertSuggestion(list, first.id, null)).toEqual([])
  })

  it('applies a decision event', () => {
    const [a, b, c] = [suggestion(), suggestion(), suggestion()]
    const next = applyDecisions([a, b, c], {
      decisions: [
        { suggestionId: a.id, documentId: MAIN, status: 'accepted' },
        { suggestionId: b.id, documentId: MAIN, status: 'stale' },
      ],
    })
    expect(next.map((entry) => [entry.id, entry.status])).toEqual([
      [b.id, 'stale'],
      [c.id, 'open'],
    ])
  })

  it('filters by author and document and lists the choices', () => {
    const list = [
      suggestion({ author: ADA }),
      suggestion({ author: GRACE, documentId: INTRO }),
      suggestion({ author: GRACE, status: 'stale' }),
    ]
    expect(filterSuggestions(list, { authorId: GRACE.id, documentId: null })).toHaveLength(2)
    expect(filterSuggestions(list, { authorId: GRACE.id, documentId: INTRO })).toHaveLength(1)
    expect(suggestionAuthors(list).map((author) => [author.name, author.open])).toEqual([
      ['Ada Lovelace', 1],
      ['Grace Hopper', 1],
    ])
    expect(suggestionDocuments(list, tree).map((document) => document.path)).toEqual([
      'main.tex',
      'sections/intro.tex',
    ])
  })

  it('orders the active document by position, then the others by path', () => {
    const late = suggestion()
    const early = suggestion()
    const unknown = suggestion()
    const other = suggestion({ documentId: INTRO })
    const ordered = orderSuggestions([other, unknown, late, early], {
      tree,
      activeDocumentId: MAIN,
      positions: new Map([
        [late.id, { status: 'open', from: 40, to: 40 }],
        [early.id, { status: 'stale', reason: 'changed', at: 3 }],
        [unknown.id, { status: 'unknown' }],
      ]),
    })
    expect(ordered.map((entry) => entry.id)).toEqual([early.id, late.id, unknown.id, other.id])
    expect(adjacentSuggestion(ordered, null, 1)).toBe(early.id)
    expect(adjacentSuggestion(ordered, early.id, -1)).toBe(other.id)
    expect(adjacentSuggestion([], null, 1)).toBeNull()
  })
})

describe('full reload', () => {
  it('lists a suggestion once, stale, when it changed between the two reads', () => {
    const moved = suggestion()
    const other = suggestion()
    const merged = mergeReloaded([], [moved, other, { ...moved, status: 'stale' }], new Set())
    expect(merged.map((entry) => [entry.id, entry.status])).toEqual([
      [moved.id, 'stale'],
      [other.id, 'open'],
    ])
  })

  it('keeps the current state of a suggestion changed during the read', () => {
    const decided = suggestion()
    const created = suggestion()
    const edited = suggestion({ proposedText: 'old' })
    const untouched = suggestion()
    // Lue ouverte, puis acceptée (événement) pendant la lecture : elle ne revient pas.
    // Créée pendant la lecture : absente de la lecture, gardée. Modifiée : la version courante.
    const current = [created, { ...edited, proposedText: 'new' }, untouched]
    const loaded = [decided, edited, { ...untouched, proposedText: 'fresh' }]
    const merged = mergeReloaded(current, loaded, new Set([decided.id, created.id, edited.id]))
    expect(merged.map((entry) => [entry.id, entry.proposedText])).toEqual([
      [untouched.id, 'fresh'],
      [created.id, 'x'],
      [edited.id, 'new'],
    ])
  })

  it('drops what the reload no longer lists', () => {
    const gone = suggestion()
    expect(mergeReloaded([gone], [], new Set())).toEqual([])
  })
})

describe('decisions', () => {
  it('targets everything shown, or one author, within the chosen document', () => {
    expect(bulkDecision('accept', { authorId: null, documentId: null })).toEqual({
      decision: 'accept',
      all: true,
    })
    expect(bulkDecision('reject', { authorId: GRACE.id, documentId: MAIN })).toEqual({
      decision: 'reject',
      authorId: GRACE.id,
      documentId: MAIN,
    })
  })

  it('sums up the outcomes', () => {
    const id = () => suggestion().id
    expect(
      decisionNotice({
        results: [
          { id: id(), outcome: 'accepted' },
          { id: id(), outcome: 'accepted' },
          { id: id(), outcome: 'stale' },
          { id: id(), outcome: 'unchanged' },
        ],
      }),
    ).toBe('Suggestions : 2 acceptées, 1 obsolète (texte d’origine modifié), 1 déjà traitée.')
    expect(decisionNotice({ results: [{ id: id(), outcome: 'rejected' }] })).toBe(
      'Suggestions : 1 refusée.',
    )
    expect(decisionNotice({ results: [] })).toBeNull()
  })

  it('explains a stale or unlocated suggestion', () => {
    expect(suggestionNotice({ status: 'stale' }, undefined)).toContain('Obsolète')
    expect(
      suggestionNotice({ status: 'open' }, { status: 'stale', reason: 'detached', at: 0 }),
    ).toContain('Obsolète')
    expect(suggestionNotice({ status: 'open' }, { status: 'unknown' })).toContain('introuvable')
    expect(suggestionNotice({ status: 'open' }, { status: 'open', from: 0, to: 1 })).toBeNull()
  })
})
