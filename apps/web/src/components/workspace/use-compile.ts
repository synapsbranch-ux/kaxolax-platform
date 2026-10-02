'use client'

import type { CompileOptions, CompileResult, CompileUpdatedEvent } from '@kaxolax/contracts'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api, ApiError, errorMessage } from '@/lib/api'
import { type CompilePhase, WarmSchedule } from '@/lib/builds'
import {
  CompileController,
  type CompileResponse,
  type CompileSnapshot,
  type CompileTrigger,
} from '@/lib/compile-controller'

/** Code du refus 409 : une compilation du projet est déjà en cours (corps : son `buildId`). */
const COMPILE_IN_PROGRESS = 'E_COMPILE_IN_PROGRESS'

/** Réveils anticipés partagés par toutes les ouvertures de l'éditeur dans l'onglet. */
const warmSchedule = new WarmSchedule()

export interface CompileState {
  /** Dernier résultat (null : projet jamais compilé). */
  result: CompileResult | null
  /** Date de réception de `result` (ses liens présignés expirent une heure après la signature). */
  receivedAt: number
  compiling: boolean
  /** Étape en cours (null hors compilation) : préparation du compilateur, attente, compilation. */
  phase: CompilePhase | null
  /**
   * Lance une compilation. En mode synchrone, un nouvel appel remplace la précédente (seule la
   * dernière compte) ; en mode asynchrone, il est relancé dès la fin de celle en cours.
   * `auto` : auto-compilation, sans version dans l'historique.
   */
  compile: (trigger?: CompileTrigger) => Promise<void>
  stop: () => Promise<void>
  clearCache: () => Promise<void>
  /** Événement `compile.updated` reçu par le document meta du projet. */
  onBuildEvent: (event: CompileUpdatedEvent) => void
}

function inProgressBuildId(error: unknown): string | null {
  if (!(error instanceof ApiError) || error.code !== COMPILE_IN_PROGRESS) return null
  const body = error.body as { buildId?: unknown } | null
  return typeof body?.buildId === 'string' ? body.buildId : null
}

const IDLE: CompileSnapshot = { phase: null, result: null, receivedAt: 0 }

/**
 * Compilation du projet : attend que les dernières frappes soient arrivées au serveur (`flush`),
 * envoie les options de l'utilisateur (brouillon, arrêt à la première erreur) et garde le résultat.
 * Les deux modes de l'API (réponse synchrone, ou 202 suivi par `compile.updated` et un sondage de
 * repli) sont gérés par `CompileController` (`lib/compile-controller.ts`). Réveille aussi le
 * compilateur du projet à l'ouverture de l'éditeur quand `warm` est vrai (`compiler/warm`).
 */
export function useCompile({
  projectId,
  flush,
  options,
  warm,
  onError,
}: {
  projectId: string
  flush: () => Promise<void>
  options: CompileOptions
  /**
   * Réveil anticipé voulu : seulement pour qui peut modifier le projet (un lecteur qui consulte
   * ne doit pas consommer le plafond de compilateurs de l'utilisateur).
   */
  warm: boolean
  onError: (message: string | null) => void
}): CompileState {
  // État publié par le contrôleur, rattaché à son projet (changement de projet : état vide).
  const [published, setPublished] = useState<{ projectId: string; snapshot: CompileSnapshot }>({
    projectId,
    snapshot: IDLE,
  })
  const snapshot = published.projectId === projectId ? published.snapshot : IDLE
  const controller = useRef<CompileController | null>(null)
  // Valeurs lues au moment de l'appel : `compile` reste stable (raccourcis, auto-compilation).
  const latest = useRef({ flush, options, onError })
  useEffect(() => {
    latest.current = { flush, options, onError }
  })

  useEffect(() => {
    const created = new CompileController(
      {
        flush: () => latest.current.flush(),
        compile: async (trigger): Promise<CompileResponse> => {
          try {
            const response = await api.compile(projectId, latest.current.options, trigger)
            return response.kind === 'result'
              ? response
              : { kind: 'accepted', ...response.accepted }
          } catch (caught) {
            const buildId = inProgressBuildId(caught)
            if (buildId === null) throw caught
            return { kind: 'in-progress', buildId }
          }
        },
        build: async (buildId) => {
          const state = await api.build(projectId, buildId)
          return { buildId: state.buildId, status: state.status, result: state.result }
        },
        stop: () => api.stopCompile(projectId),
      },
      {
        onChange: (next) => {
          setPublished({ projectId, snapshot: next })
        },
        onError: (message) => {
          latest.current.onError(message)
        },
        describeError: errorMessage,
      },
    )
    controller.current = created
    return () => {
      created.dispose()
      if (controller.current === created) controller.current = null
    }
  }, [projectId])

  // Réveil anticipé du compilateur (mode asynchrone), sans attendre la réponse : à l'ouverture
  // de l'éditeur seulement (pas au retour sur l'onglet, qui garderait comptés au plafond les
  // projets laissés ouverts), au plus une fois par période. `skipped` (plafond presque atteint)
  // compte comme un réveil ; un échec (réseau, 5xx) ne compte pas, la prochaine ouverture
  // réessaie ; en mode synchrone (`unsupported`), plus aucun appel.
  useEffect(() => {
    const claimedAt = Date.now()
    if (!warm || !warmSchedule.claim(projectId, claimedAt)) return
    api.warmCompiler(projectId).then(
      ({ status }) => {
        if (status === 'unsupported') warmSchedule.markUnsupported(projectId)
      },
      () => {
        warmSchedule.release(projectId, claimedAt)
      },
    )
  }, [projectId, warm])

  const compile = useCallback(
    (trigger: CompileTrigger = 'manual') =>
      controller.current?.compile(trigger) ?? Promise.resolve(),
    [],
  )
  const stop = useCallback(() => controller.current?.stop() ?? Promise.resolve(), [])
  const onBuildEvent = useCallback((event: CompileUpdatedEvent) => {
    controller.current?.onEvent(event)
  }, [])

  const clearCache = useCallback(async () => {
    try {
      await api.clearCache(projectId)
    } catch (caught) {
      latest.current.onError(errorMessage(caught))
    }
  }, [projectId])

  return {
    result: snapshot.result,
    receivedAt: snapshot.receivedAt,
    compiling: snapshot.phase !== null,
    phase: snapshot.phase,
    compile,
    stop,
    clearCache,
    onBuildEvent,
  }
}
