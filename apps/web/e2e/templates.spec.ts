import { TEMPLATE_CATEGORIES, type TemplateCategory } from '@kaxolax/contracts'
import type { Locator, Page } from '@playwright/test'
import { expect, test } from './accounts'
import { waitForEditor } from './project'

/**
 * Galerie de templates (étape 2) : `/templates` publique, recherche, filtre par catégorie, fiche
 * avec aperçu, puis « Utiliser ce template » qui crée le projet et ouvre l'éditeur, depuis la
 * fiche ou depuis le tableau de bord (« Depuis un template »). Le catalogue de démonstration
 * local n'a pas de fichiers : la création est alors sautée, avec la raison.
 */
interface Template {
  id: string
  title: string
  category: TemplateCategory
}

const UNAVAILABLE = 'Le template est momentanément indisponible. Réessayez dans quelques instants.'
const SKIP_REASON =
  'catalogue de démonstration sans fichiers : définir TEMPLATES_CATALOG_URL (voir apps/api/.env.example)'

/**
 * Valide la boîte « Nouveau projet » d'un template ; renvoie faux si le catalogue n'a pas les
 * fichiers du template (démonstration locale), vrai quand l'éditeur du projet est ouvert.
 */
async function createFromTemplate(page: Page, dialog: Locator, name: string): Promise<boolean> {
  await dialog.getByLabel('Nom du projet').fill(name)
  await dialog.getByTestId('create-from-template').click()
  const unavailable = dialog.getByText(UNAVAILABLE)
  await expect(unavailable.or(page.locator('.cm-content'))).toBeVisible({ timeout: 60_000 })
  if (await unavailable.isVisible()) return false
  await expect(page).toHaveURL(/\/project\/[0-9a-f-]{36}$/)
  await waitForEditor(page)
  await expect(page.getByTestId('project-name')).toHaveText(name)
  return true
}

test('browse, search and preview the gallery, then use a template', async ({
  accounts,
  page,
  request,
}) => {
  const listed = await request.get('/api/v1/templates')
  expect(listed.ok()).toBe(true)
  const { templates } = (await listed.json()) as { templates: Template[] }
  const template = templates[0]
  if (template === undefined) throw new Error('the template catalog is empty')
  const cards = page.getByTestId('template-grid').getByTestId('template-card')

  await test.step('the public gallery lists and filters the templates', async () => {
    await page.goto('/templates')
    await expect(cards).toHaveCount(templates.length)
    // La recherche filtre dans le navigateur : saisie répétée tant que la page n'est pas hydratée.
    const search = page.getByTestId('template-search')
    const noMatch = page.getByText('Aucun template ne correspond à votre recherche.')
    await expect(async () => {
      await search.fill('zzz introuvable zzz')
      await expect(noMatch).toBeVisible({ timeout: 2_000 })
    }).toPass({ timeout: 30_000 })
    await search.fill(template.title)
    await expect(noMatch).toBeHidden()
    await expect(cards.filter({ hasText: template.title })).toHaveCount(1)
    await search.fill('')
    await expect(cards).toHaveCount(templates.length)
  })

  await test.step('a category keeps only its templates', async () => {
    const categories = page.getByRole('group', { name: 'Catégories' })
    // Boutons dans l'ordre : « Tous », puis les catégories dans l'ordre des contrats.
    const button = categories
      .getByRole('button')
      .nth(TEMPLATE_CATEGORIES.indexOf(template.category) + 1)
    const expected = templates.filter((candidate) => candidate.category === template.category)
    await button.click()
    await expect(button).toHaveAttribute('aria-pressed', 'true')
    await expect(cards).toHaveCount(expected.length)
    await expect(cards.filter({ hasText: template.title })).toHaveCount(1)
    await categories.getByRole('button').first().click()
    await expect(cards).toHaveCount(templates.length)
  })

  await test.step('the template page shows the preview and its facts', async () => {
    await page
      .getByTestId('template-grid')
      .getByTestId('template-card')
      .filter({ hasText: template.title })
      .click()
    await expect(page).toHaveURL(new RegExp(`/templates/${template.id}$`))
    await expect(page.getByRole('heading', { level: 1, name: template.title })).toBeVisible()
    await expect(
      page.getByRole('region', { name: `Aperçu PDF de « ${template.title} »` }),
    ).toBeVisible()
    // Sans session, « Utiliser ce template » passe par la connexion.
    await page.getByTestId('use-template').click()
    await expect(page).toHaveURL(/\/sign-in\?redirect_url=/)
  })

  const { page: signedIn } = await accounts.create()
  await test.step('the dashboard opens the gallery in « Depuis un template »', async () => {
    await signedIn.getByTestId('new-from-template').click()
    const picker = signedIn.getByTestId('template-picker')
    await expect(
      picker.getByRole('heading', { name: 'Nouveau projet depuis un template' }),
    ).toBeVisible()
    await picker.getByTestId('template-card').filter({ hasText: template.title }).click()
    await expect(picker.getByRole('button', { name: 'Retour à la galerie' })).toBeVisible()
    await picker.getByTestId('use-template').click()
    const dialog = signedIn.getByRole('dialog', { name: 'Nouveau projet', exact: true })
    const created = await createFromTemplate(signedIn, dialog, `Tableau de bord ${template.title}`)
    test.skip(!created, SKIP_REASON)
  })

  await test.step('a signed-in user creates a project from the template page', async () => {
    await signedIn.goto(`/templates/${template.id}`)
    await signedIn.getByTestId('use-template').click()
    const dialog = signedIn.getByRole('dialog', { name: 'Nouveau projet', exact: true })
    expect(await createFromTemplate(signedIn, dialog, `Depuis ${template.title}`)).toBe(true)
  })
})
