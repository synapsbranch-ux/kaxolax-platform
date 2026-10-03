import app from '@adonisjs/core/services/app'
import logger from '@adonisjs/core/services/logger'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import historyConfig from '#config/history'
import ObjectStorage from '#services/object_storage'
import RealtimeClient from '#services/realtime_client'
import { accountOfProject, historyRetention } from '#services/entitlements'
import {
  createVersion,
  dueProjectIds,
  type HistoryDependencies,
  markVersionRetry,
  purgeProjectHistory,
} from '#services/history_service'

/**
 * Tâches périodiques de l'historique, dans chaque processus web de l'API : versions automatiques
 * (projets restés `idleSeconds` sans modification) et purge selon la conservation du plan du
 * propriétaire. Plusieurs instances peuvent tourner : chaque projet est traité sous le verrou de
 * son historique, et la condition est revérifiée sous ce verrou (une seule version).
 */

/**
 * Crée les versions automatiques dues ; renvoie le nombre de versions créées. Un projet en échec
 * (stockage indisponible, manifeste illisible) est remis à plus tard (`retrySeconds`).
 */
export async function sweepDueVersions(
  deps: HistoryDependencies,
  now: DateTime = DateTime.utc(),
): Promise<number> {
  const due = { now, idleSeconds: historyConfig.idleSeconds }
  let created = 0
  for (const projectId of await dueProjectIds(due)) {
    try {
      const result = await createVersion(deps, projectId, { kind: 'auto', due })
      if (result?.created) created++
    } catch (error) {
      logger.error({ err: error, projectId }, 'could not create an automatic version')
      await markVersionRetry(projectId, now.plus({ seconds: historyConfig.retrySeconds }))
    }
  }
  return created
}

/**
 * Purge les versions expirées de tous les projets (conservation la plus courte des plans comme
 * premier filtre) ; renvoie le nombre de versions purgées.
 */
export async function purgeExpiredHistory(
  storage: ObjectStorage,
  now: DateTime = DateTime.utc(),
): Promise<number> {
  const shortest = (await db
    .from('plan_limits')
    .whereNotNull('history_retention_days')
    .min('history_retention_days as days')
    .first()) as { days: number | null } | null
  if (shortest?.days === null || shortest?.days === undefined) return 0
  const cutoff = now.minus({ days: shortest.days }).toJSDate()
  const candidates = (await db
    .from('project_versions')
    .join('projects', 'projects.id', 'project_versions.project_id')
    .whereNull('project_versions.label')
    .where('project_versions.created_at', '<', cutoff)
    .distinct('projects.id', 'projects.owner_id', 'projects.workspace_id')) as {
    id: string
    owner_id: string
    workspace_id: string
  }[]
  let purged = 0
  for (const project of candidates) {
    try {
      // Plan du propriétaire, ou de l'organisation pour un projet d'équipe (tâche 12) ;
      // `purgeProjectHistory` garde les versions avec label.
      const account = await accountOfProject({
        ownerId: project.owner_id,
        workspaceId: project.workspace_id,
      })
      const { days } = await historyRetention(account)
      purged += await purgeProjectHistory(storage, project.id, days, now)
    } catch (error) {
      logger.error({ err: error, projectId: project.id }, 'history purge failed')
    }
  }
  return purged
}

/** Lance les deux tâches périodiques ; renvoie la fonction qui les arrête. */
export async function startHistoryScheduler(): Promise<() => void> {
  const deps: HistoryDependencies = {
    storage: await app.container.make(ObjectStorage),
    realtime: await app.container.make(RealtimeClient),
  }
  const timers: NodeJS.Timeout[] = []
  const every = (seconds: number, name: string, task: () => Promise<number>) => {
    if (seconds <= 0) return
    let running = false
    const timer = setInterval(() => {
      if (running) return
      running = true
      task()
        .then((count) => {
          if (count > 0) logger.info({ count }, `history ${name}`)
        })
        .catch((error: unknown) => {
          logger.error({ err: error }, `history ${name} failed`)
        })
        .finally(() => {
          running = false
        })
    }, seconds * 1000)
    timer.unref()
    timers.push(timer)
  }
  every(historyConfig.sweepSeconds, 'versions created', () => sweepDueVersions(deps))
  every(historyConfig.purgeSeconds, 'versions purged', () => purgeExpiredHistory(deps.storage))
  return () => {
    for (const timer of timers) clearInterval(timer)
  }
}
