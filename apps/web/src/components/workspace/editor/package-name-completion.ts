import { startCompletion } from '@codemirror/autocomplete'
import type { Extension } from '@codemirror/state'
import { type EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view'
import { argumentContext, type ProjectIndex } from '@kaxolax/editor'
import { api } from '@/lib/api'
import {
  normalizeQuery,
  PACKAGE_NAME_PAGE,
  type PackageNameCache,
  packageNamesOf,
} from '@/lib/package-names'

/** Pause de frappe avant d'interroger l'index TeX Live. */
const QUERY_DELAY_MS = 200

/** Début de nom de package en cours de saisie après `\usepackage{` (null ailleurs). */
function packagePrefix(view: EditorView): string | null {
  const { state } = view
  const selection = state.selection.main
  if (!selection.empty) return null
  const argument = argumentContext(state, selection.head)
  if (argument?.command !== 'usepackage' && argument?.command !== 'RequirePackage') return null
  return normalizeQuery(argument.text)
}

/**
 * Complète `\usepackage{` avec tout l'index TeX Live de l'API : pendant la frappe, les packages
 * qui correspondent au début saisi sont demandés (`GET /texlive/packages?q=`), ajoutés à l'index
 * du projet (`setPackageNames`), puis la liste de propositions est rouverte. Les réponses sont
 * mémorisées pour la session (`PackageNameCache`) ; une erreur réseau laisse les propositions
 * embarquées.
 */
export function texlivePackageNames(index: ProjectIndex, cache: PackageNameCache): Extension {
  return ViewPlugin.fromClass(
    class {
      timer: ReturnType<typeof setTimeout> | null = null
      destroyed = false

      constructor(readonly view: EditorView) {}

      update(update: ViewUpdate) {
        if (!update.docChanged) return
        const prefix = packagePrefix(update.view)
        if (prefix === null || !cache.shouldQuery(prefix)) return
        if (this.timer !== null) clearTimeout(this.timer)
        this.timer = setTimeout(() => {
          this.timer = null
          void this.query(prefix)
        }, QUERY_DELAY_MS)
      }

      async query(prefix: string) {
        if (!cache.shouldQuery(prefix)) return
        let found: { names: string[]; complete: boolean }
        try {
          found = packageNamesOf(
            await api.texlivePackages({ q: prefix, perPage: PACKAGE_NAME_PAGE }),
          )
        } catch {
          return
        }
        if (!cache.record(prefix, found.names, found.complete)) return
        index.setPackageNames(cache.list())
        // Toujours dans l'argument de `\usepackage` : propositions rouvertes avec les nouveaux noms.
        const current = this.destroyed ? null : packagePrefix(this.view)
        if (current?.startsWith(prefix)) startCompletion(this.view)
      }

      destroy() {
        this.destroyed = true
        if (this.timer !== null) clearTimeout(this.timer)
      }
    },
  )
}
