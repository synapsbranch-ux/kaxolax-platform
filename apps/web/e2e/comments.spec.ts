import { randomUUID } from 'node:crypto'
import { expect, PEOPLE, test } from './accounts'
import { DEMO_MAIN, demoProjectFiles } from './demo'
import { appPathIn, mailpitAvailable, waitForEmail } from './mailpit'
import {
  activeLine,
  addMember,
  appendToEditor,
  chatMessage,
  commentedText,
  commentSelection,
  commentThread,
  editorLine,
  importProject,
  openChat,
  openProject,
  openReview,
  prependToEditor,
  selectLine,
  selectText,
  waitForEditor,
  waitSynced,
} from './project'

/**
 * Commentaires ancrés et panneau Review (étape 2) : commenter une sélection, ancrage conservé
 * après des modifications autour, réponse, résolution ; un relecteur commente, un lecteur non ;
 * modifier et supprimer son message, rouvrir un fil, naviguer d'un fil à l'autre, texte ancré
 * supprimé (citation d'origine barrée) ; email d'une @mention, en commentaire et dans le chat.
 */
const ANCHORED = 'Le modèle reproduit les mesures à moins de 5~\\% près~\\cite{knuth}.'
const FIGURE = 'La figure~\\ref{fig:courbe} montre la température mesurée au centre de la barre.'

/** Ligne (1 à n) de `text` dans le document principal de démonstration. */
function demoLine(text: string): string {
  const index = DEMO_MAIN.split('\n').findIndex((line) => line.includes(text))
  if (index < 0) throw new Error(`${text} is not in the demo document`)
  return String(index + 1)
}

test('anchored comments through the Review panel', async ({ accounts }) => {
  const owner = await accounts.create(PEOPLE.ada)
  const reviewer = await accounts.create(PEOPLE.grace)
  const reader = await accounts.create(PEOPLE.alan)
  const projectId = await importProject(owner.page, 'Commentaires', demoProjectFiles())
  await addMember(owner, reviewer, projectId, 'reviewer')
  await addMember(owner, reader, projectId, 'viewer')
  await openProject(reviewer.page, projectId)
  await openProject(reader.page, projectId)

  const question = 'Préciser l’intervalle de confiance ?'
  await test.step('the owner comments a selection', async () => {
    await selectText(owner.page, ANCHORED)
    const thread = await commentSelection(owner.page, question)
    await expect(thread).toContainText(ANCHORED)
    await expect.poll(() => commentedText(owner.page)).toBe(ANCHORED)
  })

  await test.step('the anchor follows the text when it is edited around', async () => {
    await prependToEditor(owner.page, '% Relu le 3 octobre.\n')
    await appendToEditor(owner.page, '\n% Fin du document.\n')
    // Insertion juste avant le texte commenté, sur la même ligne.
    await editorLine(owner.page, ANCHORED).click({ position: { x: 8, y: 6 } })
    await owner.page.keyboard.press('Home')
    await owner.page.keyboard.insertText('En résumé, ')
    await waitSynced(owner.page)
    await expect.poll(() => commentedText(owner.page)).toBe(ANCHORED)
    // Chez les autres membres aussi, le fil reste sur le même texte.
    await openReview(reviewer.page)
    await expect.poll(() => commentedText(reviewer.page)).toBe(ANCHORED)
    await expect(commentThread(reviewer.page, question).getByTestId('anchor-notice')).toHaveCount(0)
  })

  await test.step('a reviewer replies and comments too', async () => {
    const thread = commentThread(reviewer.page, question)
    await thread.click()
    await thread.getByTestId('comment-input').fill('Ajouté dans la section Résultats.')
    await thread.getByTestId('comment-submit').click()
    await expect(thread.getByTestId('comment')).toHaveCount(2)
    // La réponse arrive en direct dans le panneau du propriétaire.
    const ownerThread = commentThread(owner.page, question)
    await expect(ownerThread.getByTestId('comment')).toHaveCount(2)
    await expect(ownerThread).toContainText('Ajouté dans la section Résultats.')

    // Éditeur en lecture seule : la sélection reste possible.
    await selectText(reviewer.page, 'Conclusion')
    const own = await commentSelection(reviewer.page, 'Titre trop court.')
    await expect(own).toContainText('Conclusion')
    await expect(commentThread(owner.page, 'Titre trop court.')).toBeVisible()
  })

  await test.step('a reader reads the threads but cannot comment', async () => {
    const panel = await openReview(reader.page)
    await expect(commentThread(reader.page, question)).toBeVisible()
    await expect(panel.getByTestId('comment-selection')).toHaveCount(0)
    await commentThread(reader.page, question).click()
    await expect(panel.getByTestId('comment-input')).toHaveCount(0)
    await expect(panel.getByTestId('comment-resolve')).toHaveCount(0)
  })

  await test.step('resolving moves the thread to the Resolved tab', async () => {
    const panel = await openReview(owner.page)
    await expect(panel.getByTestId('review-open-tab')).toHaveText('Ouverts (2)')
    await commentThread(owner.page, question).getByTestId('comment-resolve').click()
    await expect(panel.getByTestId('review-open-tab')).toHaveText('Ouverts (1)')
    await expect(panel.getByTestId('review-resolved-tab')).toHaveText('Résolus (1)')
    await panel.getByTestId('review-resolved-tab').click()
    const resolved = commentThread(owner.page, question)
    await expect(resolved).toContainText(`Résolu par ${owner.name}`)
    await expect(resolved.getByTestId('comment-reopen')).toBeVisible()
    // Un fil résolu n'est plus surligné dans le texte.
    await expect.poll(() => commentedText(owner.page)).not.toContain(ANCHORED)
    await expect(reader.page.getByTestId('review-resolved-tab')).toHaveText('Résolus (1)')
  })
})

test('comment threads: edit, delete, reopen, navigate and a deleted anchor', async ({
  accounts,
}) => {
  const owner = await accounts.create(PEOPLE.ada)
  const reviewer = await accounts.create(PEOPLE.grace)
  const projectId = await importProject(owner.page, 'Fils de commentaires', demoProjectFiles())
  await addMember(owner, reviewer, projectId, 'reviewer')
  await openProject(reviewer.page, projectId)
  // Fils retrouvés par leur citation (le texte commenté), stable quand les messages changent.
  const figure = commentThread(owner.page, 'La figure~\\ref{fig:courbe}')
  const conclusion = commentThread(owner.page, 'Le modèle reproduit les mesures')

  await selectText(owner.page, FIGURE)
  await commentSelection(owner.page, 'Légende à reprendre.')
  await selectText(owner.page, ANCHORED)
  await commentSelection(owner.page, 'Préciser la source.')

  await test.step('the author edits a message, others cannot', async () => {
    const comment = figure.getByTestId('comment').first()
    await comment.getByRole('button', { name: 'Modifier le commentaire' }).click()
    await figure
      .getByRole('textbox', { name: 'Modifier le commentaire' })
      .fill('Légende à reprendre : unités manquantes.')
    await figure.getByRole('button', { name: 'Enregistrer', exact: true }).click()
    await expect(comment).toContainText('Légende à reprendre : unités manquantes.')
    await expect(comment).toContainText('(modifié)')
    // En direct chez la relectrice, qui ne peut ni modifier ni supprimer ce message.
    await openReview(reviewer.page)
    const seen = commentThread(reviewer.page, 'La figure~\\ref{fig:courbe}')
    await expect(seen).toContainText('unités manquantes')
    await expect(seen.getByRole('button', { name: 'Modifier le commentaire' })).toHaveCount(0)
    await expect(seen.getByRole('button', { name: 'Supprimer le commentaire' })).toHaveCount(0)
  })

  await test.step('the author deletes a reply', async () => {
    const thread = commentThread(reviewer.page, 'Le modèle reproduit les mesures')
    await thread.click()
    await thread.getByTestId('comment-input').fill('Réponse à retirer.')
    await thread.getByTestId('comment-submit').click()
    const reply = thread.getByTestId('comment').filter({ hasText: 'Réponse à retirer.' })
    await expect(reply).toHaveCount(1)
    await reply.getByRole('button', { name: 'Supprimer le commentaire' }).click()
    await thread
      .getByRole('alertdialog', { name: 'Confirmer la suppression' })
      .getByTestId('comment-delete-confirm')
      .click()
    await expect(thread.getByTestId('comment').nth(1)).toHaveText(/Message supprimé/)
    await expect(conclusion.getByTestId('comment').nth(1)).toHaveText(/Message supprimé/)
    await expect(conclusion).not.toContainText('Réponse à retirer.')
  })

  await test.step('previous and next go from thread to thread in the text', async () => {
    const panel = await openReview(owner.page)
    await figure.click()
    await expect(figure).toHaveClass(/ring-2/)
    await expect.poll(() => activeLine(owner.page)).toBe(demoLine('La figure~\\ref{fig:courbe}'))
    await panel.getByTestId('review-next').click()
    await expect(conclusion).toHaveClass(/ring-2/)
    await expect(figure).not.toHaveClass(/ring-2/)
    await expect.poll(() => activeLine(owner.page)).toBe(demoLine('Le modèle reproduit'))
    // Après le dernier fil, retour au premier.
    await panel.getByTestId('review-next').click()
    await expect(figure).toHaveClass(/ring-2/)
    await panel.getByTestId('review-previous').click()
    await expect(conclusion).toHaveClass(/ring-2/)
  })

  await test.step('a resolved thread is reopened', async () => {
    const panel = await openReview(owner.page)
    await conclusion.getByTestId('comment-resolve').click()
    await expect(panel.getByTestId('review-open-tab')).toHaveText('Ouverts (1)')
    await panel.getByTestId('review-resolved-tab').click()
    await conclusion.getByTestId('comment-reopen').click()
    await expect(panel.getByTestId('review-resolved-tab')).toHaveText('Résolus (0)')
    await panel.getByTestId('review-open-tab').click()
    await expect(panel.getByTestId('review-open-tab')).toHaveText('Ouverts (2)')
    await expect(conclusion).toBeVisible()
    await expect.poll(() => commentedText(owner.page)).toContain('Le modèle reproduit')
  })

  await test.step('when the anchored text is deleted, the quote stays, struck out', async () => {
    await selectLine(owner.page, 'La figure~\\ref{fig:courbe}')
    await owner.page.keyboard.press('Delete')
    await waitSynced(owner.page)
    await expect(figure.getByTestId('anchor-notice')).toHaveText('Texte commenté supprimé')
    await expect(figure.locator('blockquote')).toHaveText(FIGURE)
    await expect(figure.locator('blockquote')).toHaveClass(/line-through/)
    await expect(figure).toContainText('unités manquantes')
    const seen = commentThread(reviewer.page, 'La figure~\\ref{fig:courbe}')
    await expect(seen.getByTestId('anchor-notice')).toHaveText('Texte commenté supprimé')
  })
})

test('an @mention in a comment or in the chat is sent by email', async ({ accounts }) => {
  test.skip(
    !(await mailpitAvailable()),
    'Mailpit (pile locale) est nécessaire pour lire les emails de mention',
  )
  const owner = await accounts.create(PEOPLE.ada)
  const member = await accounts.create(PEOPLE.grace)
  const projectName = `Mentions ${randomUUID().slice(0, 8)}`
  const projectId = await importProject(owner.page, projectName, demoProjectFiles())
  await addMember(owner, member, projectId, 'editor')

  await test.step('a comment that mentions a member sends an email with a link', async () => {
    await selectText(owner.page, ANCHORED)
    const panel = await openReview(owner.page)
    await panel.getByTestId('comment-selection').click()
    const input = panel.getByTestId('comment-draft').getByTestId('comment-input')
    await input.fill('@Gra')
    await expect(
      panel.getByRole('listbox', { name: 'Membres à mentionner' }).getByRole('option', {
        name: member.name,
      }),
    ).toBeVisible()
    await input.press('Enter')
    await expect(input).toHaveValue(`@${member.name} `)
    await input.pressSequentially('peux-tu vérifier la source ?')
    await panel.getByTestId('comment-draft').getByTestId('comment-submit').click()
    await expect(commentThread(owner.page, 'peux-tu vérifier la source ?')).toBeVisible()

    const email = await waitForEmail(
      member.email,
      `vous a mentionné dans un commentaire de « ${projectName} »`,
    )
    expect(email.text).toContain('peux-tu vérifier la source ?')
    // Le lien ouvre le projet sur le fil.
    const path = appPathIn(
      email,
      /https?:\/\/[^\s"<]+\/project\/[0-9a-f-]{36}\?comment=[0-9a-f-]{36}/,
    )
    await member.page.goto(path)
    await waitForEditor(member.page)
    await expect(commentThread(member.page, 'peux-tu vérifier la source ?')).toHaveClass(/ring-2/)
  })

  await test.step('a chat message that mentions a member sends an email', async () => {
    await openChat(owner.page)
    const input = owner.page.getByTestId('chat-input')
    await input.fill('@Gra')
    await input.press('Enter')
    await input.pressSequentially('le tableau est à jour.')
    await input.press('Enter')
    await expect(chatMessage(owner.page, 'le tableau est à jour.')).toBeVisible()
    const email = await waitForEmail(member.email, `vous a mentionné dans « ${projectName} »`)
    expect(email.text).toContain('le tableau est à jour.')
    expect(appPathIn(email, /https?:\/\/[^\s"<]+\/project\/[0-9a-f-]{36}\?panel=chat/)).toBe(
      `/project/${projectId}?panel=chat`,
    )
  })
})
