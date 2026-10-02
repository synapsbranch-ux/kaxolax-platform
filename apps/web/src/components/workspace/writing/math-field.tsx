'use client'

import { sanitizeForMathLive } from '@kaxolax/editor'
import type * as MathLive from 'mathlive'
import type { MathfieldElement } from 'mathlive'
import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react'
// Polices KaTeX de MathLive, servies par Next.js depuis /_next/static (aucun CDN). Ce module n'est
// chargé qu'avec l'éditeur de formules (import dynamique), donc hors du bundle de la page projet.
import 'mathlive/fonts.css'
import 'mathlive/static.css'
import './math-field.css'

type MathLiveModule = typeof MathLive

let mathlivePromise: Promise<MathLiveModule> | null = null

/**
 * Charge MathLive à la demande, côté navigateur seulement (jamais au rendu serveur) : polices
 * fournies par la feuille de style ci-dessus (MathLive ne les charge pas lui-même), sons coupés,
 * pas de moteur de calcul, aucun lien ouvert.
 */
export function loadMathLive(): Promise<MathLiveModule> {
  mathlivePromise ??= import('mathlive').then((mathlive) => {
    const { MathfieldElement } = mathlive
    MathfieldElement.fontsDirectory = null
    MathfieldElement.soundsDirectory = null
    MathfieldElement.keypressSound = null
    MathfieldElement.plonkSound = null
    MathfieldElement.computeEngine = null
    // Liens `\href` : jamais ouverts depuis l'éditeur (pas de `window.open` vers une adresse
    // écrite par un collaborateur ; les valeurs chargées sont de plus filtrées).
    MathfieldElement.openUrl = () => undefined
    return mathlive
  })
  // Un échec (réseau) ne reste pas en cache : nouvel essai à la prochaine ouverture.
  mathlivePromise.catch(() => {
    mathlivePromise = null
  })
  return mathlivePromise
}

/** Commandes de l'éditeur visuel exposées à la boîte de dialogue. */
export interface MathFieldHandle {
  /** Insère un modèle MathLive (`#?` : case à remplir, `#@` : sélection) et rend le focus. */
  insert: (template: string) => void
  focus: () => void
}

export type MathFieldStatus = 'loading' | 'ready' | 'error'

/**
 * Champ `<math-field>` de MathLive, créé après le chargement de la bibliothèque. `value` est le
 * LaTeX courant : une valeur venue d'ailleurs (texte brut, bibliothèque) remplace le contenu du
 * champ ; chaque saisie dans le champ remonte par `onChange`.
 */
export function MathField({
  value,
  onChange,
  onStatus,
  onSubmit,
  label,
  ref,
}: {
  value: string
  onChange: (latex: string) => void
  onStatus: (status: MathFieldStatus) => void
  /** Ctrl+Entrée dans le champ. */
  onSubmit: () => void
  label: string
  ref?: Ref<MathFieldHandle>
}) {
  const container = useRef<HTMLDivElement>(null)
  const field = useRef<MathfieldElement | null>(null)
  const callbacks = useRef({ onChange, onStatus, onSubmit })
  // Valeur affichée dans le champ : évite de réécrire le champ avec sa propre valeur.
  const shown = useRef(value)
  const initial = useRef(value)
  const [ready, setReady] = useState(false)

  useEffect(() => {
    callbacks.current = { onChange, onStatus, onSubmit }
  })

  useEffect(() => {
    let cancelled = false
    let element: MathfieldElement | null = null
    callbacks.current.onStatus('loading')
    loadMathLive().then(
      ({ MathfieldElement }) => {
        if (cancelled || container.current === null) return
        element = new MathfieldElement()
        element.setAttribute('aria-label', label)
        element.mathVirtualKeyboardPolicy = 'manual'
        // Suggestions de commandes : fenêtre hors de la boîte de dialogue, donc désactivée.
        element.popoverPolicy = 'off'
        element.menuItems = []
        element.smartFence = true
        element.className = 'kx-math-field'
        // Extensions HTML (`\htmlStyle`, `\href`…) retirées : le LaTeX vient d'un document partagé.
        element.value = sanitizeForMathLive(initial.current)
        element.addEventListener('input', () => {
          if (element === null) return
          const latex = element.getValue('latex')
          shown.current = latex
          callbacks.current.onChange(latex)
        })
        element.addEventListener('keydown', (event) => {
          if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault()
            event.stopPropagation()
            callbacks.current.onSubmit()
          }
        })
        container.current.appendChild(element)
        field.current = element
        setReady(true)
        callbacks.current.onStatus('ready')
        // Après l'affichage du champ (masqué pendant le chargement).
        requestAnimationFrame(() => {
          element?.focus()
        })
      },
      () => {
        if (!cancelled) callbacks.current.onStatus('error')
      },
    )
    return () => {
      cancelled = true
      element?.remove()
      field.current = null
    }
  }, [label])

  // Valeur modifiée hors du champ (texte brut, bibliothèque) : recopiée dans le champ.
  useEffect(() => {
    const element = field.current
    if (!ready || element === null || value === shown.current) return
    shown.current = value
    element.setValue(sanitizeForMathLive(value), { silenceNotifications: true })
  }, [value, ready])

  useImperativeHandle(
    ref,
    () => ({
      insert: (template) => {
        const element = field.current
        if (element === null) return
        element.insert(template, {
          insertionMode: 'replaceSelection',
          selectionMode: 'placeholder',
          focus: true,
        })
        const latex = element.getValue('latex')
        shown.current = latex
        callbacks.current.onChange(latex)
      },
      focus: () => {
        field.current?.focus()
      },
    }),
    [],
  )

  return <div ref={container} className="min-h-14" />
}
