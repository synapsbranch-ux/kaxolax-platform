import * as Y from 'yjs'

/**
 * Rattrapage d'un document entre instances (plusieurs instances derrière Redis) : une instance
 * décrit l'état Yjs d'un document qu'elle a chargé (vecteur d'état et suppressions,
 * `Y.snapshot`) ; une autre attend que sa propre copie le contienne, l'extension Redis de
 * Hocuspocus lui apportant les mises à jour manquantes. Le vecteur d'état seul ne suffit pas :
 * une suppression ne l'avance pas.
 */

type DeleteSet = Y.Snapshot['ds']

/** État Yjs d'un document (vecteur d'état et suppressions), en base64. */
export function encodeDocumentState(document: Y.Doc): string {
  return Buffer.from(Y.encodeSnapshot(Y.snapshot(document))).toString('base64')
}

/** État reçu d'une autre instance ; null s'il est illisible. */
export function decodeDocumentState(encoded: string): Y.Snapshot | null {
  try {
    return Y.decodeSnapshot(new Uint8Array(Buffer.from(encoded, 'base64')))
  } catch {
    return null
  }
}

/**
 * Vrai si toutes les suppressions de `remote` sont dans `local`. `local` vient de `Y.snapshot` :
 * plages triées et fusionnées par client, une plage supprimée de `remote` est donc dans une seule
 * plage de `local`. Rien n'est modifié (les fonctions de fusion de Yjs modifient leurs entrées).
 */
function containsDeletes(local: DeleteSet, remote: DeleteSet): boolean {
  for (const [client, items] of remote.clients) {
    const ranges = local.clients.get(client) ?? []
    let index = 0
    for (const item of [...items].sort((a, b) => a.clock - b.clock)) {
      if (item.len === 0) continue
      while (index < ranges.length) {
        const range = ranges[index]
        if (!range || range.clock + range.len > item.clock) break
        index++
      }
      const range = ranges[index]
      if (!range || range.clock > item.clock || item.clock + item.len > range.clock + range.len) {
        return false
      }
    }
  }
  return true
}

/** Vrai si le document contient tout l'état `remote` (insertions et suppressions). */
export function containsState(document: Y.Doc, remote: Y.Snapshot): boolean {
  const local = Y.snapshot(document)
  for (const [client, clock] of remote.sv) {
    if ((local.sv.get(client) ?? 0) < clock) return false
  }
  return containsDeletes(local.ds, remote.ds)
}

/**
 * Attend que le document contienne chacun des états `remotes`, au plus jusqu'à `deadline`
 * (ms depuis l'époque Unix). Renvoie faux si le délai est dépassé.
 */
export async function waitForStates(
  document: Y.Doc,
  remotes: readonly Y.Snapshot[],
  deadline: number,
  pollMs = 20,
): Promise<boolean> {
  while (!remotes.every((remote) => containsState(document, remote))) {
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, pollMs))
  }
  return true
}
