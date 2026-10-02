import { randomUUID } from 'node:crypto'
import {
  DEFAULT_PREFERENCES,
  MAX_OPEN_TABS_PER_PROJECT,
  MAX_OPEN_TABS_PROJECTS,
  MAX_PERSONAL_DICTIONARY_WORDS,
} from '@kaxolax/contracts'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import UserPreference from '#models/user_preference'
import { createUser } from '#tests/helpers'

const URL = '/api/v1/me/preferences'

test.group('preferences', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('returns the defaults to a user who never changed anything', async ({ client, assert }) => {
    const user = await createUser()
    const response = await client.get(URL).loginAs(user)
    response.assertStatus(200)
    response.assertBody({ preferences: DEFAULT_PREFERENCES })
    assert.isNull(await UserPreference.find(user.id))
  })

  test('merges patches deeply and stores only what was changed', async ({ client, assert }) => {
    const user = await createUser()
    const first = await client
      .patch(URL)
      .json({ theme: 'light', layout: { sidebarSize: 25 } })
      .loginAs(user)
    first.assertStatus(200)
    assert.equal(first.body().preferences.theme, 'light')
    assert.deepEqual(first.body().preferences.layout, {
      ...DEFAULT_PREFERENCES.layout,
      sidebarSize: 25,
    })

    const projectId = randomUUID()
    const tabs = [randomUUID(), randomUUID()]
    await client
      .patch(URL)
      .json({
        layout: { sidebarCollapsed: true },
        toolsVisible: true,
        openTabs: { [projectId]: { documentIds: tabs, activeDocumentId: tabs[1] } },
      })
      .loginAs(user)
    // Les tableaux sont remplacés, pas concaténés.
    await client
      .patch(URL)
      .json({ openTabs: { [projectId]: { documentIds: [tabs[1]], activeDocumentId: tabs[1] } } })
      .loginAs(user)

    const stored = await UserPreference.findOrFail(user.id)
    assert.deepEqual(stored.prefs, {
      theme: 'light',
      layout: { sidebarSize: 25, sidebarCollapsed: true },
      toolsVisible: true,
      // Numéro d'ordre de la dernière modification (deuxième PATCH touchant ces onglets).
      openTabs: { [projectId]: { documentIds: [tabs[1]], activeDocumentId: tabs[1], usedSeq: 2 } },
    })

    // Même résultat sur un autre appareil : les préférences suivent le compte.
    const read = await client.get(URL).loginAs(user)
    assert.deepInclude(read.body().preferences, {
      theme: 'light',
      toolsVisible: true,
      autoCompile: false,
      layout: { ...DEFAULT_PREFERENCES.layout, sidebarSize: 25, sidebarCollapsed: true },
    })

    // Chaque utilisateur a les siennes.
    const other = await createUser()
    ;(await client.get(URL).loginAs(other)).assertBody({ preferences: DEFAULT_PREFERENCES })
  })

  test('rejects invalid patches with 422 and keeps the stored values', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    await client.patch(URL).json({ autoCompile: true }).loginAs(user)
    const invalid = [
      { theme: 'blue' },
      { unknown: true },
      { layout: { pdfSize: 101 } },
      { editor: { keymap: 'nano' } },
      { compile: { draft: 'yes' } },
      { openTabs: { 'not-a-uuid': { documentIds: [], activeDocumentId: null } } },
      {
        openTabs: {
          [randomUUID()]: {
            documentIds: Array.from({ length: MAX_OPEN_TABS_PER_PROJECT + 1 }, () => randomUUID()),
            activeDocumentId: null,
          },
        },
      },
    ]
    for (const body of invalid) {
      const response = await client.patch(URL).json(body).loginAs(user)
      response.assertStatus(422)
      response.assertBodyContains({ code: 'E_VALIDATION_ERROR' })
    }
    const stored = await UserPreference.findOrFail(user.id)
    assert.deepEqual(stored.prefs, { autoCompile: true })
  })

  test('keeps the valid keys when a stored value has become invalid', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    await client.patch(URL).json({ theme: 'light', toolsVisible: true }).loginAs(user)
    // Valeur écrite par une version antérieure et refusée par le schéma actuel.
    const row = await UserPreference.findOrFail(user.id)
    row.prefs = { theme: 'light', toolsVisible: true, editor: { fontSize: 100, wrap: false } }
    await row.save()

    const response = await client
      .patch(URL)
      .json({ layout: { sidebarSize: 22 } })
      .loginAs(user)
    response.assertStatus(200)
    const stored = await UserPreference.findOrFail(user.id)
    assert.deepEqual(stored.prefs, {
      theme: 'light',
      toolsVisible: true,
      editor: { wrap: false },
      layout: { sidebarSize: 22 },
    })
  })

  test('stores a full personal dictionary next to the maximum of open tabs', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const word = (index: number) =>
      `${'é'.repeat(4)}${[0, 1, 2].map((rank) => String.fromCharCode(97 + (Math.floor(index / 26 ** rank) % 26))).join('')}`
    const spellcheckDictionary = Array.from({ length: MAX_PERSONAL_DICTIONARY_WORDS }, (_, i) =>
      word(i),
    )
    const openTabs = Object.fromEntries(
      Array.from({ length: MAX_OPEN_TABS_PROJECTS }, () => [
        randomUUID(),
        {
          documentIds: Array.from({ length: MAX_OPEN_TABS_PER_PROJECT }, () => randomUUID()),
          activeDocumentId: randomUUID(),
        },
      ]),
    )
    const response = await client.patch(URL).json({ openTabs, spellcheckDictionary }).loginAs(user)
    response.assertStatus(200)
    assert.lengthOf(response.body().preferences.spellcheckDictionary, MAX_PERSONAL_DICTIONARY_WORDS)

    // Un mot de plus : refusé par le schéma (borne en mots), rien ne sort en silence.
    const more = await client
      .patch(URL)
      .json({ spellcheckDictionary: ['encore', ...spellcheckDictionary] })
      .loginAs(user)
    more.assertStatus(422)
    more.assertBodyContains({ code: 'E_VALIDATION_ERROR' })
    const stored = await UserPreference.findOrFail(user.id)
    assert.deepEqual(stored.prefs.spellcheckDictionary, spellcheckDictionary)
  })

  test('requires authentication', async ({ client }) => {
    ;(await client.get(URL)).assertStatus(401)
    ;(await client.patch(URL).json({ theme: 'light' })).assertStatus(401)
  })
})
