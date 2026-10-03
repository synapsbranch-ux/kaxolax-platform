import Anthropic from '@anthropic-ai/sdk'
import app from '@adonisjs/core/services/app'
import ClaudeClient from '#services/claude/client'
import { aiRateLimiter } from '#services/claude/rate_limiter'

/**
 * Fausse API Anthropic pour les tests : le vrai SDK (`@anthropic-ai/sdk`) lui parle par un `fetch`
 * injecté. Les réponses sont servies dans l'ordre (flux SSE d'un message, erreur HTTP, erreur en
 * cours de flux) ; chaque requête est enregistrée (chemin, en-têtes, corps). Les nouvelles
 * tentatives du SDK sont réelles, sans attente (`retry-after-ms: 1`). Aucun appel réseau.
 */

export interface FakeUsage {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null
  iterations?: Record<string, unknown>[] | null
}

export interface FakeMessage {
  model?: string
  content: Record<string, unknown>[]
  stop_reason: string
  stop_details?: Record<string, unknown> | null
  usage: FakeUsage
}

type Reply =
  | { kind: 'message'; message: FakeMessage; failAfterStart?: string; fullOutput?: boolean }
  | { kind: 'error'; status: number; type: string }

export interface RecordedRequest {
  method: string
  path: string
  headers: Headers
  body: Record<string, unknown> | null
}

function sse(events: Record<string, unknown>[]): string {
  return events
    .map((event) => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
    .join('')
}

/** Événements de flux d'un bloc de contenu, comme l'API les envoie. */
function blockEvents(block: Record<string, unknown>, index: number): Record<string, unknown>[] {
  const stop = { type: 'content_block_stop', index }
  switch (block.type) {
    case 'text':
      return [
        { type: 'content_block_start', index, content_block: { type: 'text', text: '' } },
        { type: 'content_block_delta', index, delta: { type: 'text_delta', text: block.text } },
        stop,
      ]
    case 'thinking':
      return [
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        },
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'signature_delta', signature: block.signature },
        },
        stop,
      ]
    case 'tool_use':
      return [
        {
          type: 'content_block_start',
          index,
          content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
        },
        {
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input) },
        },
        stop,
      ]
    default:
      // Bloc sans delta (`fallback`, outils serveur) : envoyé entier au début.
      return [{ type: 'content_block_start', index, content_block: block }, stop]
  }
}

export class FakeAnthropicApi {
  readonly requests: RecordedRequest[] = []
  private readonly replies: Reply[] = []
  private served = 0
  /** Tant que non nul, les réponses à `POST /v1/messages` attendent cette promesse. */
  gate: Promise<void> | null = null
  /** Réponse de `GET /v1/models/:id` : null = 200, sinon l'erreur. */
  modelError: { status: number; type: string } | null = null

  /** Répond au prochain appel par ce message, en flux SSE. */
  reply(message: FakeMessage): this {
    this.replies.push({ kind: 'message', message })
    return this
  }

  /** Répond au prochain appel par une erreur HTTP (corps d'erreur de l'API). */
  fail(status: number, type: string): this {
    this.replies.push({ kind: 'error', status, type })
    return this
  }

  /** Répond par ce message avec une sortie égale au `max_tokens` de la requête (pire cas). */
  replyFullOutput(message: FakeMessage): this {
    this.replies.push({ kind: 'message', message, fullOutput: true })
    return this
  }

  /**
   * Commence le message (`message_start`, un token de sortie) et envoie ses blocs, puis un
   * événement `error` du type donné à la place de `message_delta` (usage final jamais reçu).
   */
  failMidStream(message: FakeMessage, type: string): this {
    this.replies.push({ kind: 'message', message, failAfterStart: type })
    return this
  }

  /** Appels à `POST /v1/messages`. */
  get messageRequests(): RecordedRequest[] {
    return this.requests.filter((request) => request.path === '/v1/messages')
  }

  readonly fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input))
    const method = (init?.method ?? 'GET').toUpperCase()
    const body =
      typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
    this.requests.push({ method, path: url.pathname, headers: new Headers(init?.headers), body })
    this.served += 1
    const headers = { 'request-id': `req_test_${String(this.served)}`, 'retry-after-ms': '1' }
    if (method === 'GET' && url.pathname.startsWith('/v1/models/')) {
      if (this.modelError) return this.errorResponse(this.modelError, headers)
      const id = decodeURIComponent(url.pathname.slice('/v1/models/'.length))
      return Response.json(
        { type: 'model', id, display_name: id, created_at: '2026-09-01T00:00:00Z' },
        { headers },
      )
    }
    const reply = this.replies.shift()
    if (!reply) throw new Error(`Unexpected request to the fake Anthropic API: ${url.pathname}`)
    if (this.gate) await this.gate
    if (reply.kind === 'error') return this.errorResponse(reply, headers)
    const message = reply.fullOutput
      ? {
          ...reply.message,
          usage: { ...reply.message.usage, output_tokens: Number(body?.max_tokens) },
        }
      : reply.message
    return new Response(this.stream(message, String(body?.model), reply.failAfterStart), {
      headers: { ...headers, 'content-type': 'text/event-stream' },
    })
  }

  private errorResponse(
    error: { status: number; type: string },
    headers: Record<string, string>,
  ): Promise<Response> {
    return Promise.resolve(
      Response.json(
        { type: 'error', error: { type: error.type, message: `Fake ${error.type}` } },
        { status: error.status, headers },
      ),
    )
  }

  private stream(message: FakeMessage, requestedModel: string, failAfterStart?: string): string {
    const usage = {
      cache_read_input_tokens: 0,
      cache_creation_input_tokens: 0,
      cache_creation: null,
      iterations: null,
      ...message.usage,
    }
    const start = {
      type: 'message_start',
      message: {
        id: `msg_test_${String(this.served)}`,
        type: 'message',
        role: 'assistant',
        model: message.model ?? requestedModel,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        stop_details: null,
        usage: { ...usage, output_tokens: 1, iterations: null },
      },
    }
    if (failAfterStart !== undefined) {
      return (
        sse([start, ...message.content.flatMap((block, index) => blockEvents(block, index))]) +
        `event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: failAfterStart, message: 'Fake' } })}\n\n`
      )
    }
    return sse([
      start,
      ...message.content.flatMap((block, index) => blockEvents(block, index)),
      {
        type: 'message_delta',
        delta: {
          stop_reason: message.stop_reason,
          stop_sequence: null,
          stop_details: message.stop_details ?? null,
        },
        usage: {
          output_tokens: usage.output_tokens,
          input_tokens: usage.input_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
          iterations: usage.iterations,
        },
      },
      { type: 'message_stop' },
    ])
  }

  /** Client Claude dont le SDK parle à cette fausse API (2 nouvelles tentatives, comme en vrai). */
  client(): ClaudeClient {
    return new ClaudeClient(
      new Anthropic({
        apiKey: 'test-anthropic-key',
        baseURL: 'http://anthropic.test',
        fetch: this.fetch,
        maxRetries: 2,
      }),
    )
  }
}

/**
 * Remplace le client Claude du conteneur par un client relié à `api` (ou sans clé : `null`) et
 * remet la limite de débit à zéro ; renvoie la fonction de restauration.
 */
export function useFakeClaude(api: FakeAnthropicApi | null): () => void {
  aiRateLimiter.reset()
  const client = api ? api.client() : new ClaudeClient(null)
  app.container.swap(ClaudeClient, () => client)
  return () => {
    app.container.restore(ClaudeClient)
    aiRateLimiter.reset()
  }
}
