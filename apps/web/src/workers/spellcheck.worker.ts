/**
 * Web Worker du correcteur orthographique : Hunspell (WebAssembly) de `@kaxolax/editor`, chargé
 * seulement quand le correcteur est actif ; dictionnaires servis par l'application
 * (`app/dictionaries`), téléchargés à la première vérification d'une langue.
 */
import { startSpellcheckWorker } from '@kaxolax/editor/spellcheck-worker'

startSpellcheckWorker(self, { dictionaryUrl: (language) => `/dictionaries/${language}` })
