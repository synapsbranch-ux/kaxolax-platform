import { isolateHistory } from '@codemirror/commands'
import type { ChangeSpec, Text } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { ACTION_USER_EVENT } from './actions/edit.js'
import { findPreamble, type LoadedPackage, loadedPackages } from './packages.js'
import { skipSpaces } from './scan.js'
import { maskCode } from './writing/mask.js'

/** Package du projet, tel que le gestionnaire de packages l'affiche. */
export interface ProjectPackage {
  name: string
  /** Options de la commande (partagées si elle charge plusieurs packages). */
  options: string[]
  command: LoadedPackage['command']
  /** La commande charge aussi d'autres packages (`\usepackage{a,b}`). */
  shared: boolean
  /** Ligne de la commande (1 = première). */
  line: number
  from: number
  to: number
}

function textOf(doc: Text | string): string {
  return typeof doc === 'string' ? doc : doc.toString()
}

function lineOf(text: string, offset: number): number {
  let line = 1
  for (let i = text.indexOf('\n'); i !== -1 && i < offset; i = text.indexOf('\n', i + 1)) line++
  return line
}

/**
 * Packages chargés dans le préambule (`\usepackage` et `\RequirePackage`, plusieurs par ligne ou
 * par commande, options comprises), dans l'ordre ; un package chargé deux fois apparaît deux fois.
 */
export function projectPackages(doc: Text | string): ProjectPackage[] {
  const text = textOf(doc)
  return loadedPackages(text).flatMap((loaded) =>
    loaded.names.map((name) => ({
      name,
      options: loaded.options,
      command: loaded.command,
      shared: loaded.names.length > 1,
      line: lineOf(text, loaded.from),
      from: loaded.from,
      to: loaded.to,
    })),
  )
}

/** Ce que le retrait d'un package demande au document. */
export type RemovePackagePlan =
  | {
      status: 'remove'
      /** Modifications, en positions du document d'origine, triées et disjointes. */
      changes: { from: number; to: number; insert: string }[]
      /** Des options restent sur une commande partagée avec d'autres packages. */
      sharedOptions: boolean
    }
  | { status: 'absent' }
  | { status: 'no-preamble' }

/** Accolade ouvrante de la liste des packages d'une commande. */
function namesOpen(text: string, loaded: LoadedPackage): number {
  const after = loaded.optionsTo ?? loaded.from + loaded.command.length + 1
  return skipSpaces(text, after)
}

/** Éléments d'une liste `{a, b}` : début du segment (après la virgule), début et fin du nom. */
function listItems(
  text: string,
  open: number,
  close: number,
): { segment: number; from: number; to: number; name: string }[] {
  const items: { segment: number; from: number; to: number; name: string }[] = []
  let segment = open + 1
  let depth = 0
  for (let i = open + 1; i <= close; i++) {
    const char = i === close ? ',' : text[i]
    if (char === '{') depth++
    else if (char === '}') depth--
    else if (char === ',' && depth === 0) {
      const raw = text.slice(segment, i)
      const name = raw.trim()
      if (name !== '') {
        const from = segment + raw.indexOf(name)
        items.push({ segment, from, to: from + name.length, name })
      }
      segment = i + 1
    }
  }
  return items
}

/** Suppression d'une commande seule : sa ligne entière si elle n'y côtoie que des blancs ou un commentaire. */
function removeCommand(text: string, loaded: LoadedPackage): { from: number; to: number } {
  const lineStart = text.lastIndexOf('\n', loaded.from - 1) + 1
  const newline = text.indexOf('\n', loaded.to)
  const lineEnd = newline === -1 ? text.length : newline
  const before = text.slice(lineStart, loaded.from)
  const after = text.slice(loaded.to, lineEnd)
  if (/^\s*$/.test(before) && /^\s*(%.*)?$/.test(after)) {
    if (newline !== -1) return { from: lineStart, to: newline + 1 }
    return { from: Math.max(0, lineStart - 1), to: lineEnd }
  }
  // Autre code sur la ligne : la commande et les espaces qui la suivent.
  let to = loaded.to
  while (text[to] === ' ' || text[to] === '\t') to++
  return { from: loaded.from, to }
}

/**
 * Retrait d'un package du préambule : la commande entière (et sa ligne) s'il est seul, avec ses
 * options ; sinon son nom seul dans la liste, mise en forme conservée. Toutes les commandes qui le
 * chargent sont traitées.
 */
export function planRemovePackage(doc: Text | string, name: string): RemovePackagePlan {
  const text = textOf(doc)
  if (!findPreamble(text)) return { status: 'no-preamble' }
  const changes: { from: number; to: number; insert: string }[] = []
  let sharedOptions = false
  let code: string | undefined
  for (const loaded of loadedPackages(text)) {
    if (!loaded.names.includes(name)) continue
    if (loaded.names.every((loadedName) => loadedName === name)) {
      changes.push({ ...removeCommand(text, loaded), insert: '' })
      continue
    }
    if (loaded.options.length > 0) sharedOptions = true
    // Liste lue dans le code masqué (commentaires en espaces, positions identiques).
    code ??= maskCode(text).code
    const items = listItems(code, namesOpen(code, loaded), loaded.to - 1)
    // Retrait de la fin vers le début : les positions des éléments restent valables.
    const removed = items.filter((item) => item.name === name)
    for (const item of removed.reverse()) {
      const index = items.indexOf(item)
      const next = items[index + 1]
      if (index === 0 && next) {
        // Premier élément : jusqu'au nom suivant (blancs compris).
        changes.push({ from: item.from, to: next.from, insert: '' })
      } else if (next) {
        changes.push({ from: item.segment, to: next.segment, insert: '' })
      } else {
        // Dernier élément : depuis la virgule qui le précède.
        changes.push({ from: item.segment - 1, to: item.to, insert: '' })
      }
    }
  }
  if (changes.length === 0) return { status: 'absent' }
  changes.sort((a, b) => a.from - b.from)
  // Plages qui se touchent ou se chevauchent (éléments voisins retirés) : fusionnées.
  const merged: { from: number; to: number; insert: string }[] = []
  for (const change of changes) {
    const last = merged.at(-1)
    if (last && change.from <= last.to) last.to = Math.max(last.to, change.to)
    else merged.push({ ...change })
  }
  return { status: 'remove', changes: merged, sharedOptions }
}

/** Ce que le changement des options d'un package demande au document. */
export type PackageOptionsPlan =
  | { status: 'update'; change: { from: number; to: number; insert: string } }
  | { status: 'unchanged' }
  /** Commande partagée avec d'autres packages : options à régler à la main. */
  | { status: 'shared' }
  | { status: 'absent' }
  | { status: 'no-preamble' }

/**
 * Remplace les options d'un package chargé seul (`[]` retire les crochets). `at` : début de la
 * commande visée (`ProjectPackage.from`) quand le package est chargé plusieurs fois ; sans `at`,
 * ou si aucune commande ne commence plus là (document modifié), la seule commande qui charge
 * `name` (`absent` s'il y en a plusieurs : rien n'est modifié au hasard).
 */
export function planPackageOptions(
  doc: Text | string,
  name: string,
  options: readonly string[],
  at?: number,
): PackageOptionsPlan {
  const text = textOf(doc)
  if (!findPreamble(text)) return { status: 'no-preamble' }
  const candidates = loadedPackages(text).filter((candidate) => candidate.names.includes(name))
  const loaded =
    candidates.find((candidate) => candidate.from === at) ??
    (at === undefined || candidates.length === 1 ? candidates[0] : undefined)
  if (!loaded) return { status: 'absent' }
  if (loaded.names.length > 1) return { status: 'shared' }
  const cleaned = options.map((option) => option.trim()).filter((option) => option !== '')
  if (
    cleaned.length === loaded.options.length &&
    cleaned.every((option, i) => option === loaded.options[i])
  ) {
    return { status: 'unchanged' }
  }
  const insert = cleaned.length > 0 ? `[${cleaned.join(',')}]` : ''
  const from = loaded.optionsFrom ?? loaded.from + loaded.command.length + 1
  const to = loaded.optionsTo ?? from
  return { status: 'update', change: { from, to, insert } }
}

function dispatchChanges(view: EditorView, changes: ChangeSpec): void {
  view.dispatch({
    changes,
    userEvent: ACTION_USER_EVENT,
    annotations: isolateHistory.of('full'),
  })
}

/** Retire un package du préambule (une étape d'annulation). */
export function removePackage(view: EditorView, name: string): RemovePackagePlan['status'] {
  const plan = planRemovePackage(view.state.doc, name)
  if (plan.status === 'remove' && !view.state.readOnly) dispatchChanges(view, plan.changes)
  return plan.status
}

/**
 * Change les options d'un package chargé seul (une étape d'annulation) ; `at` : début de la
 * commande visée (voir `planPackageOptions`).
 */
export function setPackageOptions(
  view: EditorView,
  name: string,
  options: readonly string[],
  at?: number,
): PackageOptionsPlan['status'] {
  const plan = planPackageOptions(view.state.doc, name, options, at)
  if (plan.status === 'update' && !view.state.readOnly) dispatchChanges(view, plan.change)
  return plan.status
}
