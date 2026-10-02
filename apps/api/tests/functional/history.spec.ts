import { createHash, randomUUID } from 'node:crypto'
import { rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readDocumentText, replaceStateText } from '@kaxolax/collab'
import {
  type CompileRequest,
  documentDiffResponseSchema,
  type GatewayCompileResponse,
  type ProjectEvent,
  type ReplaceDocumentRequest,
  restoreVersionResponseSchema,
  versionDetailSchema,
  versionListResponseSchema,
} from '@kaxolax/contracts'
import { importZip } from '@kaxolax/zip-importer'
import app from '@adonisjs/core/services/app'
import testUtils from '@adonisjs/core/services/test_utils'
import db from '@adonisjs/lucid/services/db'
import { type ApiClient, ApiRequest } from '@japa/api-client'
import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Document from '#models/document'
import File from '#models/file'
import Project from '#models/project'
import ProjectMember from '#models/project_member'
import ProjectVersion from '#models/project_version'
import type User from '#models/user'
import CompileGateway from '#services/compile_gateway'
import { sweepDueVersions, purgeExpiredHistory } from '#services/history_scheduler'
import {
  createVersion,
  dueProjectIds,
  type HistoryDependencies,
  historyTextKey,
  purgeProjectHistory,
} from '#services/history_service'
import ObjectStorage, { fileKey } from '#services/object_storage'
import RealtimeClient from '#services/realtime_client'
import { buildTree } from '#services/tree_service'
import { createUser } from '#tests/helpers'

ApiRequest.addParser('application/zip', (response, done) => {
  const chunks: Buffer[] = []
  response.on('data', (chunk: Buffer) => chunks.push(chunk))
  response.on('end', () => {
    done(null, Buffer.concat(chunks))
  })
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 7, 7])
const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')

/**
 * Faux service temps réel : pas d'instantané (état en base), et une restauration de texte qui fait
 * ce que fait le service (modification minimale, journalisée au nom de la personne qui restaure).
 */
class FakeRealtime extends RealtimeClient {
  events: ProjectEvent[] = []
  replaced: { documentId: string; request: ReplaceDocumentRequest }[] = []
  unavailable = false
  /** Appels (numérotés à partir de 1) qui échouent comme un service indisponible. */
  failingCalls = new Set<number>()
  private calls = 0

  override async snapshot() {
    return Promise.resolve(null)
  }

  override async closeDocuments() {
    return Promise.resolve()
  }

  override async flushUpdates() {
    return Promise.resolve()
  }

  override async publishProjectEvent(_projectId: string, event: ProjectEvent) {
    this.events.push(event)
    return Promise.resolve()
  }

  override async replaceDocument(
    projectId: string,
    documentId: string,
    request: ReplaceDocumentRequest,
  ) {
    this.calls++
    if (this.unavailable || this.failingCalls.has(this.calls)) return null
    this.replaced.push({ documentId, request })
    const changed = await edit(projectId, documentId, request.userId, request.content)
    return { changed }
  }
}

class FakeGateway extends CompileGateway {
  requests: CompileRequest[] = []

  override async compile(request: CompileRequest): Promise<GatewayCompileResponse> {
    this.requests.push(request)
    return Promise.resolve({
      buildId: request.buildId,
      status: 'success',
      durationMs: 10,
      agentId: 'agent-test',
      outputFiles: [],
      entries: [],
      timings: { syncMs: 1, runMs: 1, uploadMs: 1 },
    })
  }
}

let realtime: FakeRealtime
let gateway: FakeGateway
const storage = new ObjectStorage()
const deps = (): HistoryDependencies => ({ storage, realtime })

/**
 * Modification d'un document comme la ferait le service temps réel : mise à jour Yjs minimale
 * journalisée avec son auteur, état enregistré, date du projet mise à jour (horloge réelle : la
 * transaction globale des tests fige `now()`).
 */
async function edit(
  projectId: string,
  documentId: string,
  userId: string | null,
  text: string,
): Promise<boolean> {
  const document = await Document.findOrFail(documentId)
  const { state, update } = replaceStateText(
    document.yjsState ? new Uint8Array(document.yjsState) : null,
    text,
  )
  if (!update) return false
  await db
    .insertQuery()
    .table('document_updates')
    .insert({
      project_id: projectId,
      document_id: documentId,
      user_id: userId,
      yjs_update: Buffer.from(update),
      created_at: new Date(),
    })
  await db
    .from('documents')
    .where('id', documentId)
    .update({ yjs_state: Buffer.from(state), content_sha256: sha256(text) })
  await db.from('projects').where('id', projectId).update({ updated_at: new Date() })
  return true
}

async function textOf(documentId: string): Promise<string> {
  const document = await Document.findOrFail(documentId)
  return readDocumentText(document.yjsState ? new Uint8Array(document.yjsState) : null)
}

/** Projet : main.tex, chapters/intro.tex, figs/plot.png (binaire dans S3), dossier vide. */
async function setupProject(client: ApiClient, owner: User) {
  const created = await client.post('/api/v1/projects').json({ name: 'Thèse' }).loginAs(owner)
  const projectId = created.body().project.id as string
  const project = await Project.findOrFail(projectId)
  const mainId = project.mainDocumentId ?? ''
  const chapters = await client
    .post(`/api/v1/projects/${projectId}/folders`)
    .json({ name: 'chapters' })
    .loginAs(owner)
  const intro = await client
    .post(`/api/v1/projects/${projectId}/documents`)
    .json({ name: 'intro.tex', folderId: chapters.body().folder.id, content: 'Introduction' })
    .loginAs(owner)
  const figs = await client
    .post(`/api/v1/projects/${projectId}/folders`)
    .json({ name: 'figs' })
    .loginAs(owner)
  await client.post(`/api/v1/projects/${projectId}/folders`).json({ name: 'empty' }).loginAs(owner)
  const fileId = randomUUID()
  await storage.putBuffer(fileKey(projectId, fileId), PNG, 'image/png')
  await File.create({
    id: fileId,
    projectId,
    folderId: figs.body().folder.id as string,
    name: 'plot.png',
    s3Key: fileKey(projectId, fileId),
    sha256: sha256(PNG),
    sizeBytes: PNG.length,
    mimeType: 'image/png',
  })
  await edit(projectId, mainId, owner.id, '\\documentclass{article}\nBonjour')
  return { projectId, mainId, introId: intro.body().document.id as string, fileId }
}

async function addMember(projectId: string, role: 'editor' | 'reviewer' | 'viewer') {
  const user = await createUser()
  await ProjectMember.create({ projectId, userId: user.id, role })
  return user
}

/** Arborescence comparable : chemins et contenus. */
async function snapshotTree(projectId: string) {
  const tree = await buildTree(projectId)
  const project = await Project.findOrFail(projectId)
  return {
    folders: tree.folders.map((folder) => folder.path).sort(),
    documents: await Promise.all(
      tree.documents.map(async (document) => ({
        id: document.id,
        path: document.path,
        text: await textOf(document.id),
      })),
    ),
    files: tree.files.map((file) => ({ id: file.id, path: file.path })),
    mainDocumentId: project.mainDocumentId,
  }
}

const later = (minutes: number) => DateTime.utc().plus({ minutes })

test.group('history', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(() => {
    realtime = new FakeRealtime()
    gateway = new FakeGateway()
    app.container.swap(RealtimeClient, () => realtime)
    app.container.swap(CompileGateway, () => gateway)
    return () => {
      app.container.restore(RealtimeClient)
      app.container.restore(CompileGateway)
    }
  })

  test('creates an automatic version after two idle minutes, only once', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const { projectId } = await setupProject(client, owner)

    // Modifié à l'instant : pas encore dû.
    assert.equal(await sweepDueVersions(deps(), DateTime.utc()), 0)
    assert.equal(await sweepDueVersions(deps(), later(3)), 1)
    // Déjà versionné : rien de nouveau, même balayé de nouveau.
    assert.equal(await sweepDueVersions(deps(), later(4)), 0)

    const first = await ProjectVersion.findByOrFail('projectId', projectId)
    assert.equal(first.kind, 'auto')
    assert.deepEqual(first.authorIds, [owner.id])
    assert.isTrue(realtime.events.some((event) => event.type === 'version.created'))
  })

  test('creates a version on each manual compile, not on auto-compilation', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const { projectId, mainId } = await setupProject(client, owner)

    ;(
      await client
        .post(`/api/v1/projects/${projectId}/compile`)
        .json({ trigger: 'auto' })
        .loginAs(owner)
    ).assertStatus(200)
    assert.lengthOf(await ProjectVersion.query().where('projectId', projectId), 0)

    ;(await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(owner)).assertStatus(200)
    const versions = await ProjectVersion.query().where('projectId', projectId)
    assert.lengthOf(versions, 1)
    assert.equal(versions[0]?.kind, 'compile')
    assert.lengthOf(gateway.requests, 2)

    // Compilé de nouveau sans modification : pas de version en double.
    ;(await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(owner)).assertStatus(200)
    assert.lengthOf(await ProjectVersion.query().where('projectId', projectId), 1)
    await edit(projectId, mainId, owner.id, 'Changé')
    ;(await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(owner)).assertStatus(200)
    assert.lengthOf(await ProjectVersion.query().where('projectId', projectId), 2)

    // Un lecteur compile (lecture seule) : pas de version, ni de travail d'historique.
    const viewer = await addMember(projectId, 'viewer')
    await edit(projectId, mainId, owner.id, 'Changé encore')
    ;(await client.post(`/api/v1/projects/${projectId}/compile`).loginAs(viewer)).assertStatus(200)
    assert.lengthOf(await ProjectVersion.query().where('projectId', projectId), 2)
  })

  test('puts a failing project aside so that the sweep reaches the others', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const broken = await setupProject(client, owner)
    const healthy = await setupProject(client, owner)
    await createVersion(deps(), broken.projectId, { kind: 'compile' })
    // Manifeste de la version précédente perdu : chaque essai échoue.
    const previous = await ProjectVersion.findByOrFail('projectId', broken.projectId)
    await storage.deletePrefix(previous.s3Prefix)
    await edit(broken.projectId, broken.mainId, owner.id, 'Changé')

    assert.equal(await sweepDueVersions(deps(), later(3)), 1)
    assert.lengthOf(await ProjectVersion.query().where('projectId', healthy.projectId), 1)
    const due = (now: DateTime) => dueProjectIds({ now, idleSeconds: 120 })
    assert.notInclude(await due(later(4)), broken.projectId)
    // Nouvel essai après le délai.
    assert.include(await due(later(3 + 11)), broken.projectId)
  })

  test('lists the authors of a version and attributes each change to its author', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const { projectId, mainId, introId } = await setupProject(client, owner)
    await createVersion(deps(), projectId, { kind: 'compile' })
    const editor = await addMember(projectId, 'editor')
    const reviewer = await addMember(projectId, 'reviewer')

    await edit(projectId, mainId, editor.id, '\\documentclass{article}\nBonjour à tous')
    await edit(projectId, mainId, owner.id, '\\documentclass{article}\n% Préambule\nBonjour à tous')
    await edit(projectId, introId, owner.id, 'Introduction révisée')
    const result = await createVersion(deps(), projectId, { kind: 'compile', actorId: owner.id })
    assert.isTrue(result?.created)
    const versionId = result?.version.id ?? ''

    const list = await client.get(`/api/v1/projects/${projectId}/versions`).loginAs(reviewer)
    list.assertStatus(200)
    const page = versionListResponseSchema.parse(list.body())
    assert.lengthOf(page.versions, 2)
    assert.equal(page.versions[0]?.id, versionId)
    assert.sameMembers(page.versions[0]?.authorIds ?? [], [editor.id, owner.id])
    assert.sameMembers(page.versions[0]?.changedDocumentIds ?? [], [mainId, introId])
    assert.equal(page.retentionDays, 1)
    assert.includeMembers(
      page.authors.map((author) => author.id),
      [editor.id, owner.id],
    )

    const diff = await client
      .get(`/api/v1/projects/${projectId}/versions/${versionId}/documents/${mainId}/diff`)
      .loginAs(reviewer)
    diff.assertStatus(200)
    assert.deepEqual(documentDiffResponseSchema.parse(diff.body()).segments, [
      { op: 'equal', text: '\\documentclass{article}\n', authorId: null },
      { op: 'insert', text: '% Préambule\n', authorId: owner.id },
      { op: 'equal', text: 'Bonjour', authorId: null },
      { op: 'insert', text: ' à tous', authorId: editor.id },
    ])

    const detail = versionDetailSchema.parse(
      (
        await client.get(`/api/v1/projects/${projectId}/versions/${versionId}`).loginAs(reviewer)
      ).body(),
    )
    const statuses = Object.fromEntries(detail.entries.map((entry) => [entry.path, entry.status]))
    assert.deepEqual(statuses, {
      'main.tex': 'modified',
      'chapters/intro.tex': 'modified',
      'figs/plot.png': 'unchanged',
    })
    assert.sameMembers(detail.folders, ['chapters', 'figs', 'empty'])
  })

  test('restores exactly the text, the images and the tree, after saving the current state', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const editor = await createUser()
    const { projectId, mainId, introId, fileId } = await setupProject(client, owner)
    await ProjectMember.create({ projectId, userId: editor.id, role: 'editor' })
    const first = await createVersion(deps(), projectId, { kind: 'compile' })
    const original = await snapshotTree(projectId)

    // Modifications : texte, document et image supprimés, nouveau document, renommage, dossier.
    await edit(projectId, mainId, editor.id, 'Tout réécrit')
    ;(
      await client
        .delete(`/api/v1/projects/${projectId}/entities/document/${introId}`)
        .loginAs(editor)
    ).assertStatus(204)
    ;(
      await client.delete(`/api/v1/projects/${projectId}/entities/file/${fileId}`).loginAs(editor)
    ).assertStatus(204)
    // L'objet de l'image reste : la version le référence.
    assert.equal(await storage.size(fileKey(projectId, fileId)), PNG.length)
    const extra = await client
      .post(`/api/v1/projects/${projectId}/documents`)
      .json({ name: 'extra.tex', folderId: null, content: 'En plus' })
      .loginAs(editor)
    await client
      .patch(`/api/v1/projects/${projectId}/entities/document/${mainId}`)
      .json({ name: 'these.tex' })
      .loginAs(editor)
    await client
      .post(`/api/v1/projects/${projectId}/folders`)
      .json({ name: 'neuf' })
      .loginAs(editor)

    const restored = await client
      .post(`/api/v1/projects/${projectId}/versions/${first?.version.id ?? ''}/restore`)
      .json({ scope: 'project' })
      .loginAs(editor)
    restored.assertStatus(200)
    const response = restoreVersionResponseSchema.parse(restored.body())

    const after = await snapshotTree(projectId)
    assert.sameDeepMembers(after.documents, original.documents)
    assert.sameDeepMembers(after.files, original.files)
    assert.deepEqual(after.folders, original.folders)
    assert.equal(after.mainDocumentId, original.mainDocumentId)
    // L'image recréée avec son identifiant pointe sur le même objet, identique.
    const image = await File.findOrFail(fileId)
    assert.equal(image.sha256, sha256(PNG))
    assert.deepEqual(Buffer.concat(await (await storage.read(image.s3Key)).toArray()), PNG)
    // Texte du document existant : remplacé par le service temps réel, au nom de l'éditeur.
    assert.deepEqual(
      realtime.replaced.map((entry) => [entry.documentId, entry.request.userId]),
      [[mainId, editor.id]],
    )
    assert.isTrue(
      realtime.events.some((event) => event.type === 'tree.changed' && event.reason === 'restore'),
    )

    // Rien n'est perdu : la version créée avant la restauration contient l'état remplacé.
    const backup = await ProjectVersion.findOrFail(response.backupVersionId)
    assert.equal(backup.kind, 'restore')
    const backupDetail = versionDetailSchema.parse(
      (
        await client.get(`/api/v1/projects/${projectId}/versions/${backup.id}`).loginAs(editor)
      ).body(),
    )
    const extraId = extra.body().document.id as string
    assert.isTrue(
      backupDetail.entries.some((entry) => entry.id === extraId && entry.status === 'added'),
    )
    ;(
      await client
        .post(`/api/v1/projects/${projectId}/versions/${backup.id}/restore`)
        .json({ scope: 'project' })
        .loginAs(editor)
    ).assertStatus(200)
    assert.equal(await textOf(extraId), 'En plus')
    assert.equal(await textOf(mainId), 'Tout réécrit')
    assert.isNull(await File.find(fileId))
  })

  test('restores a single deleted file at its path, replacing what took it since', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const { projectId, introId, fileId } = await setupProject(client, owner)
    const version = await createVersion(deps(), projectId, { kind: 'compile' })
    const versionId = version?.version.id ?? ''
    ;(
      await client
        .delete(`/api/v1/projects/${projectId}/entities/document/${introId}`)
        .loginAs(owner)
    ).assertStatus(204)
    ;(
      await client.delete(`/api/v1/projects/${projectId}/entities/file/${fileId}`).loginAs(owner)
    ).assertStatus(204)

    ;(
      await client
        .post(`/api/v1/projects/${projectId}/versions/${versionId}/restore`)
        .json({ scope: 'entry', entryId: fileId })
        .loginAs(owner)
    ).assertStatus(200)
    assert.equal((await File.findOrFail(fileId)).name, 'plot.png')

    // Document recréé depuis au même chemin : remplacé, et gardé dans la version de sauvegarde.
    const tree = await buildTree(projectId)
    const chapters = tree.folders.find((folder) => folder.path === 'chapters')
    const other = await client
      .post(`/api/v1/projects/${projectId}/documents`)
      .json({ name: 'intro.tex', folderId: chapters?.id ?? null, content: 'Autre' })
      .loginAs(owner)
    const otherId = other.body().document.id as string
    const replaced = await client
      .post(`/api/v1/projects/${projectId}/versions/${versionId}/restore`)
      .json({ scope: 'entry', entryId: introId })
      .loginAs(owner)
    replaced.assertStatus(200)
    assert.equal(await textOf(introId), 'Introduction')
    assert.isNull(await Document.find(otherId))
    const backup = versionDetailSchema.parse(
      (
        await client
          .get(
            `/api/v1/projects/${projectId}/versions/${restoreVersionResponseSchema.parse(replaced.body()).backupVersionId}`,
          )
          .loginAs(owner)
      ).body(),
    )
    assert.isTrue(backup.entries.some((entry) => entry.id === otherId))

    // Image remplacée par une autre image au même chemin, puis restaurée.
    ;(
      await client.delete(`/api/v1/projects/${projectId}/entities/file/${fileId}`).loginAs(owner)
    ).assertStatus(204)
    const figs = tree.folders.find((folder) => folder.path === 'figs')
    const newFileId = randomUUID()
    await File.create({
      id: newFileId,
      projectId,
      folderId: figs?.id ?? null,
      name: 'plot.png',
      s3Key: fileKey(projectId, newFileId),
      sha256: sha256(PNG),
      sizeBytes: PNG.length,
      mimeType: 'image/png',
    })
    ;(
      await client
        .post(`/api/v1/projects/${projectId}/versions/${versionId}/restore`)
        .json({ scope: 'entry', entryId: fileId })
        .loginAs(owner)
    ).assertStatus(200)
    assert.isNotNull(await File.find(fileId))
    assert.isNull(await File.find(newFileId))

    // Un dossier au même chemin n'est pas remplacé : 409.
    ;(
      await client.delete(`/api/v1/projects/${projectId}/entities/file/${fileId}`).loginAs(owner)
    ).assertStatus(204)
    await client
      .post(`/api/v1/projects/${projectId}/folders`)
      .json({ name: 'plot.png', parentId: figs?.id ?? null })
      .loginAs(owner)
    const taken = await client
      .post(`/api/v1/projects/${projectId}/versions/${versionId}/restore`)
      .json({ scope: 'entry', entryId: fileId })
      .loginAs(owner)
    taken.assertStatus(409)
    assert.equal(taken.body().code, 'E_RESTORE_PATH_TAKEN')
    ;(
      await client
        .post(`/api/v1/projects/${projectId}/versions/${versionId}/restore`)
        .json({ scope: 'entry', entryId: randomUUID() })
        .loginAs(owner)
    ).assertStatus(404)
  })

  test('refuses the restore when the realtime service cannot apply the text', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const { projectId, mainId } = await setupProject(client, owner)
    const version = await createVersion(deps(), projectId, { kind: 'compile' })
    await edit(projectId, mainId, owner.id, 'Récent')
    realtime.unavailable = true
    const response = await client
      .post(`/api/v1/projects/${projectId}/versions/${version?.version.id ?? ''}/restore`)
      .json({ scope: 'project' })
      .loginAs(owner)
    response.assertStatus(503)
    assert.equal(await textOf(mainId), 'Récent')
  })

  test('puts back the texts already replaced when the restore fails midway', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const { projectId, mainId, introId } = await setupProject(client, owner)
    const version = await createVersion(deps(), projectId, { kind: 'compile' })
    const versionId = version?.version.id ?? ''
    await edit(projectId, mainId, owner.id, 'Récent')
    await edit(projectId, introId, owner.id, 'Intro récente')

    // Deuxième texte refusé : le premier est remis dans son état d'avant.
    realtime.failingCalls = new Set([2])
    const failed = await client
      .post(`/api/v1/projects/${projectId}/versions/${versionId}/restore`)
      .json({ scope: 'project' })
      .loginAs(owner)
    failed.assertStatus(503)
    assert.equal(failed.body().code, 'E_HISTORY_REALTIME_UNAVAILABLE')
    assert.equal(await textOf(mainId), 'Récent')
    assert.equal(await textOf(introId), 'Intro récente')

    // La remise en état échoue aussi : l'erreur dit que le projet est partiellement restauré.
    realtime.failingCalls = new Set([5, 6])
    const incomplete = await client
      .post(`/api/v1/projects/${projectId}/versions/${versionId}/restore`)
      .json({ scope: 'project' })
      .loginAs(owner)
    incomplete.assertStatus(503)
    assert.equal(incomplete.body().code, 'E_HISTORY_RESTORE_INCOMPLETE')
    // Relancée, la restauration se termine.
    realtime.failingCalls = new Set()
    ;(
      await client
        .post(`/api/v1/projects/${projectId}/versions/${versionId}/restore`)
        .json({ scope: 'project' })
        .loginAs(owner)
    ).assertStatus(200)
    assert.equal(await textOf(mainId), '\\documentclass{article}\nBonjour')
    assert.equal(await textOf(introId), 'Introduction')
  })

  test('applies the storage limit of the owner plan to what a restore recreates', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const { projectId, mainId, introId, fileId } = await setupProject(client, owner)
    const version = await createVersion(deps(), projectId, { kind: 'compile' })
    const versionId = version?.version.id ?? ''
    ;(
      await client
        .delete(`/api/v1/projects/${projectId}/entities/document/${introId}`)
        .loginAs(owner)
    ).assertStatus(204)
    ;(
      await client.delete(`/api/v1/projects/${projectId}/entities/file/${fileId}`).loginAs(owner)
    ).assertStatus(204)
    await edit(projectId, mainId, owner.id, 'Récent')
    // Stockage Free (500 Mio) rempli par un autre projet du même propriétaire.
    const other = await client.post('/api/v1/projects').json({ name: 'Autre' }).loginAs(owner)
    const big = await File.create({
      projectId: other.body().project.id as string,
      folderId: null,
      name: 'big.pdf',
      s3Key: `projects/${randomUUID()}/files/${randomUUID()}`,
      sha256: 'a'.repeat(64),
      sizeBytes: 500 * 1024 * 1024,
      mimeType: 'application/pdf',
    })

    // Document et image à recréer : refus du plan, rien n'est modifié (textes compris).
    const refused = await client
      .post(`/api/v1/projects/${projectId}/versions/${versionId}/restore`)
      .json({ scope: 'project' })
      .loginAs(owner)
    refused.assertStatus(403)
    assert.equal(refused.body().code, 'E_PLAN_LIMIT')
    assert.equal(refused.body().limit.name, 'storage')
    assert.isNull(await Document.find(introId))
    assert.isNull(await File.find(fileId))
    assert.equal(await textOf(mainId), 'Récent')
    assert.isFalse(
      realtime.events.some((event) => event.type === 'tree.changed' && event.reason === 'restore'),
    )

    // Place libérée : la restauration passe et l'arborescence est annoncée après la validation.
    await big.delete()
    ;(
      await client
        .post(`/api/v1/projects/${projectId}/versions/${versionId}/restore`)
        .json({ scope: 'project' })
        .loginAs(owner)
    ).assertStatus(200)
    assert.equal(await textOf(introId), 'Introduction')
    assert.isNotNull(await File.find(fileId))
    assert.isTrue(
      realtime.events.some((event) => event.type === 'tree.changed' && event.reason === 'restore'),
    )
  })

  test('lets every member read, but only editors and the owner label and restore', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const { projectId } = await setupProject(client, owner)
    const version = await createVersion(deps(), projectId, { kind: 'compile' })
    const versionId = version?.version.id ?? ''
    const viewer = await addMember(projectId, 'viewer')
    const reviewer = await addMember(projectId, 'reviewer')
    const editor = await addMember(projectId, 'editor')
    const stranger = await createUser()

    ;(await client.get(`/api/v1/projects/${projectId}/versions`).loginAs(viewer)).assertStatus(200)
    ;(await client.get(`/api/v1/projects/${projectId}/versions`).loginAs(stranger)).assertStatus(
      404,
    )
    for (const user of [viewer, reviewer]) {
      ;(
        await client
          .patch(`/api/v1/projects/${projectId}/versions/${versionId}`)
          .json({ label: 'Soumission' })
          .loginAs(user)
      ).assertStatus(403)
      ;(
        await client
          .post(`/api/v1/projects/${projectId}/versions/${versionId}/restore`)
          .json({ scope: 'project' })
          .loginAs(user)
      ).assertStatus(403)
    }
    const labelled = await client
      .patch(`/api/v1/projects/${projectId}/versions/${versionId}`)
      .json({ label: '  Soumission  ' })
      .loginAs(editor)
    labelled.assertStatus(200)
    assert.equal(labelled.body().version.label, 'Soumission')
    ;(
      await client.get(`/api/v1/projects/${projectId}/versions/${randomUUID()}`).loginAs(viewer)
    ).assertStatus(404)
  })

  test('downloads a version as a zip, from the API or a short link', async ({ client, assert }) => {
    const owner = await createUser()
    const { projectId, mainId } = await setupProject(client, owner)
    const version = await createVersion(deps(), projectId, { kind: 'compile' })
    const versionId = version?.version.id ?? ''
    await edit(projectId, mainId, owner.id, 'Plus tard')

    const response = await client
      .get(`/api/v1/projects/${projectId}/versions/${versionId}/download.zip`)
      .loginAs(owner)
    response.assertStatus(200)
    const path = join(tmpdir(), `kaxolax-version-${versionId}.zip`)
    await writeFile(path, response.body() as Buffer)
    try {
      const stored = new Map<string, Buffer>()
      const plan = await importZip(path, async ({ path: file, body }) => {
        stored.set(file, Buffer.concat(await body.toArray()))
        return file
      })
      assert.sameMembers(plan.folders, ['chapters', 'figs', 'empty'])
      assert.sameDeepMembers(
        plan.documents.map(({ path: file, content }) => ({ file, content })),
        [
          { file: 'main.tex', content: '\\documentclass{article}\nBonjour' },
          { file: 'chapters/intro.tex', content: 'Introduction' },
        ],
      )
      assert.deepEqual(stored.get('figs/plot.png'), PNG)
    } finally {
      await rm(path, { force: true })
    }

    const link = await client
      .post(`/api/v1/projects/${projectId}/versions/${versionId}/download-url`)
      .loginAs(owner)
    link.assertStatus(200)
    const downloaded = await client.get(link.body().url as string)
    downloaded.assertStatus(200)
    assert.equal(downloaded.header('content-type'), 'application/zip')
  })

  test('purges versions past the plan retention, never a labelled or the latest one', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const { projectId, mainId, fileId } = await setupProject(client, owner)
    const old = await createVersion(deps(), projectId, { kind: 'compile' })
    await edit(projectId, mainId, owner.id, 'Deuxième')
    const labelled = await createVersion(deps(), projectId, { kind: 'compile' })
    await ProjectVersion.query()
      .where('id', labelled?.version.id ?? '')
      .update({ label: 'Gardée' })
    await edit(projectId, mainId, owner.id, 'Troisième')
    // L'image quitte l'arborescence : seules les deux premières versions la référencent.
    ;(
      await client.delete(`/api/v1/projects/${projectId}/entities/file/${fileId}`).loginAs(owner)
    ).assertStatus(204)
    const middle = await createVersion(deps(), projectId, { kind: 'compile' })
    await edit(projectId, mainId, owner.id, 'Dernière')
    const latest = await createVersion(deps(), projectId, { kind: 'compile' })
    // Tout a plus de deux jours (plan Free : un jour d'historique).
    await ProjectVersion.query()
      .where('projectId', projectId)
      .update({ createdAt: DateTime.utc().minus({ days: 2 }).toJSDate() })
    const firstText = historyTextKey(projectId, sha256('\\documentclass{article}\nBonjour'))
    const middleText = historyTextKey(projectId, sha256('Troisième'))
    assert.isNotNull(await storage.size(firstText))

    assert.equal(await purgeExpiredHistory(storage), 2)
    const remaining = (await ProjectVersion.query().where('projectId', projectId)).map(
      (version) => version.id,
    )
    assert.sameMembers(remaining, [labelled?.version.id ?? '', latest?.version.id ?? ''])
    assert.notInclude(remaining, old?.version.id ?? '')
    assert.notInclude(remaining, middle?.version.id ?? '')
    // Texte de la seule version purgée qui l'avait : supprimé ; l'image, toujours référencée par
    // la version avec label : gardée.
    assert.isNull(await storage.size(middleText))
    assert.equal(await storage.size(fileKey(projectId, fileId)), PNG.length)

    // Plus de version qui référence l'image : son objet part avec la purge.
    await ProjectVersion.query()
      .where('id', labelled?.version.id ?? '')
      .update({ label: null })
    await edit(projectId, mainId, owner.id, 'Encore')
    await createVersion(deps(), projectId, { kind: 'compile' })
    assert.equal(await purgeExpiredHistory(storage), 2)
    assert.isNull(await storage.size(fileKey(projectId, fileId)))
  })

  test('commits the purge before touching the storage: a storage failure never loses a text', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const { projectId, mainId } = await setupProject(client, owner)
    const original = '\\documentclass{article}\nBonjour'
    await createVersion(deps(), projectId, { kind: 'compile' })
    await edit(projectId, mainId, owner.id, 'Deuxième')
    await createVersion(deps(), projectId, { kind: 'compile' })
    // Retour au texte d'origine : la dernière version cite le texte de la première.
    await edit(projectId, mainId, owner.id, original)
    const latest = await createVersion(deps(), projectId, { kind: 'compile' })
    await ProjectVersion.query()
      .where('projectId', projectId)
      .update({ createdAt: DateTime.utc().minus({ days: 2 }).toJSDate() })

    class FailingStorage extends ObjectStorage {
      override deletePrefix(): Promise<void> {
        return Promise.reject(new Error('storage unavailable'))
      }
    }
    await assert.rejects(() => purgeProjectHistory(new FailingStorage(), projectId, 1))
    const remaining = await ProjectVersion.query().where('projectId', projectId)
    assert.deepEqual(
      remaining.map((version) => version.id),
      [latest?.version.id ?? ''],
    )
    assert.isNotNull(await storage.size(historyTextKey(projectId, sha256(original))))

    // Texte supprimé avec les versions purgées : réécrit par la version suivante qui le cite.
    await edit(projectId, mainId, owner.id, 'Deuxième')
    await createVersion(deps(), projectId, { kind: 'compile' })
    assert.isNotNull(await storage.size(historyTextKey(projectId, sha256('Deuxième'))))
  })

  test('keeps the last text of a deleted document shown by a kept version', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const { projectId, introId } = await setupProject(client, owner)
    await createVersion(deps(), projectId, { kind: 'compile' })
    ;(
      await client
        .delete(`/api/v1/projects/${projectId}/entities/document/${introId}`)
        .loginAs(owner)
    ).assertStatus(204)
    const latest = await createVersion(deps(), projectId, { kind: 'compile' })
    const latestId = latest?.version.id ?? ''
    await ProjectVersion.query()
      .where('projectId', projectId)
      .update({ createdAt: DateTime.utc().minus({ days: 2 }).toJSDate() })

    // La première version (seule à contenir le document) part ; la dernière le montre supprimé.
    assert.equal(await purgeExpiredHistory(storage), 1)
    assert.isNotNull(await storage.size(historyTextKey(projectId, sha256('Introduction'))))
    const diff = await client
      .get(`/api/v1/projects/${projectId}/versions/${latestId}/documents/${introId}/diff`)
      .loginAs(owner)
    diff.assertStatus(200)
    assert.deepEqual(documentDiffResponseSchema.parse(diff.body()).segments, [
      { op: 'delete', text: 'Introduction', authorId: null },
    ])
  })

  test('deletes the object of an unversioned binary removed from the tree', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const created = await client.post('/api/v1/projects').json({ name: 'P' }).loginAs(owner)
    const projectId = created.body().project.id as string
    const fileId = randomUUID()
    await storage.putBuffer(fileKey(projectId, fileId), PNG, 'image/png')
    await File.create({
      id: fileId,
      projectId,
      folderId: null,
      name: 'loose.png',
      s3Key: fileKey(projectId, fileId),
      sha256: sha256(PNG),
      sizeBytes: PNG.length,
      mimeType: 'image/png',
    })
    ;(
      await client.delete(`/api/v1/projects/${projectId}/entities/file/${fileId}`).loginAs(owner)
    ).assertStatus(204)
    assert.isNull(await storage.size(fileKey(projectId, fileId)))
  })
})

/**
 * Sans transaction globale : deux créations concurrentes utilisent deux connexions, comme deux
 * instances de l'API (les données restent jusqu'au retour arrière des migrations en fin de suite).
 */
test.group('history across instances', (group) => {
  group.each.setup(() => {
    realtime = new FakeRealtime()
    app.container.swap(RealtimeClient, () => realtime)
    return () => {
      app.container.restore(RealtimeClient)
    }
  })

  test('creates a single automatic version when two sweeps run at the same time', async ({
    client,
    assert,
  }) => {
    const owner = await createUser()
    const { projectId } = await setupProject(client, owner)
    const due = { now: later(3), idleSeconds: 120 }
    const results = await Promise.all([
      createVersion(deps(), projectId, { kind: 'auto', due }),
      createVersion(deps(), projectId, { kind: 'auto', due }),
      sweepDueVersions(deps(), due.now),
    ])
    const created =
      results.slice(0, 2).filter((result) => typeof result === 'object' && result?.created).length +
      (typeof results[2] === 'number' ? results[2] : 0)
    assert.equal(created, 1)
    assert.lengthOf(await ProjectVersion.query().where('projectId', projectId), 1)
  })
})
