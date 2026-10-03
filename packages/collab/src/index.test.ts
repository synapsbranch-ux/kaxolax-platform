import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import {
  createDocumentState,
  documentName,
  metaDocumentName,
  parseDocumentName,
  parseMetaDocumentName,
  parseRealtimeDocumentName,
  parseUserChannelName,
  readDocumentText,
  replaceDocumentText,
  TEXT_FIELD,
  userChannelName,
} from './index.js'

const projectId = '6f1c2d3e-4b5a-4c7d-8e9f-0a1b2c3d4e5f'
const documentId = '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a'

describe('document names', () => {
  it('round-trips', () => {
    const name = documentName(projectId, documentId)
    expect(name).toBe(`project:${projectId}:doc:${documentId}`)
    expect(parseDocumentName(name)).toEqual({ projectId, documentId })
  })

  it.each([
    'project:x:doc:y',
    `project:${projectId}:file:${documentId}`,
    `${documentName(projectId, documentId)}:extra`,
  ])('rejects %s', (name) => {
    expect(parseDocumentName(name)).toBeNull()
  })
})

describe('meta document names', () => {
  it('round-trips', () => {
    const name = metaDocumentName(projectId)
    expect(name).toBe(`project:${projectId}:meta`)
    expect(parseMetaDocumentName(name)).toEqual({ projectId })
  })

  it('is never mistaken for a text document, and the other way round', () => {
    expect(parseDocumentName(metaDocumentName(projectId))).toBeNull()
    expect(parseMetaDocumentName(documentName(projectId, documentId))).toBeNull()
  })

  it('tells text and meta documents apart', () => {
    expect(parseRealtimeDocumentName(metaDocumentName(projectId))).toEqual({
      kind: 'meta',
      projectId,
    })
    expect(parseRealtimeDocumentName(documentName(projectId, documentId))).toEqual({
      kind: 'text',
      projectId,
      documentId,
    })
  })

  it.each([
    'project:x:meta',
    `project:${projectId}:meta:extra`,
    `project:${projectId}:Meta`,
    `prefix:project:${projectId}:meta`,
    '',
  ])('rejects %s', (name) => {
    expect(parseMetaDocumentName(name)).toBeNull()
    expect(parseRealtimeDocumentName(name)).toBeNull()
  })
})

describe('document state', () => {
  it('stores the text in a Y.Text named content', () => {
    const state = createDocumentState('\\documentclass{article} é')
    const doc = new Y.Doc()
    Y.applyUpdate(doc, state)
    expect(doc.getText(TEXT_FIELD).toJSON()).toBe('\\documentclass{article} é')
    expect(readDocumentText(state)).toBe('\\documentclass{article} é')
  })

  it('handles empty and missing states', () => {
    expect(readDocumentText(createDocumentState(''))).toBe('')
    expect(readDocumentText(null)).toBe('')
  })

  it('replaces the text while keeping the document history mergeable', () => {
    const initial = createDocumentState('one')
    const replaced = replaceDocumentText(initial, 'two')
    expect(readDocumentText(replaced)).toBe('two')
    // Un client qui avait l'état initial peut fusionner le nouvel état.
    const client = new Y.Doc()
    Y.applyUpdate(client, initial)
    Y.applyUpdate(client, replaced)
    expect(client.getText(TEXT_FIELD).toJSON()).toBe('two')
  })
})

describe('user channel names', () => {
  it('round-trips and is told apart from project documents', () => {
    const name = userChannelName(projectId)
    expect(name).toBe(`user:${projectId}`)
    expect(parseUserChannelName(name)).toEqual({ userId: projectId })
    expect(parseRealtimeDocumentName(name)).toEqual({ kind: 'user', userId: projectId })
    expect(parseDocumentName(name)).toBeNull()
    expect(parseMetaDocumentName(name)).toBeNull()
    expect(parseUserChannelName(metaDocumentName(projectId))).toBeNull()
  })

  it.each(['user:x', `user:${projectId}:extra`, `users:${projectId}`])('rejects %s', (name) => {
    expect(parseUserChannelName(name)).toBeNull()
  })
})
