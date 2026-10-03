'use client'

import type { ProjectAiSettings, WorkspaceAiSettings } from '@kaxolax/contracts'
import { Alert, Label, Switch } from '@kaxolax/ui'
import { useEffect, useId, useRef, useState } from 'react'
import { ApiError, errorMessage } from '@/lib/api'

/** Explication sous l'interrupteur, selon l'état de l'IA et le rôle de l'utilisateur. */
export function aiSettingHint(settings: ProjectAiSettings): string {
  if (!settings.configured) return "L'assistant IA n'est pas configuré sur ce serveur."
  if (!settings.workspaceEnabled) {
    return 'Désactivé pour tout le workspace par son propriétaire.'
  }
  if (!settings.canManage) {
    return settings.projectEnabled
      ? 'Seul le propriétaire du projet peut le désactiver.'
      : 'Désactivé par le propriétaire du projet.'
  }
  return settings.projectEnabled
    ? 'Claude peut lire le projet et proposer des modifications (suggestions) ; il ne modifie jamais le texte directement.'
    : "Aucun membre ne peut utiliser l'assistant IA dans ce projet."
}

/** Explication sous l'interrupteur du workspace (propriétaire du workspace). */
export function workspaceAiHint(settings: WorkspaceAiSettings): string {
  return settings.enabled
    ? "Chaque projet du workspace peut utiliser l'assistant IA, si son propriétaire l'autorise."
    : "Aucun projet du workspace ne peut utiliser l'assistant IA, quel que soit son réglage."
}

/** Réglage du workspace illisible car l'utilisateur n'en est pas membre (collaborateur d'un projet). */
export function isHiddenWorkspaceError(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 403 || error.status === 404)
}

/** Réglages du projet après un changement du workspace, sans relecture. */
export function withWorkspaceAi(
  settings: ProjectAiSettings,
  workspace: WorkspaceAiSettings,
): ProjectAiSettings {
  return {
    ...settings,
    workspaceEnabled: workspace.enabled,
    enabled: settings.configured && settings.projectEnabled && workspace.enabled,
  }
}

/** Ligne libellé, explication et interrupteur. */
function AiSwitchRow({
  label,
  hint,
  checked,
  disabled,
  onChange,
  testId,
}: {
  label: string
  hint: string
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
  testId: string
}) {
  const id = useId()
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="grid gap-0.5">
        <Label htmlFor={id}>{label}</Label>
        <p className="text-xs text-muted-foreground">{hint}</p>
      </div>
      <Switch
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={onChange}
        data-testid={testId}
      />
    </div>
  )
}

/**
 * Affichage des interrupteurs : celui du projet (modifiable par son propriétaire), puis celui de
 * tout le workspace, pour le seul propriétaire du workspace (`canManage`).
 */
export function AiSettingsView({
  settings,
  workspace,
  saving,
  error,
  onProjectChange,
  onWorkspaceChange,
}: {
  /** null : chargement. */
  settings: ProjectAiSettings | null
  /** null : chargement, ou réglage du workspace non affiché. */
  workspace: WorkspaceAiSettings | null
  saving: boolean
  error: string | null
  onProjectChange: (enabled: boolean) => void
  onWorkspaceChange: (enabled: boolean) => void
}) {
  return (
    <div className="grid gap-2">
      <AiSwitchRow
        label="Assistant IA"
        hint={settings === null ? 'Chargement…' : aiSettingHint(settings)}
        checked={settings?.projectEnabled ?? false}
        disabled={settings === null || !settings.canManage || saving}
        onChange={onProjectChange}
        testId="settings-project-ai"
      />
      {workspace?.canManage ? (
        <AiSwitchRow
          label="Assistant IA pour tout le workspace"
          hint={workspaceAiHint(workspace)}
          checked={workspace.enabled}
          disabled={saving}
          onChange={onWorkspaceChange}
          testId="settings-workspace-ai"
        />
      ) : null}
      {error ? <Alert variant="destructive">{error}</Alert> : null}
    </div>
  )
}

/**
 * Interrupteurs de l'assistant IA (onglet Projet des paramètres), lus à l'ouverture : projet,
 * puis workspace pour son propriétaire (`AiSettingsView`). Relus quand `load` ou `workspace.load`
 * change : l'appelant les garde stables (mêmes projet et workspace). Une lecture partie avant un
 * enregistrement est ignorée : sa réponse, plus ancienne, écraserait l'état enregistré.
 */
export function ProjectAiSetting({
  load,
  update,
  workspace,
}: {
  load: () => Promise<ProjectAiSettings>
  update: (enabled: boolean) => Promise<ProjectAiSettings>
  /** Réglage du workspace du projet (absent : interrupteur du workspace masqué). */
  workspace?: {
    load: () => Promise<WorkspaceAiSettings>
    update: (enabled: boolean) => Promise<WorkspaceAiSettings>
  }
}) {
  const [settings, setSettings] = useState<ProjectAiSettings | null>(null)
  const [workspaceSettings, setWorkspaceSettings] = useState<WorkspaceAiSettings | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // Incrémenté à chaque enregistrement : une lecture plus ancienne ne s'applique plus.
  const saves = useRef(0)
  const loadWorkspace = workspace?.load
  const updateWorkspace = workspace?.update

  useEffect(() => {
    let active = true
    const started = saves.current
    const current = () => active && saves.current === started
    // Les deux lectures ensemble : l'erreur affichée (ou effacée) vaut pour cette relecture.
    void Promise.allSettled([load(), loadWorkspace?.() ?? Promise.resolve(null)]).then(
      ([project, workspaceResult]) => {
        if (!current()) return
        let failure: unknown = null
        if (project.status === 'fulfilled') setSettings(project.value)
        else failure = project.reason
        if (workspaceResult.status === 'fulfilled') {
          if (workspaceResult.value !== null) setWorkspaceSettings(workspaceResult.value)
        } else if (failure === null && !isHiddenWorkspaceError(workspaceResult.reason)) {
          failure = workspaceResult.reason
        }
        setError(failure === null ? null : errorMessage(failure))
      },
    )
    return () => {
      active = false
    }
  }, [load, loadWorkspace])

  /** Enregistre un changement ; les interrupteurs restent bloqués pendant la requête. */
  function save<T>(request: () => Promise<T>, apply: (saved: T) => void) {
    saves.current += 1
    setSaving(true)
    setError(null)
    request().then(
      (saved) => {
        apply(saved)
        setSaving(false)
      },
      (caught: unknown) => {
        setError(errorMessage(caught))
        setSaving(false)
      },
    )
  }

  return (
    <AiSettingsView
      settings={settings}
      workspace={updateWorkspace ? workspaceSettings : null}
      saving={saving}
      error={error}
      onProjectChange={(enabled) => {
        save(() => update(enabled), setSettings)
      }}
      onWorkspaceChange={(enabled) => {
        if (!updateWorkspace) return
        save(
          () => updateWorkspace(enabled),
          (saved) => {
            setWorkspaceSettings(saved)
            // Le réglage du projet en dépend : explication et état mis à jour.
            setSettings((current) => (current === null ? current : withWorkspaceAi(current, saved)))
          },
        )
      }}
    />
  )
}
