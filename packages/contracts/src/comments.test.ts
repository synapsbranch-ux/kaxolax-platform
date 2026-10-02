import { describe, expect, it } from 'vitest'
import {
  COMMENT_BODY_MAX_LENGTH,
  commentThreadsQuerySchema,
  createCommentThreadInputSchema,
} from './comments.js'
import { parseProjectEventMessage, projectEventMessage } from './events.js'

const documentId = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'
const threadId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'

describe('comment contracts', () => {
  it('validates a new thread', () => {
    const input = { documentId, anchor: 'AQAAAAUBAgME', quotedText: 'le monde', body: '  Ok ? ' }
    expect(createCommentThreadInputSchema.parse(input).body).toBe('Ok ?')
    for (const invalid of [
      { ...input, anchor: 'pas du base64' },
      { ...input, quotedText: '' },
      { ...input, body: '   ' },
      { ...input, body: 'x'.repeat(COMMENT_BODY_MAX_LENGTH + 1) },
    ]) {
      expect(createCommentThreadInputSchema.safeParse(invalid).success).toBe(false)
    }
  })

  it('lists all threads by default', () => {
    expect(commentThreadsQuerySchema.parse({})).toEqual({ status: 'all' })
    expect(commentThreadsQuerySchema.safeParse({ status: 'closed' }).success).toBe(false)
  })

  it('carries comment events on the meta document', () => {
    for (const event of [
      { type: 'comment.created', threadId, commentId: threadId, documentId, authorId: threadId },
      {
        type: 'comment.thread-updated',
        threadId,
        documentId,
        change: 'resolved',
        actorId: threadId,
      },
    ] as const) {
      const message = parseProjectEventMessage(JSON.stringify(projectEventMessage(event)))
      expect(message?.event).toEqual(event)
    }
  })
})
