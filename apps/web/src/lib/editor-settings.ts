import {
  EDITOR_FONTS,
  type EditorReconfiguration,
  type EditorSettings,
  PERSONAL_DICTIONARY_LIMIT,
  type PersonalWordStatus,
  personalWordStatus,
  SpellcheckError,
} from '@kaxolax/editor'

/** Tailles de police proposées (le schéma accepte 8 à 32). */
export const FONT_SIZES = [10, 11, 12, 13, 14, 15, 16, 18, 20, 22, 24] as const

/** Hauteurs de ligne proposées (le schéma accepte 1 à 3). */
export const LINE_HEIGHTS = [1.2, 1.35, 1.5, 1.65, 1.8, 2] as const

/** Valeur du sélecteur de police pour une police saisie par l'utilisateur. */
export const CUSTOM_FONT = 'custom'

/**
 * Police saisie acceptée (mêmes caractères que `fontStack` de @kaxolax/editor : lettres,
 * chiffres, espaces, virgules, tirets, guillemets ; 100 caractères au plus).
 */
export function isValidCustomFont(value: string): boolean {
  return /^[\p{L}\p{N} ,'"-]{1,100}$/u.test(value.trim())
}

/** Choix du sélecteur de police : préréglage, ou `custom` pour un nom saisi. */
export function fontChoice(fontFamily: string): string {
  return EDITOR_FONTS.some((font) => font.id === fontFamily) ? fontFamily : CUSTOM_FONT
}

/** Valeur la plus proche dans une liste (préférence enregistrée hors des choix proposés). */
export function nearest<T extends number>(values: readonly T[], value: number): T {
  let best = values[0]
  if (best === undefined) throw new Error('Empty list')
  for (const candidate of values) {
    if (Math.abs(candidate - value) < Math.abs(best - value)) best = candidate
  }
  return best
}

/** Extensions des fichiers relus par le correcteur : texte rédigé en LaTeX (ou texte brut). */
const SPELLCHECKED_EXTENSIONS = new Set(['tex', 'ltx', 'txt'])

/**
 * Vrai si le correcteur s'applique à ce fichier : pas aux bibliographies (.bib : noms, DOI,
 * URL), ni aux classes, styles et configurations (.cls, .sty, .cfg…), faits de code plutôt que
 * de prose.
 */
export function isSpellcheckedPath(path: string): boolean {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot > 0 && SPELLCHECKED_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())
}

/** Message d'erreur du correcteur pour l'interface. */
export function spellcheckErrorMessage(error: unknown): string {
  if (error instanceof SpellcheckError) {
    switch (error.code) {
      case 'E_DICTIONARY_UNAVAILABLE':
        return 'Dictionnaire indisponible : vérifiez votre connexion, puis rouvrez le fichier.'
      case 'E_TIMEOUT':
        return 'Le correcteur ne répond pas (dictionnaire trop long à charger).'
      case 'E_DISPOSED':
        return 'Correcteur arrêté.'
      default:
        return 'Le correcteur a rencontré une erreur.'
    }
  }
  return 'Le correcteur n’a pas pu démarrer dans ce navigateur.'
}

/**
 * Réglages modifiés entre deux états (null si rien n'a changé) : seuls ceux-là sont
 * reconfigurés, pour ne pas réinitialiser l'état des raccourcis Vim ou du correcteur quand
 * l'utilisateur change une autre préférence.
 */
export function settingsChange(
  before: EditorSettings,
  after: EditorSettings,
): EditorReconfiguration | null {
  const change: EditorReconfiguration = {}
  if (before.theme !== after.theme) change.theme = after.theme
  const appearance = after.appearance
  if (
    before.appearance.fontFamily !== appearance.fontFamily ||
    before.appearance.fontSize !== appearance.fontSize ||
    before.appearance.lineHeight !== appearance.lineHeight
  ) {
    change.appearance = appearance
  }
  if (before.syntaxTheme !== after.syntaxTheme) change.syntaxTheme = after.syntaxTheme
  if (before.keymap !== after.keymap) change.keymap = after.keymap
  if (before.lineWrapping !== after.lineWrapping) change.lineWrapping = after.lineWrapping
  if (before.spellcheck !== after.spellcheck) change.spellcheck = after.spellcheck
  return Object.keys(change).length === 0 ? null : change
}

/** Raison d'un ajout refusé au dictionnaire personnel (null si l'ajout est possible). */
export function personalWordMessage(status: PersonalWordStatus): string | null {
  switch (status) {
    case 'ok':
      return null
    case 'invalid':
      return 'Un seul mot : lettres, apostrophes et traits d’union (40 caractères au plus).'
    case 'duplicate':
      return 'Ce mot est déjà dans le dictionnaire personnel.'
    case 'full':
      return `Dictionnaire personnel plein (${String(PERSONAL_DICTIONARY_LIMIT)} mots ou 20 Ko au plus) : retirez des mots dans Paramètres › Correcteur.`
  }
}

/**
 * Raison pour laquelle le menu du correcteur ne peut pas ajouter `word` au dictionnaire personnel
 * (plein, ou mot refusé par le schéma), null s'il le peut. Apostrophe typographique ramenée à `'`
 * comme le fait l'éditeur avant l'ajout.
 */
export function dictionaryAddRefusal(words: readonly string[], word: string): string | null {
  const status = personalWordStatus(words, word.replace(/’/g, "'"))
  return status === 'duplicate' ? null : personalWordMessage(status)
}
