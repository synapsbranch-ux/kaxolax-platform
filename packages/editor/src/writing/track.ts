import { type EditorState, StateEffect, StateField } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'

/** Plage détectée à l'ouverture d'un outil, avec son texte d'origine. */
export interface TextTarget {
  from: number
  to: number
  text: string
  /** Identifiant de suivi (`trackTarget`) : la plage suit les modifications du document. */
  track?: number
}

interface TrackedRange {
  id: number
  from: number
  to: number
}

/** Nombre de plages suivies gardées (une par boîte de dialogue ouverte, les plus récentes). */
const MAX_TRACKED = 16

const addTracked = StateEffect.define<TrackedRange>()
const removeTracked = StateEffect.define<number>()

/**
 * Plages suivies : recalculées à chaque modification (collaborateurs compris), comme une
 * sélection. Une insertion à une extrémité reste hors de la plage.
 */
const trackedField = StateField.define<readonly TrackedRange[]>({
  create: () => [],
  update(ranges, tr) {
    let next = tr.docChanged
      ? ranges.map((range) => {
          const from = tr.changes.mapPos(range.from, 1)
          return { ...range, from, to: Math.max(from, tr.changes.mapPos(range.to, -1)) }
        })
      : ranges
    for (const effect of tr.effects) {
      if (effect.is(addTracked)) next = [...next, effect.value].slice(-MAX_TRACKED)
      else if (effect.is(removeTracked)) next = next.filter((range) => range.id !== effect.value)
    }
    return next
  },
})

let lastId = 0

/**
 * Commence le suivi d'une plage détectée à l'ouverture d'un outil : sa position est mise à jour
 * à chaque modification du document pendant que la boîte de dialogue est ouverte.
 */
export function trackTarget(view: EditorView, target: TextTarget | null): TextTarget | null {
  if (target === null) return null
  const id = ++lastId
  const range = { id, from: target.from, to: target.to }
  view.dispatch({
    effects:
      view.state.field(trackedField, false) === undefined
        ? [StateEffect.appendConfig.of(trackedField), addTracked.of(range)]
        : addTracked.of(range),
  })
  return { ...target, track: id }
}

/** Termine le suivi d'une plage (après l'insertion). */
export function releaseTarget(view: EditorView, target: TextTarget | null): void {
  if (target?.track === undefined || view.state.field(trackedField, false) === undefined) return
  view.dispatch({ effects: removeTracked.of(target.track) })
}

/**
 * Position actuelle d'une plage détectée plus tôt : plage suivie (`trackTarget`) depuis
 * l'ouverture, sinon position d'origine. Null si elle ne contient plus exactement le texte
 * d'origine (modifiée ou supprimée entre-temps) : on ne remplace jamais une autre occurrence.
 */
export function locateTarget(
  state: EditorState | string,
  target: TextTarget,
): { from: number; to: number } | null {
  let { from, to } = target
  if (typeof state !== 'string' && target.track !== undefined) {
    const tracked = state.field(trackedField, false)?.find((range) => range.id === target.track)
    if (tracked === undefined) return null
    from = tracked.from
    to = tracked.to
  }
  const text = typeof state === 'string' ? state.slice(from, to) : state.sliceDoc(from, to)
  return text === target.text ? { from, to } : null
}
