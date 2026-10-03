import { randomUUID } from 'node:crypto'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { MigrationRunner } from '@adonisjs/lucid/migration'
import { test } from '@japa/runner'
import AiConversation from '#models/ai_conversation'
import AiMessage from '#models/ai_message'
import Document from '#models/document'
import GitLink from '#models/git_link'
import Project from '#models/project'
import Suggestion from '#models/suggestion'
import User from '#models/user'
import Workspace from '#models/workspace'
import ZoteroLink from '#models/zotero_link'
import { planLimitsCache } from '#services/entitlements'
import { createProject } from '#services/project_service'
import { createUser } from '#tests/helpers'

/** Première migration de la tâche 1 (0130 à 0136). */
const FIRST_FOUNDATION_MIGRATION = 'database/migrations/1790000000130'

/**
 * Migrations à annuler pour retirer celles de la tâche 1 : la première d'entre elles et toutes
 * les suivantes déjà jouées (des migrations plus récentes s'intercalent après 0136).
 */
async function foundationSteps(): Promise<number> {
  const row = (await db
    .from('adonis_schema')
    .where('name', '>=', FIRST_FOUNDATION_MIGRATION)
    .count('* as total')
    .first()) as { total: string | number }
  return Number(row.total)
}

async function rawColumn(table: string, column: string, id: string): Promise<unknown> {
  const row = (await db.from(table).where('id', id).select(column).first()) as Record<
    string,
    unknown
  > | null
  return row?.[column]
}

test.group('ai schema: encrypted integration tokens', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('stores git tokens encrypted and reads them back', async ({ assert }) => {
    const user = await createUser()
    const project = await createProject(user, 'Git')
    const link = await GitLink.create({
      projectId: project.id,
      ownerId: user.id,
      provider: 'github',
      repositoryOwner: 'kaxolax',
      repositoryName: 'thesis',
      branch: 'main',
      accessToken: 'ghu_plain_access_token',
      refreshToken: null,
      syncStatus: 'idle',
    })
    const stored = await rawColumn('git_links', 'access_token_encrypted', link.id)
    assert.isString(stored)
    assert.notInclude(String(stored), 'ghu_plain_access_token')
    assert.isNull(await rawColumn('git_links', 'refresh_token_encrypted', link.id))

    const reloaded = await GitLink.findOrFail(link.id)
    assert.equal(reloaded.accessToken, 'ghu_plain_access_token')
    assert.isNull(reloaded.refreshToken)
    // Jamais sérialisé (réponses de l'API, journaux).
    assert.notInclude(JSON.stringify(reloaded.serialize()), 'ghu_plain_access_token')

    // Chiffrement lié à la colonne : recopié dans une autre, il ne se déchiffre pas.
    await db.from('git_links').where('id', link.id).update({ refresh_token_encrypted: stored })
    assert.isNull((await GitLink.findOrFail(link.id)).refreshToken)
    // Deux chiffrements de la même valeur diffèrent (vecteur d'initialisation aléatoire).
    const twin = await GitLink.create({
      projectId: (await createProject(user, 'Git twin')).id,
      ownerId: user.id,
      provider: 'github',
      repositoryOwner: 'kaxolax',
      repositoryName: 'twin',
      branch: 'main',
      accessToken: 'ghu_plain_access_token',
      syncStatus: 'idle',
    })
    assert.notEqual(await rawColumn('git_links', 'access_token_encrypted', twin.id), stored)

    // Un lien Git par projet.
    await assert.rejects(() =>
      db.transaction((trx) =>
        GitLink.create(
          {
            projectId: project.id,
            ownerId: user.id,
            provider: 'github',
            repositoryOwner: 'kaxolax',
            repositoryName: 'other',
            branch: 'main',
            syncStatus: 'idle',
          },
          { client: trx },
        ),
      ),
    )
  })

  test('stores the Zotero API key encrypted', async ({ assert }) => {
    const user = await createUser()
    const project = await createProject(user, 'Zotero')
    const link = await ZoteroLink.create({
      projectId: project.id,
      ownerId: user.id,
      libraryType: 'group',
      libraryId: '12345',
      collectionKey: null,
      documentId: null,
      apiKey: 'zotero-plain-key',
      syncStatus: 'idle',
    })
    assert.notInclude(
      String(await rawColumn('zotero_links', 'api_key_encrypted', link.id)),
      'zotero-plain-key',
    )
    assert.equal((await ZoteroLink.findOrFail(link.id)).apiKey, 'zotero-plain-key')
  })
})

test.group('ai schema: constraints', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('keeps the content blocks of an AI message as they are', async ({ assert }) => {
    const user = await createUser()
    const project = await createProject(user, 'Conversation')
    const conversation = await AiConversation.create({
      projectId: project.id,
      userId: user.id,
      title: null,
      archivedAt: null,
    })
    const content = [
      { type: 'thinking', thinking: '', signature: 'c2ln' },
      { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: 'main.tex' } },
      { type: 'fallback', from: { model: 'a' }, to: { model: 'b' }, trigger: null },
    ]
    const message = await AiMessage.create({
      conversationId: conversation.id,
      role: 'assistant',
      content,
      model: 'claude-opus-5-5',
      status: 'complete',
      stopReason: 'tool_use',
      usage: { input_tokens: 3, output_tokens: 4 },
      errorCode: null,
    })
    const reloaded = await AiMessage.findOrFail(message.id)
    assert.deepEqual(reloaded.content, content)
    assert.deepEqual(reloaded.usage, { input_tokens: 3, output_tokens: 4 })
    // Le contenu est toujours un tableau de blocs.
    await assert.rejects(() =>
      db.transaction((trx) =>
        trx.table('ai_messages').insert({
          id: randomUUID(),
          conversation_id: conversation.id,
          role: 'user',
          content: JSON.stringify({ type: 'text', text: 'x' }),
        }),
      ),
    )
  })

  test('checks the kind, the texts and the decision of a suggestion', async ({ assert }) => {
    const user = await createUser()
    const project = await createProject(user, 'Suggestions')
    const document = await Document.query().where('projectId', project.id).firstOrFail()
    const base = {
      projectId: project.id,
      documentId: document.id,
      authorId: user.id,
      origin: 'user' as const,
      anchor: Buffer.from([1, 0, 0, 0, 1, 1, 1]),
      decidedBy: null,
      decidedAt: null,
      aiMessageId: null,
      status: 'open' as const,
    }
    const insert = await Suggestion.create({
      ...base,
      kind: 'insert',
      originalText: '',
      proposedText: ' et',
    })
    assert.equal((await Suggestion.findOrFail(insert.id)).proposedText, ' et')
    for (const invalid of [
      { kind: 'insert' as const, originalText: 'x', proposedText: 'y' },
      { kind: 'delete' as const, originalText: 'x', proposedText: 'y' },
      { kind: 'replace' as const, originalText: 'x', proposedText: 'x' },
    ]) {
      await assert.rejects(() =>
        db.transaction((trx) => Suggestion.create({ ...base, ...invalid }, { client: trx })),
      )
    }
    // Acceptée : décidée par un membre ; une suggestion humaine ne pointe pas vers l'IA.
    await assert.rejects(() =>
      db.transaction((trx) =>
        Suggestion.create(
          { ...base, kind: 'delete', originalText: 'x', proposedText: '', status: 'accepted' },
          { client: trx },
        ),
      ),
    )
    const message = randomUUID()
    await assert.rejects(() =>
      db.transaction((trx) =>
        Suggestion.create(
          { ...base, kind: 'delete', originalText: 'x', proposedText: '', aiMessageId: message },
          { client: trx },
        ),
      ),
    )
  })

  test('links only team workspaces to a Clerk organization, once', async ({ assert }) => {
    const user = await createUser()
    const personal = await Workspace.query()
      .where({ ownerId: user.id, type: 'personal' })
      .firstOrFail()
    await assert.rejects(() =>
      db.transaction((trx) =>
        trx.from('workspaces').where('id', personal.id).update({ clerk_organization_id: 'org_1' }),
      ),
    )
    const team = await Workspace.create({
      name: 'Lab',
      type: 'team',
      ownerId: user.id,
      clerkOrganizationId: 'org_lab',
    })
    assert.isTrue(team.aiEnabled)
    assert.equal((await Workspace.findOrFail(team.id)).clerkOrganizationId, 'org_lab')
    await assert.rejects(() =>
      db.transaction((trx) =>
        Workspace.create(
          { name: 'Copy', type: 'team', ownerId: user.id, clerkOrganizationId: 'org_lab' },
          { client: trx },
        ),
      ),
    )
  })
})

/**
 * Migrations aller-retour : les migrations de la tâche 1 (et les suivantes) sont annulées puis
 * rejouées sur la base de test, sans perte des données existantes. Hors transaction globale
 * (DDL) ; le projet créé est supprimé à la fin.
 */
test.group('ai schema: migrations round trip', () => {
  test('rolls back and replays the foundation migrations without losing data', async ({
    assert,
  }) => {
    const user = await createUser()
    const project = await createProject(user, 'Survives the rollback')
    try {
      const down = new MigrationRunner(db, app, {
        direction: 'down',
        step: await foundationSteps(),
      })
      await down.run()
      assert.isNull(down.error)
      assert.equal(down.status, 'completed')
      for (const table of ['ai_usage', 'suggestions', 'personal_access_tokens', 'git_links']) {
        assert.isFalse(await db.connection().schema.hasTable(table))
      }
      assert.isFalse(await db.connection().schema.hasColumn('projects', 'ai_enabled'))
      assert.isFalse(await db.connection().schema.hasColumn('plan_limits', 'ai_monthly_credits'))
      // Données d'avant la tâche 1 intactes.
      assert.equal((await Project.findOrFail(project.id)).name, 'Survives the rollback')
      const free = (await db.from('plan_limits').where('plan_slug', 'free').first()) as {
        storage_bytes: string
      }
      assert.equal(Number(free.storage_bytes), 500 * 1024 * 1024)

      const up = new MigrationRunner(db, app, { direction: 'up' })
      await up.run()
      assert.isNull(up.error)
      assert.equal(up.status, 'completed')
      assert.isTrue((await Project.findOrFail(project.id)).aiEnabled)
      const credits = (await db
        .from('plan_limits')
        .orderBy('plan_slug')
        .select('plan_slug', 'ai_monthly_credits', 'image_monthly_credits')) as {
        plan_slug: string
        ai_monthly_credits: number
        image_monthly_credits: number
      }[]
      assert.deepEqual(credits, [
        { plan_slug: 'free', ai_monthly_credits: 100, image_monthly_credits: 5 },
        { plan_slug: 'pro', ai_monthly_credits: 2000, image_monthly_credits: 100 },
        // Plan d'organisation (tâche 10), crédits par siège.
        { plan_slug: 'team', ai_monthly_credits: 2000, image_monthly_credits: 100 },
      ])
      // Clés étrangères SET NULL vers les messages et workspaces indexées côté référençant.
      const indexes = (await db
        .from('pg_indexes')
        .whereIn('tablename', ['ai_usage', 'suggestions'])
        .select('indexname')) as { indexname: string }[]
      const names = indexes.map((row) => row.indexname)
      for (const name of [
        'ai_usage_ai_message_id_index',
        'ai_usage_workspace_id_index',
        'suggestions_ai_message_id_index',
      ]) {
        assert.include(names, name)
      }
    } finally {
      planLimitsCache.clear()
      await Project.query().where('id', project.id).delete()
      await User.query().where('id', user.id).delete()
    }
  })
})
