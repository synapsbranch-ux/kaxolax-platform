'use client'

import { type SpellcheckLanguage, type Theme } from '@kaxolax/contracts'
import {
  addPersonalWord,
  EDITOR_FONTS,
  EDITOR_KEYMAPS,
  type EditorKeymapMode,
  fontStack,
  PERSONAL_DICTIONARY_LIMIT,
  personalWordStatus,
  removePersonalWord,
  SYNTAX_THEMES,
} from '@kaxolax/editor'
import {
  Alert,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  Input,
  Label,
  NativeSelect,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  ToggleGroup,
  ToggleGroupItem,
} from '@kaxolax/ui'
import { MoonIcon, SunIcon, XIcon } from 'lucide-react'
import { type ReactNode, useId, useState } from 'react'
import { PlanUsage } from '@/components/billing/plan-usage'
import { errorMessage } from '@/lib/api'
import {
  CUSTOM_FONT,
  FONT_SIZES,
  fontChoice,
  isValidCustomFont,
  LINE_HEIGHTS,
  nearest,
  personalWordMessage,
} from '@/lib/editor-settings'
import { usePreferences } from './preferences-provider'
import { ProjectAiSetting } from './project-ai-setting'
import type { ProjectSettings, SettingsSection } from './settings-provider'

const LANGUAGES: { id: SpellcheckLanguage; label: string }[] = [
  { id: 'fr', label: 'Français' },
  { id: 'en', label: 'Anglais' },
]

const SAMPLE = [
  '\\section{Introduction}\\label{sec:intro}',
  'Soit $f(x) = \\int_0^1 e^{-t^2}\\,dt$ % commentaire',
  '\\begin{itemize} \\item Exemple \\end{itemize}',
]

/**
 * Paramètres : onglet Éditeur (thème, coloration, police, taille, hauteur de ligne, raccourcis,
 * retour à la ligne), Correcteur (activation, dictionnaire personnel), Projet (langue du
 * correcteur, assistant IA, sur la page projet) et Plan (plan, stockage utilisé et limites, en
 * lecture). Chaque changement est appliqué tout de suite aux éditeurs ouverts et enregistré dans
 * les préférences de l'utilisateur (tous ses appareils) ; les réglages du projet, dans le projet.
 */
export default function SettingsDialog({
  section,
  onSectionChange,
  project,
  onClose,
}: {
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  project: ProjectSettings | null
  onClose: () => void
}) {
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="max-h-[92dvh] grid-rows-[auto_minmax(0,1fr)] overflow-hidden sm:max-w-xl"
        data-testid="settings-dialog"
      >
        <DialogHeader>
          <DialogTitle>Paramètres</DialogTitle>
          <DialogDescription>
            Appliqués immédiatement et enregistrés dans votre compte, sur tous vos appareils.
          </DialogDescription>
        </DialogHeader>
        <Tabs
          value={section}
          onValueChange={(value) => {
            if (
              value === 'editor' ||
              value === 'spellcheck' ||
              value === 'project' ||
              value === 'plan'
            )
              onSectionChange(value)
          }}
          className="min-h-0"
        >
          <TabsList>
            <TabsTrigger value="editor">Éditeur</TabsTrigger>
            <TabsTrigger value="spellcheck">Correcteur</TabsTrigger>
            {project ? <TabsTrigger value="project">Projet</TabsTrigger> : null}
            <TabsTrigger value="plan">Plan</TabsTrigger>
          </TabsList>
          <div className="min-h-0 overflow-y-auto pr-1">
            <TabsContent value="editor">
              <EditorSection />
            </TabsContent>
            <TabsContent value="spellcheck">
              <SpellcheckSection />
            </TabsContent>
            {project ? (
              <TabsContent value="project">
                <ProjectSection project={project} />
              </TabsContent>
            ) : null}
            <TabsContent value="plan">
              <PlanUsage className="pt-2" />
            </TabsContent>
          </div>
        </Tabs>
      </DialogContent>
    </Dialog>
  )
}

/** Ligne libellé + contrôle, empilée sur écran étroit. */
function Row({
  id,
  label,
  hint,
  children,
}: {
  id: string
  label: string
  hint?: string
  children: ReactNode
}) {
  return (
    <div className="grid gap-1.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center sm:gap-3">
      <Label htmlFor={id}>{label}</Label>
      <div className="min-w-0">
        {children}
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
    </div>
  )
}

function EditorSection() {
  const { preferences, update } = usePreferences()
  const editor = preferences.editor
  const ids = useId()
  const choice = fontChoice(editor.fontFamily)
  // Police saisie : brouillon local, enregistré quand il est valide (sortie du champ, Entrée).
  const [customFont, setCustomFont] = useState(choice === CUSTOM_FONT ? editor.fontFamily : '')
  const [customMode, setCustomMode] = useState(choice === CUSTOM_FONT)
  const customValid = isValidCustomFont(customFont)

  const saveCustomFont = () => {
    if (customValid && customFont.trim() !== editor.fontFamily)
      update({ editor: { fontFamily: customFont.trim() } })
  }

  return (
    <div className="grid gap-4 py-2">
      <Row id={`${ids}-theme`} label="Thème">
        <ToggleGroup
          id={`${ids}-theme`}
          type="single"
          variant="outline"
          size="sm"
          value={preferences.theme}
          aria-label="Thème de l’interface"
          onValueChange={(value) => {
            if (value === 'dark' || value === 'light') update({ theme: value satisfies Theme })
          }}
        >
          <ToggleGroupItem value="dark" aria-label="Sombre" className="px-3">
            <MoonIcon /> Sombre
          </ToggleGroupItem>
          <ToggleGroupItem value="light" aria-label="Clair" className="px-3">
            <SunIcon /> Clair
          </ToggleGroupItem>
        </ToggleGroup>
      </Row>
      <Row id={`${ids}-syntax`} label="Coloration">
        <NativeSelect
          id={`${ids}-syntax`}
          className="w-full"
          value={editor.syntaxTheme}
          onChange={(event) => {
            update({ editor: { syntaxTheme: event.target.value } })
          }}
          data-testid="settings-syntax-theme"
        >
          {SYNTAX_THEMES.map((theme) => (
            <option key={theme.id} value={theme.id}>
              {theme.label}
            </option>
          ))}
        </NativeSelect>
      </Row>
      <Row
        id={`${ids}-font`}
        label="Police"
        hint={
          customMode
            ? 'Nom d’une police installée sur cet appareil (lettres, chiffres, espaces, virgules, tirets, guillemets).'
            : undefined
        }
      >
        <NativeSelect
          id={`${ids}-font`}
          className="w-full"
          value={customMode ? CUSTOM_FONT : choice}
          onChange={(event) => {
            const value = event.target.value
            if (value === CUSTOM_FONT) {
              setCustomMode(true)
              return
            }
            setCustomMode(false)
            update({ editor: { fontFamily: value } })
          }}
          data-testid="settings-font"
        >
          {EDITOR_FONTS.map((font) => (
            <option key={font.id} value={font.id}>
              {font.label}
            </option>
          ))}
          <option value={CUSTOM_FONT}>Autre police…</option>
        </NativeSelect>
        {customMode ? (
          <Input
            className="mt-2"
            aria-label="Nom de la police"
            placeholder="Cascadia Code"
            value={customFont}
            maxLength={100}
            aria-invalid={customFont !== '' && !customValid}
            onChange={(event) => {
              setCustomFont(event.target.value)
            }}
            onBlur={saveCustomFont}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                saveCustomFont()
              }
            }}
          />
        ) : null}
      </Row>
      <div className="grid grid-cols-2 gap-4">
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-size`}>Taille</Label>
          <NativeSelect
            id={`${ids}-size`}
            value={String(nearest(FONT_SIZES, editor.fontSize))}
            onChange={(event) => {
              update({ editor: { fontSize: Number(event.target.value) } })
            }}
            data-testid="settings-font-size"
          >
            {FONT_SIZES.map((size) => (
              <option key={size} value={size}>
                {size} px
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`${ids}-line-height`}>Hauteur de ligne</Label>
          <NativeSelect
            id={`${ids}-line-height`}
            value={String(nearest(LINE_HEIGHTS, editor.lineHeight))}
            onChange={(event) => {
              update({ editor: { lineHeight: Number(event.target.value) } })
            }}
          >
            {LINE_HEIGHTS.map((height) => (
              <option key={height} value={height}>
                {height.toLocaleString('fr-FR')}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      <Row
        id={`${ids}-keymap`}
        label="Raccourcis clavier"
        hint={
          editor.keymap === 'default'
            ? undefined
            : 'Les raccourcis de Kaxolax (compiler, outils) restent disponibles s’ils ne sont pas pris par ce mode.'
        }
      >
        <NativeSelect
          id={`${ids}-keymap`}
          className="w-full"
          value={editor.keymap}
          onChange={(event) => {
            const mode = EDITOR_KEYMAPS.find((entry) => entry.id === event.target.value)
            if (mode) update({ editor: { keymap: mode.id satisfies EditorKeymapMode } })
          }}
          data-testid="settings-keymap"
        >
          {EDITOR_KEYMAPS.map((mode) => (
            <option key={mode.id} value={mode.id}>
              {mode.label}
            </option>
          ))}
        </NativeSelect>
      </Row>
      <div className="flex items-center justify-between gap-3">
        <Label htmlFor={`${ids}-wrap`}>Retour à la ligne automatique</Label>
        <Switch
          id={`${ids}-wrap`}
          checked={editor.wrap}
          onCheckedChange={(checked) => {
            update({ editor: { wrap: checked } })
          }}
          data-testid="settings-wrap"
        />
      </div>
      <figure className="grid gap-1">
        <figcaption className="text-xs text-muted-foreground">Aperçu</figcaption>
        <pre
          className="overflow-x-auto rounded-md border bg-muted px-3 py-2"
          style={{
            fontFamily: fontStack(editor.fontFamily),
            fontSize: `${String(editor.fontSize)}px`,
            lineHeight: editor.lineHeight,
            whiteSpace: editor.wrap ? 'pre-wrap' : 'pre',
          }}
        >
          {SAMPLE.join('\n')}
        </pre>
      </figure>
    </div>
  )
}

function SpellcheckSection() {
  const { preferences, update } = usePreferences()
  const ids = useId()
  const words = preferences.spellcheckDictionary
  const [draft, setDraft] = useState('')
  // Raison du dernier ajout refusé (mot invalide, déjà présent, dictionnaire plein).
  const [refusal, setRefusal] = useState<string | null>(null)

  const add = () => {
    const word = draft.trim()
    const message = personalWordMessage(personalWordStatus(words, word))
    if (message !== null) {
      setRefusal(message)
      return
    }
    update({ spellcheckDictionary: addPersonalWord(words, word) })
    setDraft('')
    setRefusal(null)
  }

  return (
    <div className="grid gap-4 py-2">
      <div className="flex items-center justify-between gap-3">
        <div>
          <Label htmlFor={`${ids}-enabled`}>Correcteur orthographique</Label>
          <p className="text-xs text-muted-foreground">
            Commandes LaTeX, formules, commentaires et code ignorés. Clic droit (ou F7) sur un mot
            souligné pour les suggestions.
          </p>
        </div>
        <Switch
          id={`${ids}-enabled`}
          checked={preferences.editor.spellcheck}
          onCheckedChange={(checked) => {
            update({ editor: { spellcheck: checked } })
          }}
          data-testid="settings-spellcheck"
        />
      </div>
      <section className="grid gap-2" aria-labelledby={`${ids}-dictionary`}>
        <h3 id={`${ids}-dictionary`} className="text-sm font-medium">
          Dictionnaire personnel{' '}
          <span className="font-normal text-muted-foreground">
            ({words.length} / {PERSONAL_DICTIONARY_LIMIT} mots, toutes langues)
          </span>
        </h3>
        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            add()
          }}
        >
          <Input
            aria-label="Mot à ajouter"
            placeholder="Ajouter un mot"
            value={draft}
            maxLength={40}
            aria-invalid={refusal !== null}
            aria-describedby={refusal !== null ? `${ids}-invalid` : undefined}
            onChange={(event) => {
              setDraft(event.target.value)
              setRefusal(null)
            }}
          />
          <Button type="submit" variant="outline" disabled={draft.trim() === ''}>
            Ajouter
          </Button>
        </form>
        {refusal !== null ? (
          <p id={`${ids}-invalid`} className="text-xs text-destructive" role="alert">
            {refusal}
          </p>
        ) : null}
        {words.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Aucun mot. Les mots ajoutés depuis le menu du correcteur apparaissent ici.
          </p>
        ) : (
          <ul className="flex max-h-48 flex-wrap gap-1.5 overflow-y-auto" aria-label="Mots">
            {words.map((word) => (
              <li
                key={word}
                className="flex items-center gap-1 rounded-full border bg-muted py-0.5 pr-1 pl-2.5 text-sm"
              >
                {word}
                <Button
                  variant="ghost"
                  size="icon-xs"
                  className="size-5 rounded-full"
                  aria-label={`Retirer ${word}`}
                  onClick={() => {
                    update({ spellcheckDictionary: removePersonalWord(words, word) })
                  }}
                >
                  <XIcon />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function ProjectSection({ project }: { project: ProjectSettings }) {
  const ids = useId()
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return (
    <div className="grid gap-4 py-2">
      <p className="text-sm text-muted-foreground">
        Réglages du projet <strong className="text-foreground">{project.projectName}</strong>,
        communs à tous ses membres.
      </p>
      <Row
        id={`${ids}-language`}
        label="Langue du correcteur"
        hint={
          project.canEdit
            ? 'Dictionnaire utilisé pour tous les documents du projet.'
            : 'Seuls le propriétaire et les éditeurs peuvent la changer.'
        }
      >
        <NativeSelect
          id={`${ids}-language`}
          className="w-full"
          value={project.spellcheckLanguage}
          disabled={!project.canEdit || saving}
          onChange={(event) => {
            const language = LANGUAGES.find((entry) => entry.id === event.target.value)
            if (!language) return
            setSaving(true)
            setError(null)
            project.onSpellcheckLanguageChange(language.id).then(
              () => {
                setSaving(false)
              },
              (caught: unknown) => {
                setSaving(false)
                setError(errorMessage(caught))
              },
            )
          }}
          data-testid="settings-spellcheck-language"
        >
          {LANGUAGES.map((language) => (
            <option key={language.id} value={language.id}>
              {language.label}
            </option>
          ))}
        </NativeSelect>
      </Row>
      {error ? <Alert variant="destructive">{error}</Alert> : null}
      <ProjectAiSetting
        load={project.loadAiSettings}
        update={project.onAiEnabledChange}
        workspace={{
          load: project.loadWorkspaceAiSettings,
          update: project.onWorkspaceAiEnabledChange,
        }}
      />
    </div>
  )
}
