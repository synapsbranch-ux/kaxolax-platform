import type { DiffSegment } from '@kaxolax/contracts'
import * as Y from 'yjs'
import { TEXT_FIELD } from './index.js'

/**
 * Historique : rejeu des mises à jour Yjs journalisées (avec leur auteur) pour reconstruire le
 * texte d'une version et attribuer chaque changement à la mise à jour qui l'a produit.
 *
 * Chaque mise à jour est appliquée l'une après l'autre ; à chaque événement du Y.Text, le delta
 * (conservé, inséré, supprimé) est recalculé élément par élément et chaque élément est attribué
 * par son identifiant Yjs (client, horloge) : à la mise à jour qui l'a créé pour une insertion, à
 * celle dont l'ensemble de suppressions le contient pour une suppression. L'attribution ne dépend
 * donc pas de l'ordre du journal : une mise à jour journalisée avant celle dont elle dépend (deux
 * instances temps réel qui écrivent leurs lots à des moments différents) reste en attente dans
 * Yjs puis s'intègre avec elle, chacune gardant son auteur. Le diff est tenu en
 * « tronçons » : texte d'origine (`equal`), inséré par un auteur (`insert`), ou texte d'origine
 * supprimé par un auteur (`delete`, gardé en place pour l'affichage). Un texte inséré puis
 * supprimé dans la même fenêtre disparaît du diff.
 */

/** Mise à jour Yjs journalisée ; `authorId` nul : origine inconnue (rattrapage, import). */
export interface AttributedUpdate {
  authorId: string | null
  update: Uint8Array
}

export interface ReplayResult {
  /** Texte avant la fenêtre (état de base). */
  previousText: string
  /** Texte après toutes les mises à jour. */
  text: string
  /** État Yjs complet après la fenêtre (base de la version suivante). */
  state: Uint8Array
  /** Diff attribué, tronçons consécutifs de même nature et même auteur fusionnés. */
  segments: DiffSegment[]
}

interface Run {
  op: DiffSegment['op']
  text: string
  authorId: string | null
}

type DeltaOp =
  | { retain: number }
  | { insert: string; authorId: string | null }
  | { delete: number; authorId: string | null }

interface Range {
  start: number
  end: number
  authorId: string | null
}

/**
 * Plages d'horloge (par client Yjs) attribuées à un auteur. La première mise à jour qui couvre une
 * horloge l'emporte (une mise à jour rejournalisée ne change pas l'auteur).
 */
class Ownership {
  private readonly ranges = new Map<number, Range[]>()
  private sorted = true

  add(client: number, start: number, length: number, authorId: string | null): void {
    if (length <= 0) return
    const list = this.ranges.get(client) ?? []
    list.push({ start, end: start + length, authorId })
    this.ranges.set(client, list)
    this.sorted = false
  }

  /** Auteur de l'horloge `clock` du client, ou undefined si aucune mise à jour ne la couvre. */
  find(client: number, clock: number): { authorId: string | null } | undefined {
    if (!this.sorted) {
      // Tri stable : à départ égal, l'ordre du journal est conservé.
      for (const list of this.ranges.values()) list.sort((a, b) => a.start - b.start)
      this.sorted = true
    }
    const list = this.ranges.get(client)
    if (!list) return undefined
    // Plages qui commencent au plus à `clock` ; la première du journal qui la contient.
    let low = 0
    let high = list.length
    while (low < high) {
      const middle = (low + high) >> 1
      if ((list[middle]?.start ?? 0) <= clock) low = middle + 1
      else high = middle
    }
    for (let index = 0; index < low; index++) {
      const range = list[index]
      if (range && clock < range.end) return { authorId: range.authorId }
    }
    return undefined
  }
}

/** Créateurs des éléments et auteurs des suppressions de chaque mise à jour journalisée. */
function ownershipOf(updates: readonly AttributedUpdate[]) {
  const inserted = new Ownership()
  const deleted = new Ownership()
  for (const { authorId, update } of updates) {
    const decoded = Y.decodeUpdate(update)
    for (const struct of decoded.structs) {
      if (struct instanceof Y.Skip) continue
      inserted.add(struct.id.client, struct.id.clock, struct.length, authorId)
    }
    for (const [client, items] of decoded.ds.clients) {
      for (const item of items) deleted.add(client, item.clock, item.len, authorId)
    }
  }
  return { inserted, deleted }
}

/**
 * Delta d'un événement du Y.Text recalculé élément par élément (comme `event.delta`), chaque
 * insertion et suppression attribuée par l'identifiant de l'élément ; `fallback` pour un élément
 * qu'aucune mise à jour journalisée ne couvre (état enregistré appliqué en dernier).
 */
function attributedDelta(
  field: Y.Text,
  event: Y.YTextEvent,
  owners: ReturnType<typeof ownershipOf>,
  fallback: string | null,
): DeltaOp[] {
  const delta: DeltaOp[] = []
  const push = (op: DeltaOp) => {
    const last = delta.at(-1)
    if (last && 'retain' in last && 'retain' in op) last.retain += op.retain
    else if (last && 'insert' in last && 'insert' in op && last.authorId === op.authorId)
      last.insert += op.insert
    else if (last && 'delete' in last && 'delete' in op && last.authorId === op.authorId)
      last.delete += op.delete
    else delta.push(op)
  }
  for (let item = field._start; item !== null; item = item.right) {
    if (!item.countable) continue
    const added = event.adds(item)
    if (item.deleted) {
      // Supprimé avant cette transaction, ou inséré et supprimé dans la même : rien à montrer.
      if (added || !event.deletes(item)) continue
      const owner = owners.deleted.find(item.id.client, item.id.clock)
      push({ delete: item.length, authorId: owner ? owner.authorId : fallback })
    } else if (added) {
      const owner = owners.inserted.find(item.id.client, item.id.clock)
      const text =
        item.content instanceof Y.ContentString
          ? item.content.str
          : // Contenu non textuel (jamais écrit par l'éditeur) : sa longueur, en espaces.
            ' '.repeat(item.length)
      push({ insert: text, authorId: owner ? owner.authorId : fallback })
    } else {
      push({ retain: item.length })
    }
  }
  // Conservation finale inutile.
  const last = delta.at(-1)
  if (last && 'retain' in last) delta.pop()
  return delta
}

/** Applique le delta d'une transaction aux tronçons (positions sur le texte visible). */
function applyDelta(runs: Run[], delta: readonly DeltaOp[]): void {
  let index = 0
  let offset = 0
  const visible = (run: Run) => run.op !== 'delete'
  const skipHidden = () => {
    for (let run = runs[index]; run && !visible(run); run = runs[index]) {
      index++
      offset = 0
    }
  }
  /** Coupe le tronçon courant à `offset` : le curseur se place au début de la seconde partie. */
  const splitHere = () => {
    const run = runs[index]
    if (!run || offset === 0) return
    runs.splice(
      index,
      1,
      { ...run, text: run.text.slice(0, offset) },
      {
        ...run,
        text: run.text.slice(offset),
      },
    )
    index++
    offset = 0
  }

  for (const op of delta) {
    if ('retain' in op) {
      let remaining = op.retain
      while (remaining > 0) {
        skipHidden()
        const run = runs[index]
        if (!run) return
        const take = Math.min(remaining, run.text.length - offset)
        offset += take
        remaining -= take
        if (offset === run.text.length) {
          index++
          offset = 0
        }
      }
    } else if ('insert' in op) {
      if (typeof op.insert !== 'string' || op.insert === '') continue
      // Après le texte supprimé au même endroit : « supprimé puis inséré », comme un diff usuel.
      if (offset === 0) skipHidden()
      splitHere()
      runs.splice(index, 0, { op: 'insert', text: op.insert, authorId: op.authorId })
      index++
    } else {
      let remaining = op.delete
      while (remaining > 0) {
        skipHidden()
        splitHere()
        const run = runs[index]
        if (!run) return
        const take = Math.min(remaining, run.text.length)
        if (take < run.text.length) {
          runs.splice(
            index,
            1,
            { ...run, text: run.text.slice(0, take) },
            {
              ...run,
              text: run.text.slice(take),
            },
          )
        }
        const target = runs[index]
        if (!target) return
        if (target.op === 'insert') {
          // Inséré puis supprimé dans la même fenêtre : rien à montrer.
          runs.splice(index, 1)
        } else {
          target.op = 'delete'
          target.authorId = op.authorId
          index++
        }
        remaining -= take
      }
    }
  }
}

/** Tronçons consécutifs de même nature et même auteur fusionnés ; tronçons vides retirés. */
function mergeRuns(runs: readonly Run[]): DiffSegment[] {
  const segments: DiffSegment[] = []
  for (const run of runs) {
    if (run.text === '') continue
    const previous = segments.at(-1)
    if (previous?.op === run.op && previous.authorId === run.authorId) previous.text += run.text
    else segments.push({ op: run.op, text: run.text, authorId: run.authorId })
  }
  return segments
}

/**
 * Rejoue une fenêtre de mises à jour sur un état de base. `base` : mises à jour déjà intégrées
 * aux versions précédentes (fusionnées), `updates` : la fenêtre, dans l'ordre du journal.
 * `stored` (facultatif) : état enregistré du document, appliqué en dernier sans auteur, pour
 * rattraper ce que le journal aurait manqué (le résultat contient alors tout l'état enregistré).
 */
export function replayWithAttribution(
  base: readonly Uint8Array[],
  updates: readonly AttributedUpdate[],
  stored?: Uint8Array | null,
): ReplayResult {
  const doc = new Y.Doc()
  try {
    if (base.length > 0) Y.applyUpdate(doc, Y.mergeUpdates([...base]))
    const field = doc.getText(TEXT_FIELD)
    const previousText = field.toJSON()
    const runs: Run[] =
      previousText === '' ? [] : [{ op: 'equal', text: previousText, authorId: null }]
    const owners = ownershipOf(updates)
    let author: string | null = null
    const observer = (event: Y.YTextEvent) => {
      applyDelta(runs, attributedDelta(field, event, owners, author))
    }
    field.observe(observer)
    // Chaque mise à jour dans sa propre transaction ; une mise à jour en attente de ses
    // dépendances s'intègre plus tard, attribuée par les identifiants de ses éléments.
    for (const update of updates) {
      author = update.authorId
      Y.applyUpdate(doc, update.update)
    }
    if (stored && stored.length > 0) {
      author = null
      Y.applyUpdate(doc, stored)
    }
    field.unobserve(observer)
    return {
      previousText,
      text: field.toJSON(),
      state: Y.encodeStateAsUpdate(doc),
      segments: mergeRuns(runs),
    }
  } finally {
    doc.destroy()
  }
}

/** Texte d'un diff tel qu'il est après la fenêtre (segments `equal` et `insert`). */
export function textAfter(segments: readonly DiffSegment[]): string {
  return segments
    .filter((segment) => segment.op !== 'delete')
    .map((segment) => segment.text)
    .join('')
}

/** Texte d'un diff tel qu'il était avant la fenêtre (segments `equal` et `delete`). */
export function textBefore(segments: readonly DiffSegment[]): string {
  return segments
    .filter((segment) => segment.op !== 'insert')
    .map((segment) => segment.text)
    .join('')
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

/**
 * Plus petite plage à remplacer pour passer de `current` à `next` : préfixe et suffixe communs
 * conservés (sans couper une paire de substitution UTF-16). Null si les textes sont égaux.
 */
export function minimalReplacement(
  current: string,
  next: string,
): { from: number; deleteCount: number; insert: string } | null {
  if (current === next) return null
  let prefix = 0
  const max = Math.min(current.length, next.length)
  while (prefix < max && current.charCodeAt(prefix) === next.charCodeAt(prefix)) prefix++
  if (prefix > 0 && isHighSurrogate(current.charCodeAt(prefix - 1))) prefix--
  let suffix = 0
  while (
    suffix < max - prefix &&
    current.charCodeAt(current.length - 1 - suffix) === next.charCodeAt(next.length - 1 - suffix)
  ) {
    suffix++
  }
  if (suffix > 0 && isLowSurrogate(current.charCodeAt(current.length - suffix))) suffix--
  return {
    from: prefix,
    deleteCount: current.length - prefix - suffix,
    insert: next.slice(prefix, next.length - suffix),
  }
}

/**
 * Remplace le texte d'un Y.Text par `next` en une modification minimale (les commentaires
 * ancrés hors de la plage modifiée restent attachés). À appeler dans une transaction. Renvoie
 * faux si le texte était déjà `next`.
 */
export function replaceTextMinimally(field: Y.Text, next: string): boolean {
  const change = minimalReplacement(field.toJSON(), next)
  if (!change) return false
  if (change.deleteCount > 0) field.delete(change.from, change.deleteCount)
  if (change.insert !== '') field.insert(change.from, change.insert)
  return true
}

/**
 * Texte à ajouter à la fin de `current` pour y mettre le bloc `block` (paragraphe séparé par une
 * ligne vide, fin de ligne finale) ; null s'il y est déjà (ajout idempotent). Ne dépend que de la
 * fin du texte : une frappe ailleurs dans le document n'est pas touchée.
 */
export function blockAppendix(current: string, block: string): string | null {
  const trimmed = block.trim()
  if (trimmed === '' || current.includes(trimmed)) return null
  const separator =
    current.trimEnd() === ''
      ? ''
      : current.endsWith('\n\n')
        ? ''
        : current.endsWith('\n')
          ? '\n'
          : '\n\n'
  // Texte vide ou fait seulement d'espaces : le bloc s'y ajoute tel quel.
  return `${separator}${trimmed}\n`
}

/**
 * Ajoute un bloc à la fin d'un Y.Text (insertion seule, aucune suppression : les modifications
 * concurrentes sont gardées). À appeler dans une transaction. Faux si le bloc y était déjà.
 */
export function appendTextBlock(field: Y.Text, block: string): boolean {
  const appendix = blockAppendix(field.toJSON(), block)
  if (appendix === null) return false
  field.insert(field.length, appendix)
  return true
}

/**
 * Remplace le texte d'un état Yjs persisté par une modification minimale. Renvoie le nouvel état
 * et la mise à jour produite (null si rien n'a changé), pour le journal.
 */
export function replaceStateText(
  state: Uint8Array | null,
  next: string,
): { state: Uint8Array; update: Uint8Array | null } {
  const doc = new Y.Doc()
  try {
    if (state !== null && state.length > 0) Y.applyUpdate(doc, state)
    let update: Uint8Array | null = null
    doc.on('update', (produced: Uint8Array) => {
      update = update ? Y.mergeUpdates([update, produced]) : produced
    })
    doc.transact(() => {
      replaceTextMinimally(doc.getText(TEXT_FIELD), next)
    })
    return { state: Y.encodeStateAsUpdate(doc), update }
  } finally {
    doc.destroy()
  }
}
