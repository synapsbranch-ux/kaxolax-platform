import { type ChatMessage, mentionToken } from '@kaxolax/contracts'
import { describe, expect, it } from 'vitest'
import type { ProjectTree } from './api'
import {
  chatMember,
  dayLabel,
  displaySegments,
  encodeMentions,
  groupMessages,
  insertMention,
  mentionQueryAt,
  mentionSuggestions,
  mergeMessages,
  resolveFileRef,
  unreadBadge,
} from './chat'

const ADA = '00000000-0000-4000-8000-000000000001'
const BOB = '00000000-0000-4000-8000-000000000002'
const BOB2 = '00000000-0000-4000-8000-000000000003'

const tree: ProjectTree = {
  mainDocumentId: null,
  folders: [],
  documents: [
    {
      id: '10000000-0000-4000-8000-000000000001',
      folderId: null,
      name: 'main.tex',
      path: 'main.tex',
    },
    {
      id: '10000000-0000-4000-8000-000000000002',
      folderId: null,
      name: 'intro.tex',
      path: 'chapitres/intro.tex',
    },
    { id: '10000000-0000-4000-8000-000000000003', folderId: null, name: 'a.tex', path: 'x/a.tex' },
    { id: '10000000-0000-4000-8000-000000000004', folderId: null, name: 'a.tex', path: 'y/a.tex' },
  ],
  files: [],
}

function message(id: number, authorId: string, createdAt: string, body = 'texte'): ChatMessage {
  return {
    id: `20000000-0000-4000-8000-${String(id).padStart(12, '0')}`,
    author: { id: authorId, fullName: null, avatarUrl: null },
    body,
    createdAt,
  }
}

describe('file references', () => {
  it('links only to documents of the project', () => {
    expect(resolveFileRef(tree, 'main.tex')?.path).toBe('main.tex')
    expect(resolveFileRef(tree, './chapitres/intro.tex')?.path).toBe('chapitres/intro.tex')
    // Nom seul : seulement s'il est unique.
    expect(resolveFileRef(tree, 'intro.tex')?.path).toBe('chapitres/intro.tex')
    expect(resolveFileRef(tree, 'a.tex')).toBeNull()
    expect(resolveFileRef(tree, 'absent.tex')).toBeNull()
    expect(resolveFileRef(tree, 'autre/intro.tex')).toBeNull()
    expect(resolveFileRef(null, 'main.tex')).toBeNull()
  })

  it('turns existing references into links and mentions into members', () => {
    const ada = chatMember(ADA, 'Ada Lovelace', null)
    const segments = displaySegments(
      `Voir main.tex:42 et absent.tex:3 ${mentionToken(ADA)} ${mentionToken(BOB)} <b>`,
      tree,
      new Map([[ADA, ada]]),
    )
    expect(segments).toEqual([
      { kind: 'text', text: 'Voir ' },
      { kind: 'file-ref', text: 'main.tex:42', document: tree.documents[0], line: 42 },
      { kind: 'text', text: ' et absent.tex:3 ' },
      { kind: 'mention', userId: ADA, member: ada },
      { kind: 'text', text: ' ' },
      { kind: 'mention', userId: BOB, member: null },
      { kind: 'text', text: ' <b>' },
    ])
  })
})

describe('mention input', () => {
  const members = [
    chatMember(ADA, 'Ada Lovelace', null),
    chatMember(BOB, 'Bob Élie', null),
    chatMember(BOB2, 'Bob Élie', null),
  ]

  it('detects the mention being typed', () => {
    expect(mentionQueryAt('Salut @el', 9)).toEqual({ start: 6, query: 'el' })
    expect(mentionQueryAt('@', 1)).toEqual({ start: 0, query: '' })
    expect(mentionQueryAt('(@ad', 4)).toEqual({ start: 1, query: 'ad' })
    expect(mentionQueryAt('ada@exemple.org', 15)).toBeNull()
    expect(mentionQueryAt('@ada lovelace', 13)).toBeNull()
    expect(mentionQueryAt('sans arobase', 5)).toBeNull()
  })

  it('suggests members by the start of any word, accents ignored, self excluded', () => {
    expect(mentionSuggestions(members, 'eli', ADA).map((member) => member.id)).toEqual([BOB, BOB2])
    expect(mentionSuggestions(members, 'love', null).map((member) => member.id)).toEqual([ADA])
    expect(mentionSuggestions(members, 'ove', null)).toEqual([])
    expect(mentionSuggestions(members, '', BOB).map((member) => member.id)).toEqual([ADA, BOB2])
  })

  it('inserts the chosen name and encodes mentions on send', () => {
    const typed = 'Merci @lo !'
    const query = mentionQueryAt(typed, 9)
    expect(query).not.toBeNull()
    if (query === null) return
    const inserted = insertMention(typed, query, 9, 'Ada Lovelace')
    expect(inserted).toEqual({ text: 'Merci @Ada Lovelace  !', caret: 20 })
    expect(encodeMentions(inserted.text, [{ id: ADA, name: 'Ada Lovelace' }], members)).toBe(
      `Merci ${mentionToken(ADA)}  !`,
    )
    // Homonymes : seuls les choix explicites, dans l'ordre ; un nom tapé à la main ambigu reste du texte.
    expect(
      encodeMentions('@Bob Élie et @Bob Élie', [{ id: BOB2, name: 'Bob Élie' }], members),
    ).toBe(`${mentionToken(BOB2)} et @Bob Élie`)
    // Nom unique tapé à la main ; pas de coupure au milieu d'un mot.
    expect(encodeMentions('@Ada Lovelace, @Ada Lovelacex', [], members)).toBe(
      `${mentionToken(ADA)}, @Ada Lovelacex`,
    )
  })
})

describe('grouping and unread', () => {
  it('groups by local day, then by author within five minutes', () => {
    const days = groupMessages([
      message(1, ADA, '2026-10-01T09:00:00'),
      message(2, ADA, '2026-10-01T09:04:00'),
      message(3, ADA, '2026-10-01T09:10:00'),
      message(4, BOB, '2026-10-01T09:11:00'),
      message(5, BOB, '2026-10-02T09:12:00'),
    ])
    expect(days.map((day) => day.key)).toEqual(['2026-10-01', '2026-10-02'])
    expect(days[0]?.groups.map((group) => group.messages.length)).toEqual([2, 1, 1])
    expect(days[1]?.groups.map((group) => group.authorId)).toEqual([BOB])
  })

  it('labels days', () => {
    const now = new Date(2026, 9, 2, 12)
    expect(dayLabel('2026-10-02', now)).toBe("Aujourd'hui")
    expect(dayLabel('2026-10-01', now)).toBe('Hier')
    expect(dayLabel('2026-09-28', now)).toMatch(/28 septembre/)
    expect(dayLabel('2025-09-28', now)).toMatch(/2025/)
  })

  it('merges pages without duplicates, in order', () => {
    const a = message(1, ADA, '2026-10-01T09:00:00.000Z')
    const b = message(2, ADA, '2026-10-01T09:01:00.000Z')
    const c = message(3, BOB, '2026-10-01T09:02:00.000Z')
    expect(mergeMessages([b, c], [a, c]).map((m) => m.id)).toEqual([a.id, b.id, c.id])
  })

  it('formats the unread badge', () => {
    expect(unreadBadge(0)).toBeNull()
    expect(unreadBadge(7)).toBe('7')
    expect(unreadBadge(150)).toBe('99+')
  })
})
