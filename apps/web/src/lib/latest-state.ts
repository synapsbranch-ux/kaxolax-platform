/**
 * Ordre des mises à jour d'un état alimenté à la fois par des lectures HTTP et par des événements
 * en direct : une lecture n'est appliquée que si rien de plus récent n'est arrivé depuis son
 * départ (ni événement, ni autre lecture partie après elle). Sans cela, une réponse lente
 * écraserait un événement reçu entre-temps avec un état plus ancien.
 */
export interface LatestState {
  /** Un événement en direct vient d'être appliqué : les lectures en cours sont périmées. */
  live(): void
  /** Départ d'une lecture ; la fonction rendue dit, à sa réponse, si elle peut s'appliquer. */
  begin(): () => boolean
}

export function createLatestState(): LatestState {
  let sequence = 0
  return {
    live() {
      sequence += 1
    },
    begin() {
      sequence += 1
      const started = sequence
      return () => sequence === started
    },
  }
}
