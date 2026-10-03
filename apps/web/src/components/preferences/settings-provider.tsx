'use client'

import type { SpellcheckLanguage } from '@kaxolax/contracts'
import {
  Component,
  createContext,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react'

/** Onglets de la boîte des paramètres. */
export type SettingsSection = 'editor' | 'spellcheck' | 'project' | 'plan'

/** Réglages du projet ouvert, affichés dans l'onglet Projet (page projet seulement). */
export interface ProjectSettings {
  projectName: string
  spellcheckLanguage: SpellcheckLanguage
  /** Propriétaire ou éditeur : peut changer la langue du correcteur. */
  canEdit: boolean
  onSpellcheckLanguageChange: (language: SpellcheckLanguage) => Promise<void>
}

interface SettingsContextValue {
  /** Ouvre les paramètres (onglet facultatif). */
  openSettings: (section?: SettingsSection) => void
  /** Enregistre (ou retire, null) les réglages du projet ouvert. */
  setProjectSettings: (settings: ProjectSettings | null) => void
}

const SettingsContext = createContext<SettingsContextValue | null>(null)

// Chargée à la première ouverture : les listes de polices et de thèmes viennent de
// @kaxolax/editor, qui n'a rien à faire dans le bundle du tableau de bord.
// Recréé après un échec : `lazy` garderait sinon l'erreur pour toujours.
const loadDialog = () => lazy(() => import('./settings-dialog'))
let SettingsDialog = loadDialog()

/**
 * Paramètres de l'éditeur (thème, coloration, police, raccourcis, correcteur…), ouverts depuis le
 * pied de la sidebar, le menu du compte, la barre d'onglets ou le menu Fichier de la barre Tools.
 * Les valeurs sont des préférences de l'utilisateur : enregistrées dans l'API, elles le suivent
 * sur tous ses appareils et s'appliquent à chaud aux éditeurs ouverts.
 */
export function SettingsProvider({ children }: { children: ReactNode }) {
  const [section, setSection] = useState<SettingsSection | null>(null)
  const [project, setProject] = useState<ProjectSettings | null>(null)

  const openSettings = useCallback((next: SettingsSection = 'editor') => {
    setSection(next)
  }, [])
  const value = useMemo(() => ({ openSettings, setProjectSettings: setProject }), [openSettings])
  return (
    <SettingsContext value={value}>
      {children}
      {section !== null ? (
        <LoadBoundary
          onFail={() => {
            SettingsDialog = loadDialog()
            setSection(null)
          }}
        >
          <Suspense fallback={null}>
            <SettingsDialog
              section={section === 'project' && project === null ? 'editor' : section}
              onSectionChange={setSection}
              project={project}
              onClose={() => {
                setSection(null)
              }}
            />
          </Suspense>
        </LoadBoundary>
      ) : null}
    </SettingsContext>
  )
}

/**
 * Chargement de la boîte en échec (hors ligne, nouvelle version du site) : elle se referme au
 * lieu de faire tomber la page ; une nouvelle ouverture réessaie.
 */
class LoadBoundary extends Component<
  { onFail: () => void; children: ReactNode },
  { failed: boolean }
> {
  override state = { failed: false }

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true }
  }

  override componentDidCatch(): void {
    this.props.onFail()
  }

  override render() {
    return this.state.failed ? null : this.props.children
  }
}

/** Ouverture des paramètres (voir `SettingsProvider`). */
export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext)
  if (value === null) throw new Error('useSettings must be used inside SettingsProvider')
  return value
}

/** Expose les réglages du projet ouvert dans l'onglet Projet tant que la page est affichée. */
export function useProjectSettings(settings: ProjectSettings | null): void {
  const { setProjectSettings } = useSettings()
  useEffect(() => {
    setProjectSettings(settings)
  }, [settings, setProjectSettings])
  useEffect(
    () => () => {
      setProjectSettings(null)
    },
    [setProjectSettings],
  )
}
