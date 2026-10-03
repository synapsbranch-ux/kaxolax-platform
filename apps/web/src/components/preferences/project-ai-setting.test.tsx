import type { PlanLimitError, ProjectAiSettings, WorkspaceAiSettings } from '@kaxolax/contracts'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ApiError } from '@/lib/api'
import { planLimitMessage } from '@/lib/plan-limits'
import {
  AiSettingsView,
  aiSettingHint,
  isHiddenWorkspaceError,
  ProjectAiSetting,
  withWorkspaceAi,
  workspaceAiHint,
} from './project-ai-setting'

const settings: ProjectAiSettings = {
  projectId: '0b8f7e6d-5c4b-4a39-8281-7f6e5d4c3b2a',
  projectEnabled: true,
  workspaceEnabled: true,
  configured: true,
  enabled: true,
  canManage: true,
}

const workspace: WorkspaceAiSettings = {
  workspaceId: '1c9f8e7d-6c5b-4a49-8382-8f7e6d5c4b3a',
  enabled: true,
  configured: true,
  canManage: true,
}

function view(overrides: Partial<Parameters<typeof AiSettingsView>[0]> = {}): string {
  return renderToStaticMarkup(
    <AiSettingsView
      settings={settings}
      workspace={workspace}
      saving={false}
      error={null}
      onProjectChange={() => undefined}
      onWorkspaceChange={() => undefined}
      {...overrides}
    />,
  )
}

/** Attributs de l'interrupteur `data-testid` dans le HTML rendu (null : absent). */
function switchOf(markup: string, testId: string): string | null {
  return (
    [...markup.matchAll(/<button[^>]*>/g)]
      .map((match) => match[0])
      .find((tag) => tag.includes(`data-testid="${testId}"`)) ?? null
  )
}

describe('project AI setting', () => {
  it('explains why the assistant is available or not', () => {
    expect(aiSettingHint(settings)).toContain('ne modifie jamais le texte directement')
    expect(aiSettingHint({ ...settings, projectEnabled: false, enabled: false })).toContain(
      'Aucun membre',
    )
    expect(aiSettingHint({ ...settings, configured: false, enabled: false })).toContain(
      "n'est pas configuré",
    )
    expect(aiSettingHint({ ...settings, workspaceEnabled: false, enabled: false })).toContain(
      'tout le workspace',
    )
    expect(aiSettingHint({ ...settings, canManage: false })).toContain('Seul le propriétaire')
    expect(
      aiSettingHint({ ...settings, canManage: false, projectEnabled: false, enabled: false }),
    ).toContain('Désactivé par le propriétaire')
  })

  it('renders a disabled switch while the settings load', () => {
    const markup = renderToStaticMarkup(
      <ProjectAiSetting
        load={() => Promise.resolve(settings)}
        update={() => Promise.resolve(settings)}
      />,
    )
    expect(markup).toContain('Assistant IA')
    expect(markup).toContain('Chargement…')
    expect(markup).toMatch(/role="switch"[^>]*disabled=""/)
  })

  it('shows the workspace switch to the owner of the workspace only', () => {
    const owner = view()
    const workspaceSwitch = switchOf(owner, 'settings-workspace-ai')
    expect(workspaceSwitch).not.toBeNull()
    expect(workspaceSwitch).toContain('aria-checked="true"')
    expect(workspaceSwitch).not.toContain('disabled=""')
    expect(owner).toContain('Assistant IA pour tout le workspace')

    // Membre du workspace sans droit, ou réglage non lu (non-membre, chargement) : masqué.
    expect(
      switchOf(view({ workspace: { ...workspace, canManage: false } }), 'settings-workspace-ai'),
    ).toBeNull()
    expect(switchOf(view({ workspace: null }), 'settings-workspace-ai')).toBeNull()

    const off = view({
      settings: withWorkspaceAi(settings, { ...workspace, enabled: false }),
      workspace: { ...workspace, enabled: false },
    })
    expect(switchOf(off, 'settings-workspace-ai')).toContain('aria-checked="false"')
    expect(off).toContain('Désactivé pour tout le workspace')
    expect(off).toContain('Aucun projet du workspace')
    // Pendant un enregistrement, les deux interrupteurs sont bloqués.
    const saving = view({ saving: true })
    expect(switchOf(saving, 'settings-workspace-ai')).toContain('disabled=""')
    expect(switchOf(saving, 'settings-project-ai')).toContain('disabled=""')
  })

  it('updates the project settings after a change of the workspace', () => {
    expect(withWorkspaceAi(settings, { ...workspace, enabled: false })).toEqual({
      ...settings,
      workspaceEnabled: false,
      enabled: false,
    })
    expect(
      withWorkspaceAi({ ...settings, workspaceEnabled: false, enabled: false }, workspace),
    ).toEqual(settings)
    // Projet désactivé : le workspace réactivé ne rend pas l'IA utilisable.
    expect(
      withWorkspaceAi(
        { ...settings, projectEnabled: false, workspaceEnabled: false, enabled: false },
        workspace,
      ).enabled,
    ).toBe(false)
    expect(workspaceAiHint(workspace)).toContain('Chaque projet')
    expect(isHiddenWorkspaceError(new ApiError(403, 'E_WORKSPACE_FORBIDDEN', 'Forbidden'))).toBe(
      true,
    )
    expect(isHiddenWorkspaceError(new ApiError(500, 'E_INTERNAL', 'Boom'))).toBe(false)
  })

  it('explains a refusal beyond the monthly credits', () => {
    const refusal: PlanLimitError = {
      code: 'E_PLAN_LIMIT',
      message: 'The monthly AI credits of your plan are used up',
      limit: { name: 'ai_credits', plan: 'free', max: 100 },
      feature: 'ai',
      current: 100,
      upgradeUrl: 'http://localhost:3000/pricing',
    }
    expect(planLimitMessage(refusal)).toEqual({
      title: 'Crédits IA épuisés',
      description:
        'Votre plan Free inclut 100 crédits IA par mois (utilisés : 100). Ils sont renouvelés le 1er du mois ; un plan supérieur en offre davantage.',
    })
    expect(
      planLimitMessage({
        ...refusal,
        limit: { name: 'image_credits', plan: 'pro', max: 1 },
      }).description,
    ).toContain('Votre plan Pro permet 1 image par mois')
  })
})
