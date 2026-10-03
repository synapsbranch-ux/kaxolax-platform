import { MAX_UPLOAD_BYTES, type MePlanResponse } from '@kaxolax/contracts'
import type { Page } from '@playwright/test'
import { expect, PEOPLE, test } from './accounts'
import { api } from './api'
import { testEmail } from './clerk'
import { demoProjectFiles } from './demo'
import { addMember, compile, importProject, openShareDialog } from './project'

/**
 * Limites du plan (étape 2), appliquées par l'API (`E_PLAN_LIMIT`) et expliquées avec un lien
 * vers les tarifs : collaborateurs (modale de partage), durée de compilation (en-tête du PDF),
 * stockage (upload refusé) ; onglet Billing de `/account`. Chaque parcours est sauté, avec la
 * raison, si le plan du compte de test n'a pas cette limite ou l'a trop haute pour un parcours.
 */

/** Plan du compte de la page : limites et usage (`GET /me/plan`). */
async function plan(page: Page): Promise<MePlanResponse> {
  return api<MePlanResponse>(page, 'GET', '/me/plan')
}

/** Durée de compilation (en secondes) à partir de laquelle le parcours de la limite est sauté. */
const MAX_COMPILE_SECONDS_TESTED = 60
/** Stockage au-delà duquel le parcours de la limite est sauté (remplissage trop long). */
const MAX_STORAGE_TESTED = 1024 * 1024 * 1024
/** Place laissée libre avant l'upload refusé par l'interface. */
const STORAGE_MARGIN = 256 * 1024
const MAX_COLLABORATORS_TESTED = 3
const FIRST_NAMES = [PEOPLE.grace, PEOPLE.alan, PEOPLE.katherine] as const

interface CollaboratorUsage {
  plan: string
  max: number | null
  used: number
}

test('the collaborator limit of the Free plan links to the pricing page', async ({ accounts }) => {
  const owner = await accounts.create(PEOPLE.ada)
  const projectId = await importProject(owner.page, 'Limite du plan', demoProjectFiles())
  const { collaborators } = await api<{ collaborators: CollaboratorUsage | null }>(
    owner.page,
    'GET',
    `/projects/${projectId}/members`,
  )
  const max = collaborators?.max ?? null
  test.skip(max === null, 'plan du compte de test sans limite de collaborateurs')
  test.skip(
    max !== null && max > MAX_COLLABORATORS_TESTED,
    `limite de collaborateurs supérieure à ${String(MAX_COLLABORATORS_TESTED)} pour ce plan`,
  )

  // Collaborateurs jusqu'à la limite (par un lien de partage : aucun email envoyé).
  for (const person of FIRST_NAMES.slice(0, max ?? 0)) {
    const member = await accounts.create(person)
    await addMember(owner, member, projectId, 'editor')
  }

  const dialog = await openShareDialog(owner.page)
  await expect(dialog.getByTestId('collaborator-usage')).toContainText('limite atteinte')
  await dialog.getByTestId('invite-email').fill(testEmail('limite'))
  await dialog.getByTestId('invite-submit').click()
  const notice = dialog.getByTestId('plan-limit-notice')
  await expect(notice).toBeVisible()
  await expect(notice).toHaveAttribute('data-limit', 'collaborators')
  // La boîte de dialogue globale des limites ne s'ouvre pas en plus.
  await expect(owner.page.getByTestId('plan-limit-dialog')).toHaveCount(0)

  await notice.getByRole('link', { name: 'Voir les plans' }).click()
  await expect(owner.page).toHaveURL(/\/pricing$/)
  await expect(
    owner.page.getByRole('heading', { level: 1, name: 'Choisissez votre plan' }),
  ).toBeVisible()
})

test('the compile time limit of the plan stops a long compilation', async ({ accounts }) => {
  test.setTimeout(360_000)
  const owner = await accounts.create(PEOPLE.ada)
  const { limits } = await plan(owner.page)
  test.skip(
    limits.maxCompileSeconds >= MAX_COMPILE_SECONDS_TESTED,
    `durée de compilation du plan d'au moins ${String(MAX_COMPILE_SECONDS_TESTED)} s`,
  )
  // Boucle TeX de deux milliards de tours (plus d'une minute) : au-delà de la limite du plan.
  await importProject(owner.page, 'Compilation trop longue', [
    {
      path: 'main.tex',
      data: [
        '\\documentclass{article}',
        '\\begin{document}',
        '\\newcount\\turns',
        '\\loop\\advance\\turns by 1 \\ifnum\\turns<2000000000 \\repeat',
        'Jamais atteint.',
        '\\end{document}',
        '',
      ].join('\n'),
    },
  ])
  const result = await compile(owner.page)
  expect(result.status).toBe('timeout')
  const viewer = owner.page.getByTestId('pdf-viewer')
  await expect(viewer).toContainText('La compilation a dépassé le temps autorisé.')
  const notice = viewer.getByTestId('plan-limit-notice')
  await expect(notice).toHaveAttribute('data-limit', 'compile_time')
  await expect(notice).toContainText(`${String(limits.maxCompileSeconds)} s`)
  await notice.getByRole('link', { name: 'Voir les plans' }).click()
  await expect(owner.page).toHaveURL(/\/pricing$/)
})

test('the storage limit of the plan refuses an upload', async ({ accounts }) => {
  test.setTimeout(600_000)
  const owner = await accounts.create(PEOPLE.ada)
  const projectId = await importProject(owner.page, 'Stockage plein', demoProjectFiles())
  const current = await plan(owner.page)
  const free = current.limits.storageBytes - current.usage.storageBytes
  test.skip(
    current.limits.storageBytes > MAX_STORAGE_TESTED,
    'stockage du plan trop grand pour être rempli par ce parcours',
  )

  // Remplissage par l'API (upload présigné), jusqu'à ne laisser que la marge.
  let remaining = free - STORAGE_MARGIN
  for (let index = 1; remaining > 0; index++) {
    const size = Math.min(remaining, MAX_UPLOAD_BYTES)
    const started = await api<{ uploadId: string; url: string }>(
      owner.page,
      'POST',
      `/projects/${projectId}/uploads`,
      { filename: `remplissage-${String(index)}.bin`, folderId: null, sizeBytes: size },
    )
    const put = await owner.page.request.put(started.url, { data: Buffer.alloc(size) })
    expect(put.ok()).toBe(true)
    await api(owner.page, 'POST', `/projects/${projectId}/uploads/${started.uploadId}/complete`)
    remaining -= size
  }

  // Un fichier plus grand que la place restante : refusé, avec la limite et les tarifs.
  await owner.page.getByTestId('upload-input').setInputFiles({
    name: 'trop-grand.bin',
    mimeType: 'application/octet-stream',
    buffer: Buffer.alloc(STORAGE_MARGIN * 2),
  })
  const dialog = owner.page.getByTestId('plan-limit-dialog')
  await expect(dialog).toContainText('Espace de stockage plein')
  await expect(dialog.getByTestId('plan-limit-notice')).toHaveAttribute('data-limit', 'storage')
  await expect(owner.page.locator('[data-path="trop-grand.bin"]')).toHaveCount(0)
  await dialog.getByRole('link', { name: 'Voir les plans' }).click()
  await expect(owner.page).toHaveURL(/\/pricing$/)
})

test('the Billing tab of the account page', async ({ accounts }) => {
  const { page } = await accounts.create()
  await page.goto('/account')
  await expect(page.locator('.cl-userProfile-root')).toBeVisible()
  const billing = page.locator('.cl-navbarButton__billing')
  test.skip(
    (await billing.count()) === 0,
    'Clerk Billing n’est pas activé pour les utilisateurs de l’instance de test',
  )
  await billing.click()
  await expect(page).toHaveURL(/\/account\/billing/)
  await expect(page.locator('.cl-profilePage__billing')).toBeVisible()
})
