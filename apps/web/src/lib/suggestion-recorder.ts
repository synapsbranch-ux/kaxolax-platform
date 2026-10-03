import {
  createCommentAnchor,
  type PendingSuggestion,
  pendingSuggestionInput,
  recordSuggestionEdit,
  resolveSuggestion,
} from '@kaxolax/collab'
import type { CreateSuggestionInput, Suggestion, UpdateSuggestionInput } from '@kaxolax/contracts'
import { type InterceptedEdit, suggestionViewEdit } from '@kaxolax/editor'
import * as Y from 'yjs'

/** Appels de l'API utilisés par l'enregistreur (injectés : faux dans les tests). */
export interface SuggestionTransport {
  create: (input: CreateSuggestionInput) => Promise<Suggestion>
  update: (id: string, input: UpdateSuggestionInput) => Promise<Suggestion>
  remove: (id: string) => Promise<void>
}

export interface SuggestionRecorderHooks {
  /** Suggestion créée ou modifiée par l'API. */
  onSaved: (suggestion: Suggestion) => void
  /** Suggestion retirée (frappes effacées, Ctrl+Z). */
  onRemoved: (id: string) => void
  /** Échec d'un envoi : la suggestion en cours est abandonnée. */
  onError: (error: unknown) => void
  /** Frappe refusée : texte trop long pour une seule suggestion. */
  onRejected: () => void
  /** Brouillon changé (affichage à mettre à jour). */
  onChange: () => void
}

/** Brouillon affiché : suggestion pas encore enregistrée telle quelle, et son identifiant. */
export interface SuggestionDraft {
  pending: PendingSuggestion
  /** Identifiant de la suggestion enregistrée (masquer sa version reçue de l'API). */
  id: string | null
}

/** Écart maximal (caractères) comblé pour prolonger la suggestion en cours (voir `widen`). */
const MAX_WIDEN_GAP = 200

/** Délai de regroupement des frappes avant l'envoi de la suggestion en cours. */
export const SUGGESTION_SAVE_DELAY_MS = 400

/**
 * Enregistreur du mode Suggérer pour un document ouvert : chaque frappe interceptée par
 * l'éditeur (`suggestionTracking` de @kaxolax/editor) est convertie en coordonnées de la vue
 * (`suggestionViewEdit`), fusionnée avec la suggestion en cours (`recordSuggestionEdit` de
 * @kaxolax/collab), puis envoyée à l'API après une courte pause : création (`POST`), puis
 * modifications (`PATCH`), ou retrait (`DELETE`) si les frappes s'annulent.
 *
 * Les envois passent par une file (un seul à la fois, dans l'ordre) : la création d'une
 * suggestion se termine avant sa modification ; chaque brouillon a une clé locale qui garde son
 * identifiant d'API pendant les fusions. Le texte partagé n'est jamais modifié.
 */
export class SuggestionRecorder {
  private current: PendingSuggestion | null = null
  private currentKey = 0
  private nextKey = 1
  /** Dernier état de chaque brouillon pas encore enregistré tel quel (null : annulé). */
  private readonly latest = new Map<number, PendingSuggestion | null>()
  private readonly ids = new Map<number, string>()
  private readonly sent = new Map<number, PendingSuggestion | null>()
  /** Suggestions décidées ou retirées ailleurs (`discard`) : plus rien à leur envoyer. */
  private readonly discarded = new Set<string>()
  private queue: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private disposed = false
  /** Curseur après la dernière frappe (position relative : suit les modifications distantes). */
  private cursor: Y.RelativePosition | null = null

  constructor(
    private readonly text: Y.Text,
    private readonly documentId: string,
    private readonly authorId: string,
    private readonly transport: SuggestionTransport,
    private readonly hooks: SuggestionRecorderHooks,
    private readonly delayMs = SUGGESTION_SAVE_DELAY_MS,
  ) {}

  /**
   * Brouillons affichés : la suggestion en cours et celles terminées dont l'envoi n'est pas fini
   * (leur version reçue de l'API, plus ancienne, est masquée).
   */
  drafts(): SuggestionDraft[] {
    const drafts: SuggestionDraft[] = []
    for (const [key, pending] of this.latest) {
      if (pending !== null) drafts.push({ pending, id: this.ids.get(key) ?? null })
    }
    return drafts
  }

  /**
   * Frappe interceptée par l'éditeur, en coordonnées du document. Renvoie la position du curseur
   * à placer dans l'éditeur (le texte proposé, affiché en widget, peut avoir changé de forme), ou
   * null si la frappe est ignorée.
   */
  edit(edit: InterceptedEdit): number | null {
    if (this.disposed) return null
    let current = this.current
    let resolved = current === null ? null : resolveSuggestion(this.text, current)
    if (current !== null && resolved?.status === 'open') {
      const widened = this.widen(current, resolved, edit)
      if (widened !== null) {
        current = widened
        resolved = resolveSuggestion(this.text, widened)
      }
    }
    const draft =
      current !== null && resolved?.status === 'open'
        ? { from: resolved.from, to: resolved.to, proposedLength: current.proposedText.length }
        : null
    const viewEdit = suggestionViewEdit(edit, draft)
    let result
    try {
      result = recordSuggestionEdit(this.text, current, this.authorId, viewEdit)
    } catch {
      // Position hors du texte (document changé entre-temps) : frappe ignorée.
      return null
    }
    if (result.rejected) {
      this.hooks.onRejected()
      return null
    }
    const started = result.finished !== null || (this.current === null && result.pending !== null)
    if (started) {
      // La suggestion précédente est terminée : envoyée telle quelle, une nouvelle commence.
      if (this.current !== null) this.saveNow(this.currentKey)
      this.currentKey = this.nextKey++
    }
    this.current = result.pending
    this.latest.set(this.currentKey, result.pending)
    if (result.pending === null) this.saveNow(this.currentKey)
    else this.schedule()
    // Nouvelle suggestion : la frappe était hors de la suggestion en cours, le curseur de
    // l'éditeur est le bon. Sinon, la vue (texte avec la suggestion appliquée) a changé.
    const cursor = started
      ? edit.cursor
      : this.baseCursor(viewEdit.from + viewEdit.insert.length, edit.cursor)
    this.cursor = Y.createRelativePositionFromTypeIndex(this.text, cursor)
    this.hooks.onChange()
    return cursor
  }

  /**
   * Position de la vue (texte avec la suggestion en cours appliquée) ramenée au document : dans
   * le texte proposé (widget), juste après lui. Pour une suppression seule, `hint` (curseur de
   * l'éditeur) dit s'il reste avant ou après le texte barré.
   */
  private baseCursor(view: number, hint: number): number {
    const resolved = this.current === null ? null : resolveSuggestion(this.text, this.current)
    if (this.current === null || resolved?.status !== 'open') return view
    const length = this.current.proposedText.length
    if (view < resolved.from) return view
    if (length === 0 && view === resolved.from) {
      return hint <= resolved.from ? resolved.from : resolved.to
    }
    if (view < resolved.from + length) return resolved.to
    return view - length + (resolved.to - resolved.from)
  }

  /**
   * Frappe qui poursuit la saisie (au curseur laissé par la frappe précédente) mais séparée de
   * la suggestion en cours par du texte inchangé : la suggestion ne garde que la différence
   * minimale (préfixe et suffixe communs retirés), « world » → « word » ne barre que « l » et le
   * curseur reste après « d ». La suggestion est alors élargie jusqu'à la frappe, avec le même
   * texte des deux côtés (sens inchangé), pour que la frappe la prolonge au lieu d'en commencer
   * une autre. Null : rien à élargir.
   */
  private widen(
    current: PendingSuggestion,
    range: { from: number; to: number },
    edit: InterceptedEdit,
  ): PendingSuggestion | null {
    const cursor =
      this.cursor === null || this.text.doc === null
        ? null
        : Y.createAbsolutePositionFromRelativePosition(this.cursor, this.text.doc)
    if (cursor?.type !== this.text) return null
    if (edit.from !== cursor.index && edit.to !== cursor.index) return null
    const base = this.text.toJSON()
    let from = range.from
    let to = range.to
    let before = ''
    let after = ''
    if (edit.from > range.to && edit.from - range.to <= MAX_WIDEN_GAP) {
      after = base.slice(range.to, edit.from)
      to = edit.from
    } else if (edit.to < range.from && range.from - edit.to <= MAX_WIDEN_GAP) {
      before = base.slice(edit.to, range.from)
      from = edit.to
    } else {
      return null
    }
    return {
      ...current,
      kind: 'replace',
      anchor: createCommentAnchor(this.text, from, to),
      originalText: before + current.originalText + after,
      proposedText: before + current.proposedText + after,
    }
  }

  /** Ctrl+Z en mode Suggérer : la suggestion en cours est retirée. Faux s'il n'y en a pas. */
  cancel(): boolean {
    if (this.current === null) return false
    this.current = null
    this.latest.set(this.currentKey, null)
    this.saveNow(this.currentKey)
    this.hooks.onChange()
    return true
  }

  /**
   * Suggestion décidée (acceptée, refusée, obsolète) ou retirée hors de l'enregistreur (panneau
   * Review, autre onglet, autre membre) : son brouillon est oublié sans rien envoyer, et la
   * prochaine frappe commence une nouvelle suggestion. Un envoi déjà parti pour elle échoue sans
   * message. Faux si aucun brouillon ne porte cet identifiant.
   */
  discard(id: string): boolean {
    this.discarded.add(id)
    let found = false
    for (const [key, saved] of [...this.ids]) {
      if (saved !== id) continue
      found = true
      if (key === this.currentKey) {
        this.current = null
        if (this.timer !== null) {
          clearTimeout(this.timer)
          this.timer = null
        }
      }
      this.forget(key)
    }
    return found
  }

  /** Termine la suggestion en cours (changement de mode) et attend la fin des envois. */
  async flush(): Promise<void> {
    if (this.current !== null) {
      this.saveNow(this.currentKey)
      this.current = null
      // Plus de suggestion en cours : le brouillon est oublié une fois enregistré.
      this.currentKey = this.nextKey++
      this.hooks.onChange()
    }
    await this.queue
  }

  /** Document refermé : la suggestion en cours est envoyée, plus aucune frappe acceptée. */
  dispose(): void {
    if (this.disposed) return
    void this.flush()
    this.disposed = true
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    const key = this.currentKey
    this.timer = setTimeout(() => {
      this.timer = null
      this.enqueue(key)
    }, this.delayMs)
  }

  private saveNow(key: number): void {
    if (this.timer !== null && key === this.currentKey) {
      clearTimeout(this.timer)
      this.timer = null
    }
    this.enqueue(key)
  }

  private enqueue(key: number): void {
    this.queue = this.queue.then(() => this.save(key))
  }

  private async save(key: number): Promise<void> {
    if (!this.latest.has(key)) return
    const pending = this.latest.get(key) ?? null
    if (this.sent.has(key) && this.sent.get(key) === pending) {
      if (key !== this.currentKey) this.forget(key)
      return
    }
    const id = this.ids.get(key)
    try {
      if (pending === null) {
        if (id !== undefined) {
          await this.transport.remove(id)
          this.hooks.onRemoved(id)
        }
      } else if (id !== undefined) {
        this.hooks.onSaved(await this.transport.update(id, pendingSuggestionInput(pending)))
      } else {
        const saved = await this.transport.create({
          documentId: this.documentId,
          ...pendingSuggestionInput(pending),
        })
        this.ids.set(key, saved.id)
        this.hooks.onSaved(saved)
      }
      // Oublié pendant l'envoi (`discard`) : plus rien à suivre.
      if (!this.latest.has(key)) return
      this.sent.set(key, pending)
    } catch (error) {
      // Oubliée pendant l'envoi (`discard`) : l'échec (409, 404) est attendu, sans message.
      if (id !== undefined && this.discarded.has(id)) return
      // Décidée entre-temps, limite de débit, réseau : ce brouillon est abandonné.
      this.forget(key)
      if (key === this.currentKey) this.current = null
      this.hooks.onChange()
      this.hooks.onError(error)
      return
    }
    // Brouillon terminé et enregistré tel quel : plus rien à suivre.
    if (key !== this.currentKey && this.latest.get(key) === pending) this.forget(key)
    else if (pending === null) this.forget(key)
  }

  private forget(key: number): void {
    this.latest.delete(key)
    this.sent.delete(key)
    this.ids.delete(key)
    this.hooks.onChange()
  }
}

/**
 * Suggestions décidées ou retirées (événements du projet, actions du panneau Review) : les
 * éditeurs ouverts oublient le brouillon correspondant (`SuggestionRecorder.discard`).
 */
type GoneListener = (ids: readonly string[]) => void
const goneListeners = new Set<GoneListener>()

export const suggestionsGone = {
  publish(ids: readonly string[]): void {
    if (ids.length === 0) return
    for (const listener of [...goneListeners]) listener(ids)
  },
  subscribe(listener: GoneListener): () => void {
    goneListeners.add(listener)
    return () => {
      goneListeners.delete(listener)
    }
  },
}
