import { CHAT_PAGE_SIZE } from '@kaxolax/contracts'
import { expect, PEOPLE, test } from './accounts'
import { api } from './api'
import { demoProjectFiles } from './demo'
import {
  activeLine,
  activeTab,
  addMember,
  chatMessage,
  importProject,
  openChat,
  openProject,
  sendChat,
  waitForEditor,
} from './project'

/**
 * Chat du projet (étape 2) : message reçu en moins d'une seconde, badge de non-lus exact après
 * rechargement, mention d'un membre, référence `fichier.tex:42` qui ouvre le fichier à la ligne,
 * historique paginé (messages précédents chargés à la demande). L'email d'une mention est
 * vérifié dans comments.spec.ts.
 */
test('project chat between two collaborators', async ({ accounts }) => {
  const owner = await accounts.create(PEOPLE.ada)
  const guest = await accounts.create(PEOPLE.grace)
  const projectId = await importProject(owner.page, 'Chat', demoProjectFiles())
  await addMember(owner, guest, projectId, 'editor')
  await openProject(guest.page, projectId)
  await openChat(owner.page)
  await openChat(guest.page)

  await test.step('a message reaches the other member in less than a second', async () => {
    const text = 'Bonjour Grace, la section Méthode est prête.'
    // Le chat affiché marque le message comme lu chez la destinataire.
    const read = guest.page.waitForResponse(
      (response) => response.url().endsWith('/chat/read') && response.request().method() === 'POST',
    )
    const input = owner.page.getByTestId('chat-input')
    await input.fill(text)
    const sentAt = Date.now()
    await input.press('Enter')
    await expect(chatMessage(guest.page, text)).toBeVisible({ timeout: 1_000 })
    expect(Date.now() - sentAt).toBeLessThan(1_000)
    expect((await read).ok()).toBe(true)
  })

  await test.step('the unread badge is exact after a reload', async () => {
    await guest.page.getByRole('tab', { name: 'Fichiers', exact: true }).click()
    for (const text of ['Premier point.', 'Deuxième point.', 'Troisième point.']) {
      await sendChat(owner.page, text)
      await expect(chatMessage(owner.page, text)).toBeVisible()
    }
    const badge = guest.page.getByTestId('chat-unread-badge')
    await expect(badge).toHaveText('3')
    await guest.page.reload()
    await waitForEditor(guest.page)
    await expect(badge).toHaveText('3')
    await expect(badge).toHaveAttribute('aria-label', '3 messages non lus')
    // Affiché, le chat est lu : le badge disparaît.
    await openChat(guest.page)
    await expect(badge).toBeHidden()
  })

  await test.step('a member is mentioned from the @ suggestions', async () => {
    const input = owner.page.getByTestId('chat-input')
    await input.fill('@Gra')
    const suggestions = owner.page.getByRole('listbox', { name: 'Membres à mentionner' })
    await expect(suggestions.getByRole('option', { name: guest.name })).toBeVisible()
    await input.press('Enter')
    await expect(input).toHaveValue(`@${guest.name} `)
    await input.pressSequentially('peux-tu relire la conclusion ?')
    await input.press('Enter')
    const message = chatMessage(guest.page, 'peux-tu relire la conclusion ?')
    await expect(message).toHaveText(`@${guest.name} peux-tu relire la conclusion ?`)
    // Message qui mentionne la personne : mis en valeur chez elle.
    await expect(message).toHaveClass(/bg-sidebar-primary/)
  })

  await test.step('a file:line reference opens the document at that line', async () => {
    await sendChat(owner.page, 'Le chiffre de main.tex:42 est à vérifier.')
    const link = guest.page.getByRole('button', { name: 'main.tex:42', exact: true })
    await expect(link).toHaveAttribute('title', 'Ouvrir main.tex à la ligne 42')
    await guest.page.getByRole('tab', { name: 'Fichiers', exact: true }).click()
    await guest.page.locator('[data-path="sections/methode.tex"]').click()
    await expect(activeTab(guest.page)).toHaveAttribute('data-tab-path', 'sections/methode.tex')
    await openChat(guest.page)
    await link.click()
    await expect(activeTab(guest.page)).toHaveAttribute('data-tab-path', 'main.tex')
    await expect.poll(() => activeLine(guest.page)).toBe('42')
  })
})

test('the chat history is paginated', async ({ accounts }) => {
  const owner = await accounts.create(PEOPLE.ada)
  const guest = await accounts.create(PEOPLE.grace)
  const projectId = await importProject(owner.page, 'Historique du chat', demoProjectFiles())
  await addMember(owner, guest, projectId, 'editor')
  // Une page et dix messages de plus, envoyés par l'API (dans l'ordre).
  const total = CHAT_PAGE_SIZE + 10
  for (let index = 1; index <= total; index++) {
    await api(owner.page, 'POST', `/projects/${projectId}/chat/messages`, {
      body: `Message numéro ${String(index)}.`,
    })
  }

  await openProject(guest.page, projectId)
  const panel = await openChat(guest.page)
  const messages = guest.page.getByTestId('chat-message')
  await expect(messages).toHaveCount(CHAT_PAGE_SIZE)
  // Les plus récents d'abord chargés : le dernier est là, pas le premier.
  await expect(chatMessage(guest.page, `Message numéro ${String(total)}.`)).toBeVisible()
  await expect(chatMessage(guest.page, 'Message numéro 1.')).toHaveCount(0)

  await panel.getByRole('button', { name: 'Messages précédents' }).click()
  await expect(messages).toHaveCount(total)
  await expect(messages.first()).toHaveText('Message numéro 1.')
  await expect(panel.getByRole('button', { name: 'Messages précédents' })).toHaveCount(0)
})
