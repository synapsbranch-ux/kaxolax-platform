import {
  WORD_COUNT_EXTENSIONS,
  wordCountRequestSchema,
  type WordCountResponse,
} from '@kaxolax/contracts'
import { Exception } from '@adonisjs/core/exceptions'
import compileConfig from '#config/compile'
import type Project from '#models/project'
import type User from '#models/user'
import type CompileGateway from '#services/compile_gateway'
import { WordCountFailedException } from '#services/compile_gateway'
import { NoMainDocumentException } from '#services/compile_service'
import type CompileWorkerClient from '#services/compile_worker'
import { reserveCompiler } from '#services/compiler_quota'
import { projectContent } from '#services/project_content'
import type RealtimeClient from '#services/realtime_client'
import { EntityNotFoundException } from '#services/tree_service'

/** Un comptage d'un autre document est déjà en cours, ou trop de comptages pour l'utilisateur. */
export class WordCountBusyException extends Exception {
  static override status = 429
  static override code = 'E_WORD_COUNT_BUSY'
  static override message = 'A word count is already running, try again when it is done'
}

/** Comptages en cours au plus par utilisateur (projets distincts), par instance de l'API. */
export const MAX_WORD_COUNTS_PER_USER = 2

/** Comptage en cours d'un utilisateur dans un projet : document compté et résultat attendu. */
interface RunningCount {
  documentKey: string
  result: Promise<WordCountResponse>
}

/** Comptages en cours, par `utilisateur:projet`. */
const running = new Map<string, RunningCount>()
/** Nombre de comptages en cours par utilisateur. */
const runningPerUser = new Map<string, number>()

export interface WordCountDependencies {
  gateway: CompileGateway
  worker: CompileWorkerClient
  realtime: RealtimeClient
}

/**
 * Comptage des mots, au plus un en cours par (utilisateur, projet) et `MAX_WORD_COUNTS_PER_USER`
 * par utilisateur : une nouvelle demande pour le même document attend le comptage en cours et
 * reçoit son résultat, une autre répond 429 `E_WORD_COUNT_BUSY`. Chaque demande transporte
 * jusqu'à 16 Mo de texte et occupe un emplacement de l'agent pendant jusqu'à 20 s : sans cette
 * borne, un seul membre (lecteur compris) pourrait saturer les agents et la mémoire. La borne est
 * propre à chaque instance de l'API ; l'agent borne aussi sa file d'attente (503 au-delà).
 */
export function countWords(
  deps: WordCountDependencies,
  user: User,
  project: Project,
  documentId?: string,
): Promise<WordCountResponse> {
  const key = `${user.id}:${project.id}`
  const documentKey = documentId ?? ''
  const current = running.get(key)
  if (current) {
    if (current.documentKey === documentKey) return current.result
    return Promise.reject(new WordCountBusyException())
  }
  const count = runningPerUser.get(user.id) ?? 0
  if (count >= MAX_WORD_COUNTS_PER_USER) return Promise.reject(new WordCountBusyException())
  runningPerUser.set(user.id, count + 1)
  const result = runCount(deps, user, project, documentId).finally(() => {
    running.delete(key)
    const left = (runningPerUser.get(user.id) ?? 1) - 1
    if (left <= 0) runningPerUser.delete(user.id)
    else runningPerUser.set(user.id, left)
  })
  running.set(key, { documentKey, result })
  return result
}

/**
 * Compte les mots du document principal (ou de `documentId`) et des documents qu'il inclut :
 * texcount tourne dans le sandbox de compilation, par le gateway (mode `gateway`) ou par le
 * conteneur du projet (mode `cloudflare`, réveillé si besoin et compté dans le plafond de
 * compilateurs de l'utilisateur). Seuls les documents `.tex`/`.ltx` (et le document compté)
 * voyagent, avec leur texte courant (instantané temps réel).
 */
async function runCount(
  deps: WordCountDependencies,
  user: User,
  project: Project,
  documentId?: string,
): Promise<WordCountResponse> {
  const content = await projectContent(deps.realtime, project.id)
  const rootId = documentId ?? project.mainDocumentId
  const root = content.documents.find((document) => document.id === rootId)
  if (!root) {
    if (documentId !== undefined) throw new EntityNotFoundException('Document not found')
    throw new NoMainDocumentException()
  }
  const parsed = wordCountRequestSchema.safeParse({
    projectId: project.id,
    rootResourcePath: root.path,
    resources: content.documents
      .filter((document) => document.id === root.id || WORD_COUNT_EXTENSIONS.test(document.path))
      .map((document) => ({
        path: document.path,
        kind: 'text' as const,
        content: document.content,
        sha256: document.sha256,
      })),
  })
  if (!parsed.success) {
    throw new WordCountFailedException('The documents of this project are too large to count')
  }
  const started = performance.now()
  let result
  if (compileConfig.backend === 'cloudflare') {
    await reserveCompiler(user.id, project.id)
    result = await deps.worker.wordCount(parsed.data)
  } else {
    result = await deps.gateway.wordCount(parsed.data)
  }
  return {
    ...result,
    rootResourcePath: root.path,
    durationMs: Math.round(performance.now() - started),
  }
}
