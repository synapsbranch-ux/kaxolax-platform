import { expect, PEOPLE, test } from './accounts'
import { DEMO_MAIN, demoProjectFiles } from './demo'
import {
  addMember,
  compile,
  editorText,
  importProject,
  openProject,
  openSuggestions,
  placeCursorAfter,
  selectText,
  setEditMode,
  struckText,
  suggestedText,
  suggestionCard,
  waitForEditor,
  waitSynced,
} from './project'

/**
 * Suivi des modifications (étape 3, tâche 2) : un relecteur suggère (mode Suggérer imposé), le
 * texte ne change pas ; ses suggestions s'affichent en ligne chez tous, en direct ; l'éditeur
 * (ici la propriétaire) en accepte une depuis le panneau Review et refuse l'autre depuis
 * l'info-bulle ; le texte accepté est attribué au relecteur dans l'historique. Puis : bascule
 * mémorisée par projet, lecteur sans bascule, suggestion obsolète, tout accepter par auteur.
 */
const ADDED = ' expérimentales'
const REPLACED = 'homogène'
/** Sans préfixe ni suffixe commun avec le texte remplacé : barré et ajouté en entier. */
const REPLACEMENT = 'd’acier'

test('a reviewer suggests, the editor accepts, the author stays in the history', async ({
  accounts,
}) => {
  test.setTimeout(240_000)
  const owner = await accounts.create(PEOPLE.ada)
  const reviewer = await accounts.create(PEOPLE.grace)
  const projectId = await importProject(owner.page, 'Suivi des modifications', demoProjectFiles())
  await addMember(owner, reviewer, projectId, 'reviewer')
  await openProject(reviewer.page, projectId)

  await test.step('the reviewer is in Suggest mode and her typing leaves the text unchanged', async () => {
    await expect(reviewer.page.getByTestId('edit-mode-suggest-only')).toBeVisible()
    await expect(reviewer.page.getByTestId('edit-mode-toggle')).toHaveCount(0)
    await placeCursorAfter(reviewer.page, 'Le modèle reproduit les mesures')
    await reviewer.page.keyboard.type(ADDED)
    await selectText(reviewer.page, REPLACED)
    await reviewer.page.keyboard.type(REPLACEMENT)
    // Affichage en ligne : ajout en widget, texte remplacé barré ; le texte reste celui d'origine.
    await expect.poll(() => suggestedText(reviewer.page)).toBe(`${REPLACEMENT}${ADDED}`)
    await expect.poll(() => struckText(reviewer.page)).toBe(REPLACED)
    await expect.poll(() => editorText(reviewer.page)).toBe(DEMO_MAIN)
  })

  await test.step('the suggestions reach the owner live, with their author', async () => {
    await expect.poll(() => suggestedText(owner.page)).toBe(`${REPLACEMENT}${ADDED}`)
    await expect.poll(() => editorText(owner.page)).toBe(DEMO_MAIN)
    const panel = await openSuggestions(owner.page)
    await expect(panel.getByTestId('review-suggestions-tab')).toHaveText('Suggestions (2)')
    await panel
      .getByTestId('suggestions-author-filter')
      .selectOption({ label: `${reviewer.name} (2)` })
    await expect(panel.getByTestId('suggestion-card')).toHaveCount(2)
    await expect(suggestionCard(owner.page, ADDED.trim())).toContainText(reviewer.name)
    // La relectrice ne décide pas : ni Accepter ni Refuser chez elle, seulement Retirer.
    const own = await openSuggestions(reviewer.page)
    await expect(own.getByTestId('suggestion-card')).toHaveCount(2)
    await expect(own.getByTestId('suggestion-accept')).toHaveCount(0)
    await expect(own.getByTestId('suggestion-withdraw')).toHaveCount(2)
  })

  await test.step('the owner accepts one from the panel and rejects the other inline', async () => {
    await suggestionCard(owner.page, ADDED.trim()).getByTestId('suggestion-accept').click()
    await expect(suggestionCard(owner.page, ADDED.trim())).toHaveCount(0)
    await expect.poll(() => editorText(owner.page)).toContain(`mesures${ADDED} à moins`)
    // Refus depuis l'info-bulle du texte barré.
    await owner.page.locator('.cm-content .cm-suggestion-delete').first().hover()
    const tooltip = owner.page.locator('.cm-suggestion-tooltip')
    await expect(tooltip).toContainText(reviewer.name)
    await tooltip.getByRole('button', { name: 'Refuser' }).click()
    await expect(owner.page.getByTestId('suggestion-card')).toHaveCount(0)
    await expect.poll(() => struckText(owner.page)).toBe('')
    await expect.poll(() => editorText(owner.page)).toContain(REPLACED)
    // Chez la relectrice aussi, en direct.
    await expect.poll(() => editorText(reviewer.page)).toContain(`mesures${ADDED} à moins`)
    await expect(reviewer.page.getByTestId('suggestion-card')).toHaveCount(0)
  })

  await test.step('the accepted text is credited to the reviewer in the history', async () => {
    await waitSynced(owner.page)
    expect((await compile(owner.page)).status).toBe('success')
    const drawer = owner.page.getByTestId('history-drawer')
    await owner.page.getByTestId('history-button').click()
    await drawer.getByTestId('history-version').first().click()
    const diff = drawer.getByTestId('history-diff')
    await expect(
      diff.locator(`[title="Ajouté par ${reviewer.name}"]`).filter({ hasText: 'expérimentales' }),
    ).not.toHaveCount(0)
    await owner.page.keyboard.press('Escape')
  })
})

test('Suggest mode is remembered, readers have none, stale and bulk decisions', async ({
  accounts,
}) => {
  test.setTimeout(240_000)
  const owner = await accounts.create(PEOPLE.ada)
  const reader = await accounts.create(PEOPLE.alan)
  const projectId = await importProject(owner.page, 'Suggestions groupées', demoProjectFiles())
  await addMember(owner, reader, projectId, 'viewer')
  await openProject(reader.page, projectId)

  await test.step('a reader has neither the toggle nor Suggest mode', async () => {
    await expect(reader.page.getByTestId('edit-mode-toggle')).toHaveCount(0)
    await expect(reader.page.getByTestId('edit-mode-suggest-only')).toHaveCount(0)
    await expect(reader.page.locator('.cm-content')).toHaveAttribute('contenteditable', 'false')
  })

  await test.step('the owner switches to Suggest, the choice survives a reload', async () => {
    await setEditMode(owner.page, 'suggest')
    await placeCursorAfter(owner.page, 'Le modèle reproduit les mesures')
    await owner.page.keyboard.type(ADDED)
    await selectText(owner.page, 'Conclusion')
    await owner.page.keyboard.type('Conclusions')
    await expect.poll(() => suggestedText(owner.page)).toContain('expérimentales')
    // Ctrl+Z retire la suggestion en cours, le texte ne change pas.
    await owner.page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => suggestedText(owner.page)).toBe(ADDED)
    await openSuggestions(owner.page)
    await expect(suggestionCard(owner.page, ADDED.trim())).toHaveCount(1)
    await owner.page.reload()
    await waitForEditor(owner.page)
    await expect(owner.page.getByTestId('edit-mode-suggest')).toHaveAttribute('data-state', 'on')
    await expect.poll(() => suggestedText(owner.page)).toBe(ADDED)
    // Le lecteur voit la suggestion, sans pouvoir décider.
    await expect.poll(() => suggestedText(reader.page)).toBe(ADDED)
    const seen = await openSuggestions(reader.page)
    await expect(seen.getByTestId('suggestion-card')).toHaveCount(1)
    await expect(seen.getByTestId('suggestion-accept')).toHaveCount(0)
    await expect(seen.getByTestId('suggestions-accept-all')).toHaveCount(0)
  })

  await test.step('a suggestion whose text changed becomes stale', async () => {
    await openSuggestions(owner.page)
    await selectText(owner.page, 'barre homogène')
    await owner.page.keyboard.type('barre de fer')
    await expect.poll(() => struckText(owner.page)).toBe('homogène')
    // Retour en mode Modifier : la modification directe touche le texte visé par la suggestion.
    await setEditMode(owner.page, 'edit')
    await selectText(owner.page, 'homogène')
    await owner.page.keyboard.type('épaisse')
    await waitSynced(owner.page)
    const card = suggestionCard(owner.page, 'de fer')
    await expect(card.getByTestId('suggestion-notice')).toContainText('Obsolète')
    await card.getByTestId('suggestion-accept').click()
    await expect(owner.page.getByTestId('suggestion-notice-bar')).toContainText('1 obsolète')
    await expect(card.getByTestId('suggestion-stale')).toBeVisible()
    await expect.poll(() => editorText(owner.page)).toContain('barre épaisse')
    // Obsolète : son auteur peut la retirer, un éditeur l'écarter ; elle quitte alors le panneau.
    await expect(card.getByTestId('suggestion-withdraw')).toBeVisible()
    await expect(card.getByTestId('suggestion-accept')).toHaveCount(0)
    await card.getByTestId('suggestion-discard').click()
    await expect(card).toHaveCount(0)
    await expect(owner.page.getByTestId('suggestion-notice-bar')).toContainText('1 refusée')
    await expect.poll(() => editorText(owner.page)).toContain('barre épaisse')
  })

  await test.step('accept everything of an author at once', async () => {
    const panel = await openSuggestions(owner.page)
    await panel
      .getByTestId('suggestions-author-filter')
      .selectOption({ label: `${owner.name} (1)` })
    await panel.getByTestId('suggestions-accept-all').click()
    const confirm = owner.page.getByRole('dialog', { name: 'Accepter les suggestions ?' })
    await confirm.getByRole('button', { name: 'Tout accepter' }).click()
    await expect.poll(() => editorText(owner.page)).toContain(`mesures${ADDED} à moins`)
    await expect(panel.getByTestId('review-suggestions-tab')).toHaveText('Suggestions (0)')
    await expect.poll(() => editorText(reader.page)).toContain(`mesures${ADDED} à moins`)
  })
})
