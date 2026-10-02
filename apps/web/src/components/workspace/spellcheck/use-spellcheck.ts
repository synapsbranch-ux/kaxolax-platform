'use client'

import type { SpellcheckLanguage } from '@kaxolax/contracts'
import {
  addPersonalWord,
  SpellcheckClient,
  type SpellcheckConfig,
  type SpellcheckMenu,
} from '@kaxolax/editor'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { spellcheckErrorMessage } from '@/lib/editor-settings'

/**
 * Correcteur orthographique de la page projet : worker Hunspell créé seulement quand le correcteur
 * est activé et qu'un document est ouvert (aucun téléchargement sinon), puis gardé pour la
 * session (les résultats mémorisés survivent aux changements d'onglet et aux désactivations).
 * Renvoie la configuration à passer à l'éditeur (stable tant que la langue ne change pas), le
 * menu de suggestions ouvert et la dernière erreur de la langue courante.
 */
export function useSpellcheck({
  enabled,
  language,
  dictionary,
  onDictionaryChange,
}: {
  /** Préférence `editor.spellcheck` et document texte ouvert. */
  enabled: boolean
  /** Langue du projet. */
  language: SpellcheckLanguage
  /** Dictionnaire personnel (préférences). */
  dictionary: readonly string[]
  /** Enregistre le dictionnaire personnel modifié (préférences, tous appareils). */
  onDictionaryChange: (words: string[]) => void
}): {
  config: SpellcheckConfig | null
  menu: SpellcheckMenu | null
  closeMenu: () => void
  error: string | null
} {
  const [client, setClient] = useState<SpellcheckClient | null>(null)
  const [menu, setMenu] = useState<SpellcheckMenu | null>(null)
  const [error, setError] = useState<{ language: SpellcheckLanguage; message: string } | null>(null)
  const latest = useRef({ dictionary, onDictionaryChange, language })
  useEffect(() => {
    latest.current = { dictionary, onDictionaryChange, language }
  })

  // Worker créé à la première activation (dictionnaire personnel transmis d'abord), arrêté avec
  // la page.
  const wanted = enabled || client !== null
  useEffect(() => {
    if (!wanted) return
    const worker = new Worker(new URL('../../../workers/spellcheck.worker.ts', import.meta.url), {
      type: 'module',
      name: 'spellcheck',
    })
    const created = new SpellcheckClient(worker)
    let active = true
    created.setPersonalDictionary(latest.current.dictionary).then(
      () => {
        if (active) setClient(created)
      },
      (caught: unknown) => {
        if (!active) return
        // Le correcteur reste utilisable sans le dictionnaire personnel.
        setClient(created)
        setError({ language: latest.current.language, message: spellcheckErrorMessage(caught) })
      },
    )
    return () => {
      active = false
      created.dispose()
      setClient(null)
    }
  }, [wanted])

  // Dictionnaire personnel modifié : le client revérifie les mots.
  useEffect(() => {
    if (client === null) return
    client.setPersonalDictionary(dictionary).catch((caught: unknown) => {
      setError({ language, message: spellcheckErrorMessage(caught) })
    })
  }, [client, dictionary, language])

  const onError = useCallback(
    (caught: unknown) => {
      setError({ language, message: spellcheckErrorMessage(caught) })
    },
    [language],
  )
  // Vérification aboutie (le service recharge le dictionnaire après un échec passager) : l'erreur
  // affichée dans la barre d'état disparaît.
  const onChecked = useCallback(() => {
    setError((current) => (current === null ? current : null))
  }, [])
  const addWord = useCallback((word: string) => {
    const current = latest.current
    const next = addPersonalWord(current.dictionary, word)
    // Mot invalide ou déjà présent : liste identique, rien à enregistrer.
    if (!sameWords(next, current.dictionary)) current.onDictionaryChange(next)
  }, [])

  const config = useMemo<SpellcheckConfig | null>(
    () =>
      client === null || !enabled
        ? null
        : { client, language, onMenu: setMenu, onAddToDictionary: addWord, onError, onChecked },
    [client, enabled, language, addWord, onError, onChecked],
  )

  const closeMenu = useCallback(() => {
    setMenu(null)
  }, [])

  const active = client !== null && enabled
  return {
    config,
    menu: active ? menu : null,
    closeMenu,
    error: active && error?.language === language ? error.message : null,
  }
}

function sameWords(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((word, index) => word === b[index])
}
