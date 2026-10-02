import { describe, expect, it } from 'vitest'
import {
  broadcastEventSchema,
  fitProjectEvent,
  MAX_PROJECT_EVENT_BYTES,
  MAX_TREE_CHANGES,
  parseProjectEventMessage,
  PROJECT_EVENTS_VERSION,
  projectEventMessage,
  type ProjectEvent,
  publishProjectEventRequestSchema,
} from './events.js'

const id = '0b9f8d3e-5a4c-4b1e-9f2a-3c4d5e6f7a8b'
const other = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'

const memberAdded: ProjectEvent = {
  type: 'member.added',
  userId: other,
  role: 'viewer',
  actorId: other,
}

const events: ProjectEvent[] = [
  {
    type: 'tree.changed',
    reason: 'create',
    actorId: id,
    changes: [{ action: 'created', entity: 'document', id: other, parentId: null, name: 'a.tex' }],
  },
  {
    type: 'tree.changed',
    reason: 'main-document',
    actorId: id,
    changes: [],
    mainDocumentId: other,
  },
  memberAdded,
  { type: 'member.removed', userId: other, actorId: id },
  { type: 'member.role-updated', userId: other, role: 'editor', actorId: id },
  { type: 'chat.message-created', messageId: other, authorId: id },
  { type: 'comment.created', threadId: other, commentId: other, documentId: id, authorId: id },
  {
    type: 'banner.changed',
    banners: [
      {
        id,
        message: 'Maintenance ce soir',
        level: 'maintenance',
        startsAt: '2026-10-01T20:00:00.000Z',
        endsAt: null,
      },
    ],
  },
  { type: 'compile.updated', buildId: id, status: 'running', result: null },
]

describe('project events', () => {
  it.each(events)('round-trips $type through a stateless message', (event) => {
    const message = projectEventMessage(event, new Date('2026-10-02T10:00:00Z'))
    expect(message.v).toBe(PROJECT_EVENTS_VERSION)
    expect(parseProjectEventMessage(JSON.stringify(message))).toEqual(message)
  })

  it('validates the compile event of task 14 through the shared envelope', () => {
    const compile = { type: 'compile.updated', buildId: id, status: 'running', result: null }
    const message = (event: unknown) =>
      JSON.stringify({ ...projectEventMessage(memberAdded), event })
    expect(parseProjectEventMessage(message(compile))?.event).toEqual(compile)
    expect(parseProjectEventMessage(message({ ...compile, status: 'paused' }))).toBeNull()
    expect(parseProjectEventMessage(message({ ...compile, buildId: 'b' }))).toBeNull()
    expect(parseProjectEventMessage(message({ ...compile, type: 'compile' }))).toBeNull()
  })

  it.each([
    ['invalid JSON', '{'],
    ['another stateless message', JSON.stringify({ type: 'member.role-changed', role: 'viewer' })],
    ['a future version', JSON.stringify({ ...projectEventMessage(memberAdded), v: 2 })],
    [
      'an unknown event type',
      JSON.stringify({ ...projectEventMessage(memberAdded), event: { type: 'x' } }),
    ],
    [
      'a malformed tree change',
      JSON.stringify(
        projectEventMessage({
          type: 'tree.changed',
          reason: 'rename',
          actorId: null,
          changes: [{ action: 'updated', entity: 'folder', id: 'nope', parentId: null, name: '' }],
        } as unknown as ProjectEvent),
      ),
    ],
  ])('rejects %s', (_label, payload) => {
    expect(parseProjectEventMessage(payload)).toBeNull()
  })

  it('bounds the number of detailed tree changes', () => {
    const change = { action: 'deleted', entity: 'file', id: other }
    const event = (count: number) => ({
      event: {
        type: 'tree.changed',
        reason: 'delete',
        actorId: null,
        changes: Array.from({ length: count }, () => change),
      },
    })
    expect(publishProjectEventRequestSchema.safeParse(event(MAX_TREE_CHANGES)).success).toBe(true)
    expect(publishProjectEventRequestSchema.safeParse(event(MAX_TREE_CHANGES + 1)).success).toBe(
      false,
    )
  })

  it('only broadcasts banner changes to everyone', () => {
    expect(broadcastEventSchema.safeParse(events[7]).success).toBe(true)
    expect(broadcastEventSchema.safeParse(events[0]).success).toBe(false)
  })
})

describe('fitProjectEvent', () => {
  const event = (message: string): ProjectEvent => ({
    type: 'compile.updated',
    buildId: id,
    status: 'failure',
    result: {
      buildId: id,
      status: 'failure',
      durationMs: 10,
      pdfUrl: null,
      logUrl: null,
      entries: [{ level: 'warning', file: null, line: null, message, raw: message }],
    },
  })

  it('keeps an event that fits the realtime body limit, and events without result', () => {
    const small = event('Overfull \\hbox')
    expect(fitProjectEvent(small)).toBe(small)
    expect(fitProjectEvent(memberAdded)).toBe(memberAdded)
  })

  it('drops a result too large for the realtime service, which the client reads from the API', () => {
    const large = fitProjectEvent(event('x'.repeat(MAX_PROJECT_EVENT_BYTES / 2)))
    expect(large).toMatchObject({ status: 'failure', result: null, resultOmitted: true })
    expect(publishProjectEventRequestSchema.parse({ event: large }).event).toEqual(large)
    expect(
      new TextEncoder().encode(JSON.stringify({ event: large })).byteLength,
    ).toBeLessThanOrEqual(MAX_PROJECT_EVENT_BYTES)
  })
})
