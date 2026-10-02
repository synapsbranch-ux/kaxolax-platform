import { projectEventMessage } from '@kaxolax/contracts'
import { describe, expect, it, vi } from 'vitest'
import {
  bannerFeed,
  chatFeed,
  eventEffect,
  historyFeed,
  parseRealtimeMessage,
} from './project-events'

const SELF = '00000000-0000-4000-8000-000000000001'
const OTHER = '00000000-0000-4000-8000-000000000002'
const DOC = '10000000-0000-4000-8000-000000000001'

describe('realtime messages', () => {
  it('reads project events and role changes, ignores anything else', () => {
    const event = { type: 'member.removed' as const, userId: OTHER, actorId: SELF }
    expect(parseRealtimeMessage(JSON.stringify(projectEventMessage(event)))).toEqual({
      kind: 'event',
      event,
    })
    expect(
      parseRealtimeMessage(
        JSON.stringify({ type: 'member.role-changed', role: 'viewer', readOnly: true }),
      ),
    ).toEqual({
      kind: 'role',
      message: { type: 'member.role-changed', role: 'viewer', readOnly: true },
    })
    expect(parseRealtimeMessage('not json')).toBeNull()
    expect(parseRealtimeMessage(JSON.stringify({ ...projectEventMessage(event), v: 2 }))).toBeNull()
    expect(
      parseRealtimeMessage(JSON.stringify({ type: 'member.role-changed', role: 'god' })),
    ).toBeNull()
  })

  it('maps events to what the project page does', () => {
    expect(
      eventEffect(
        {
          type: 'tree.changed',
          reason: 'create',
          actorId: OTHER,
          changes: [{ action: 'deleted', entity: 'document', id: DOC }],
        },
        SELF,
      ),
    ).toEqual({ kind: 'refresh-tree' })
    expect(
      eventEffect({ type: 'member.added', userId: OTHER, role: 'viewer', actorId: null }, SELF),
    ).toEqual({
      kind: 'refresh-members',
    })
    expect(eventEffect({ type: 'member.removed', userId: SELF, actorId: OTHER }, SELF)).toEqual({
      kind: 'refresh-access',
    })
    expect(
      eventEffect(
        { type: 'member.role-updated', userId: OTHER, role: 'editor', actorId: SELF },
        SELF,
      ),
    ).toEqual({ kind: 'refresh-members' })
    expect(
      eventEffect({ type: 'project.updated', actorId: OTHER, spellcheckLanguage: 'fr' }, SELF),
    ).toEqual({ kind: 'project', changes: { spellcheckLanguage: 'fr' } })
    expect(eventEffect({ type: 'project.updated', actorId: OTHER }, SELF)).toEqual({
      kind: 'none',
    })
    expect(eventEffect({ type: 'banner.changed', banners: [] }, SELF)).toEqual({
      kind: 'banners',
      banners: [],
    })
    expect(
      eventEffect(
        { type: 'compile.updated', buildId: OTHER, status: 'running', result: null },
        SELF,
      ),
    ).toEqual({ kind: 'none' })
    const chat = { type: 'chat.message-created' as const, messageId: DOC, authorId: OTHER }
    expect(eventEffect(chat, SELF)).toEqual({ kind: 'chat', event: chat })
  })

  it('relays chat messages to subscribers until they unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = chatFeed.subscribe(listener)
    const event = { type: 'chat.message-created' as const, messageId: DOC, authorId: OTHER }
    chatFeed.publish(event)
    unsubscribe()
    chatFeed.publish(event)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener).toHaveBeenCalledWith(event)
  })

  it('relays live banners to subscribers until they unsubscribe', () => {
    const listener = vi.fn()
    const unsubscribe = bannerFeed.subscribe(listener)
    bannerFeed.publish([])
    unsubscribe()
    bannerFeed.publish([])
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('relays new versions to the history drawer', () => {
    const event = {
      type: 'version.created' as const,
      versionId: DOC,
      kind: 'compile' as const,
      actorId: OTHER,
    }
    expect(eventEffect(event, SELF)).toEqual({ kind: 'history', event })
    const listener = vi.fn()
    const unsubscribe = historyFeed.subscribe(listener)
    historyFeed.publish(event)
    unsubscribe()
    historyFeed.publish(event)
    expect(listener).toHaveBeenCalledTimes(1)
  })
})
