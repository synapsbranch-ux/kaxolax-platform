import {
  type CompileRequest,
  type ConvertRequest,
  type ConvertResult,
  convertFailureSchema,
  convertResultSchema,
  type GatewayCompileResponse,
  gatewayCompileResponseSchema,
  INTERNAL_TOKEN_HEADER,
  type SynctexCodeQuery,
  type SynctexCodeResponse,
  synctexCodeResponseSchema,
  type SynctexPdfQuery,
  type SynctexPdfResponse,
  synctexPdfResponseSchema,
  type WordCountRequest,
  type WordCountResult,
  wordCountResultSchema,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import compileConfig from '#config/compile'

/** Le gateway ne répond pas, ou aucun agent n'est disponible. */
export class CompileServiceUnavailableException extends Exception {
  static override status = 503
  static override code = 'E_COMPILE_UNAVAILABLE'
  static override message = 'The compile service is unavailable, try again in a moment'
}

/** Aucune compilation sur un agent : pas de SyncTeX possible. */
export class NoCompileOutputException extends Exception {
  static override status = 404
  static override code = 'E_NO_COMPILE_OUTPUT'
  static override message = 'Compile the project first'
}

/** texcount n'a pas abouti (délai dépassé, document illisible) : message de l'agent. */
export class WordCountFailedException extends Exception {
  static override status = 422
  static override code = 'E_WORD_COUNT_FAILED'
  static override message = 'The word count failed'
}

/** Message d'erreur d'un corps `{ message }` renvoyé par l'agent (422), sinon le message par défaut. */
export async function wordCountFailure(response: Response): Promise<WordCountFailedException> {
  const body: unknown = await response.json().catch(() => null)
  const message =
    typeof body === 'object' &&
    body !== null &&
    'message' in body &&
    typeof body.message === 'string'
      ? body.message
      : undefined
  return new WordCountFailedException(message)
}

/** pandoc n'a pas abouti dans le sandbox (`reason` de l'agent : délai, mémoire, taille, erreur). */
export class ConvertFailedException extends Exception {
  static override status = 422
  static override code = 'E_CONVERT_FAILED'
  static override message = 'The Markdown conversion failed'
}

/** Demande de conversion refusée par l'agent (400) : jamais une erreur interne de l'API. */
export class ConvertRejectedException extends Exception {
  static override status = 422
  static override code = 'E_CONVERT_REJECTED'
  static override message = 'The compile service refused this conversion request'
}

const CONVERT_FAILURE_MESSAGES = {
  timeout: 'The Markdown conversion took too long',
  out_of_memory: 'The Markdown conversion ran out of memory',
  output_too_large: 'The converted document is too large',
  failed: 'pandoc could not convert this Markdown',
} as const

/**
 * Échec de conversion décrit par l'agent (corps `ConvertFailure`, 422) : message selon la raison,
 * suivi de la sortie de pandoc pour `failed` (tronquée par l'agent).
 */
export async function convertFailure(response: Response): Promise<ConvertFailedException> {
  const parsed = convertFailureSchema.safeParse(await response.json().catch(() => null))
  if (!parsed.success) return new ConvertFailedException()
  const { reason, message } = parsed.data
  const base = CONVERT_FAILURE_MESSAGES[reason]
  return new ConvertFailedException(
    reason === 'failed' && message.trim() !== '' ? `${base}: ${message.trim()}` : base,
  )
}

/** Appels de l'API au compile-gateway (réseau interne, X-Internal-Token). Remplacé dans les tests. */
export default class CompileGateway {
  /** Requête au gateway ; une erreur réseau ou un délai dépassé donne 503. */
  private async send(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
  ): Promise<Response> {
    try {
      return await fetch(`${compileConfig.gatewayUrl}${path}`, {
        method: init.method,
        headers: {
          [INTERNAL_TOKEN_HEADER]: compileConfig.internalToken.release(),
          ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        body: init.body === undefined ? undefined : JSON.stringify(init.body),
        signal: AbortSignal.timeout(init.timeoutMs),
      })
    } catch (error) {
      throw new CompileServiceUnavailableException(undefined, { cause: error })
    }
  }

  private async call(
    path: string,
    init: { method: 'GET' | 'POST'; body?: unknown; timeoutMs: number },
  ) {
    const response = await this.send(path, init)
    if (response.status === 503) throw new CompileServiceUnavailableException()
    if (response.status === 404) throw new NoCompileOutputException()
    if (!response.ok) throw new Error(`compile gateway answered ${String(response.status)}`)
    return response.json()
  }

  async compile(request: CompileRequest): Promise<GatewayCompileResponse> {
    const body = await this.call('/compile', {
      method: 'POST',
      body: request,
      timeoutMs: request.timeoutMs + compileConfig.gatewayMarginMs,
    })
    return gatewayCompileResponseSchema.parse(body)
  }

  /** Comptage de mots par texcount sur un agent (synchrone, quelques secondes au plus). */
  async wordCount(request: WordCountRequest): Promise<WordCountResult> {
    const response = await this.send(`/projects/${request.projectId}/word-count`, {
      method: 'POST',
      body: request,
      timeoutMs: compileConfig.wordCountTimeoutMs,
    })
    if (response.status === 422) throw await wordCountFailure(response)
    if (response.status === 503) throw new CompileServiceUnavailableException()
    if (!response.ok) throw new Error(`compile gateway answered ${String(response.status)}`)
    return wordCountResultSchema.parse(await response.json())
  }

  /** Conversion Markdown → LaTeX par pandoc sur un agent (synchrone, quelques secondes). */
  async convert(request: ConvertRequest): Promise<ConvertResult> {
    const response = await this.send(`/projects/${request.projectId}/convert`, {
      method: 'POST',
      body: request,
      timeoutMs: compileConfig.convertTimeoutMs,
    })
    if (response.status === 422) throw await convertFailure(response)
    if (response.status === 400) throw new ConvertRejectedException()
    if (response.status === 503) throw new CompileServiceUnavailableException()
    if (!response.ok) throw new Error(`compile gateway answered ${String(response.status)}`)
    return convertResultSchema.parse(await response.json())
  }

  async stop(projectId: string): Promise<boolean> {
    const body = (await this.call(`/projects/${projectId}/stop`, {
      method: 'POST',
      timeoutMs: compileConfig.shortCallTimeoutMs,
    })) as { stopped?: unknown }
    return body.stopped === true
  }

  async clearCache(projectId: string): Promise<boolean> {
    const body = (await this.call(`/projects/${projectId}/clear-cache`, {
      method: 'POST',
      timeoutMs: compileConfig.shortCallTimeoutMs,
    })) as { cleared?: unknown }
    return body.cleared === true
  }

  async synctexFromCode(projectId: string, query: SynctexCodeQuery): Promise<SynctexCodeResponse> {
    const params = new URLSearchParams({
      file: query.file,
      line: String(query.line),
      column: String(query.column),
    })
    const body = await this.call(`/projects/${projectId}/synctex/code?${params.toString()}`, {
      method: 'GET',
      timeoutMs: compileConfig.shortCallTimeoutMs,
    })
    return synctexCodeResponseSchema.parse(body)
  }

  async synctexFromPdf(projectId: string, query: SynctexPdfQuery): Promise<SynctexPdfResponse> {
    const params = new URLSearchParams({
      page: String(query.page),
      h: String(query.h),
      v: String(query.v),
    })
    const body = await this.call(`/projects/${projectId}/synctex/pdf?${params.toString()}`, {
      method: 'GET',
      timeoutMs: compileConfig.shortCallTimeoutMs,
    })
    return synctexPdfResponseSchema.parse(body)
  }
}
