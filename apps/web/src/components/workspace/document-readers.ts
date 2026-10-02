import { HocuspocusProvider, type HocuspocusProviderWebsocket } from '@hocuspocus/provider'
import { documentName, TEXT_FIELD } from '@kaxolax/collab'
import * as Y from 'yjs'
import { api } from '@/lib/api'

/** Jeton temps réel partagé par les lecteurs de documents (valable 5 minutes, gardé 2). */
let sharedToken: { projectId: string; promise: Promise<string>; until: number } | null = null

/** Jeton temps réel du projet, partagé par tous les lecteurs ouverts en même temps. */
export function sharedRealtimeToken(projectId: string): Promise<string> {
  const now = Date.now()
  if (sharedToken?.projectId !== projectId || sharedToken.until < now) {
    const promise = api.realtimeToken(projectId).then(({ token }) => token)
    sharedToken = { projectId, promise, until: now + 2 * 60_000 }
    // Un échec ne reste pas en cache.
    promise.catch(() => {
      sharedToken = null
    })
  }
  return sharedToken.promise
}

/**
 * Ouvre un lecteur Yjs d'un document sur la connexion du projet : lecture seule, sans présence
 * (il n'apparaît pas parmi les collaborateurs en ligne). `onText` reçoit le texte à la
 * synchronisation, puis après chaque salve de modifications (anti-rebond `delayMs`). Renvoie la
 * fonction de fermeture.
 */
export function openDocumentReader(
  projectId: string,
  socket: HocuspocusProviderWebsocket,
  documentId: string,
  onText: (text: string) => void,
  delayMs: number,
): () => void {
  const doc = new Y.Doc()
  const text = doc.getText(TEXT_FIELD)
  const provider = new HocuspocusProvider({
    websocketProvider: socket,
    name: documentName(projectId, documentId),
    document: doc,
    sessionAwareness: true,
    token: () => sharedRealtimeToken(projectId),
  })
  provider.awareness?.setLocalState(null)
  provider.attach()
  let timer: ReturnType<typeof setTimeout> | null = null
  const publish = () => {
    timer = null
    onText(text.toJSON())
  }
  const schedule = () => {
    if (timer !== null) clearTimeout(timer)
    timer = setTimeout(publish, delayMs)
  }
  provider.on('synced', publish)
  text.observe(schedule)
  return () => {
    if (timer !== null) clearTimeout(timer)
    text.unobserve(schedule)
    provider.destroy()
    doc.destroy()
  }
}

/**
 * Lecteurs d'un ensemble de documents qui varie (arborescence modifiée) : `sync` ouvre les
 * nouveaux et ferme ceux qui ne sont plus demandés, sans toucher aux autres.
 */
export class DocumentReaders {
  readonly #open = new Map<string, () => void>()

  constructor(
    private readonly projectId: string,
    private readonly socket: HocuspocusProviderWebsocket,
    private readonly onText: (documentId: string, text: string) => void,
    private readonly delayMs: number,
  ) {}

  sync(documentIds: Iterable<string>): void {
    const wanted = new Set(documentIds)
    for (const [id, close] of this.#open) {
      if (wanted.has(id)) continue
      close()
      this.#open.delete(id)
    }
    for (const id of wanted) {
      if (this.#open.has(id)) continue
      this.#open.set(
        id,
        openDocumentReader(
          this.projectId,
          this.socket,
          id,
          (text) => {
            this.onText(id, text)
          },
          this.delayMs,
        ),
      )
    }
  }

  destroy(): void {
    for (const close of this.#open.values()) close()
    this.#open.clear()
  }
}
