import { createHash, randomUUID } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { type AddressInfo } from 'node:net'
import { readDocumentText } from '@kaxolax/collab'
import {
  planLimitErrorSchema,
  TEMPLATE_ERRORS,
  templateListResponseSchema,
  templateResponseSchema,
} from '@kaxolax/contracts'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import yazl from 'yazl'
import templatesConfig from '#config/templates'
import Document from '#models/document'
import File from '#models/file'
import Project from '#models/project'
import Workspace from '#models/workspace'
import { resetTemplateCatalogCache } from '#services/template_catalog'
import { createUser } from '#tests/helpers'

const MIB = 1024 * 1024
const FREE_STORAGE = 500 * MIB

async function zip(entries: Record<string, string>): Promise<Buffer> {
  const archive = new yazl.ZipFile()
  for (const [name, content] of Object.entries(entries)) {
    archive.addBuffer(Buffer.from(content), name)
  }
  archive.end()
  const chunks: Buffer[] = []
  for await (const chunk of archive.outputStream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

const sha256 = (content: Buffer) => createHash('sha256').update(content).digest('hex')

/** Fichier publié par le faux bucket : contenu servi et entrée du catalogue (taille, sha256). */
function published(path: string, content: Buffer) {
  return { path, bytes: content.length, sha256: sha256(content) }
}

/**
 * Faux bucket public R2 (serveur HTTP local) : `templates.json` avec ETag (304 sur requête
 * conditionnelle) et fichiers des templates. Compte les requêtes par chemin.
 */
class FakeBucket {
  files = new Map<string, Buffer>()
  catalog: unknown = null
  /** Corps brut servi à la place du catalogue (JSON invalide…). */
  rawCatalog: string | null = null
  catalogStatus = 200
  hits = new Map<string, number>()
  conditional = 0
  server: Server = createServer((request, response) => {
    this.handle(request, response)
  })

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return `http://127.0.0.1:${String((this.server.address() as AddressInfo).port)}/v1`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) =>
      this.server.close(() => {
        resolve()
      }),
    )
  }

  hitsOn(path: string): number {
    return this.hits.get(path) ?? 0
  }

  private handle(request: IncomingMessage, response: ServerResponse) {
    const url = new URL(request.url ?? '/', 'http://bucket')
    const path = url.pathname.replace(/^\/v1\//, '')
    this.hits.set(path, this.hitsOn(path) + 1)
    if (path === 'templates.json') {
      const body = this.rawCatalog ?? JSON.stringify(this.catalog)
      const etag = `"${sha256(Buffer.from(body)).slice(0, 16)}"`
      if (request.headers['if-none-match'] === etag) {
        this.conditional++
        response.writeHead(304, { etag }).end()
        return
      }
      response.writeHead(this.catalogStatus, { 'content-type': 'application/json', etag })
      response.end(body)
      return
    }
    const file = this.files.get(path)
    if (!file) {
      response.writeHead(404).end()
      return
    }
    response.writeHead(200, { 'content-type': 'application/octet-stream' }).end(file)
  }
}

/** Template du faux catalogue : `report.tex` désigné comme document principal, en LuaLaTeX. */
async function seedBucket(bucket: FakeBucket) {
  const archive = await zip({
    'main.tex': '\\documentclass{article}\n\\begin{document}\nBrouillon.\n\\end{document}\n',
    'report.tex':
      '\\documentclass{report}\n\\begin{document}\n\\input{chapters/intro}\n\\end{document}\n',
    'chapters/intro.tex': '\\chapter{Introduction}\nBonjour.\n',
  })
  const pdf = Buffer.from('%PDF-1.7 template')
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const files = {
    pdf: published('rapport-lua/rapport-lua.pdf', pdf),
    thumbnail: { ...published('rapport-lua/rapport-lua.png', png), width: 600, height: 849 },
    zip: published('rapport-lua/rapport-lua.zip', archive),
  }
  bucket.files.set(files.pdf.path, pdf)
  bucket.files.set(files.thumbnail.path, png)
  bucket.files.set(files.zip.path, archive)
  bucket.catalog = {
    version: 1,
    generatedAt: '2026-10-01T18:27:20Z',
    source: { commit: '0123456789abcdef0123456789abcdef01234567', texliveImage: 'texlive:2026' },
    templates: [
      {
        id: 'rapport-lua',
        title: 'Rapport en LuaLaTeX',
        category: 'rapport',
        description: 'Rapport de démonstration pour les tests de la galerie.',
        compiler: 'lualatex',
        license: 'CC0-1.0',
        mainDocument: 'report.tex',
        tags: ['rapport', 'lua'],
        language: 'fr',
        files,
        // Champ inconnu d'une version ultérieure du dépôt : ignoré.
        addedLater: true,
      },
    ],
  }
  return { archive, files }
}

const saved = { ...templatesConfig }
let bucket: FakeBucket

test.group('templates: local fixture catalog', (group) => {
  group.each.setup(() => {
    resetTemplateCatalogCache()
    return () => {
      Object.assign(templatesConfig, saved)
      resetTemplateCatalogCache()
    }
  })

  test('serves the ten starter templates without an account', async ({ client, assert }) => {
    const response = await client.get('/api/v1/templates')
    response.assertStatus(200)
    assert.include(response.header('cache-control') ?? '', 'max-age=60')
    const body = templateListResponseSchema.parse(response.body())
    assert.lengthOf(body.templates, 10)
    assert.deepEqual(
      body.categories.map((category) => [category.id, category.count]),
      [
        ['cv', 2],
        ['these', 1],
        ['article', 2],
        ['presentation', 2],
        ['lettre', 1],
        ['rapport', 2],
      ],
    )
    // Fichiers non publiés en local : pas d'URL.
    assert.isNull(body.templates[0]?.thumbnail.url)
  })

  test('searches and filters, and refuses unknown filters', async ({ client, assert }) => {
    const search = await client.get('/api/v1/templates').qs({ q: 'thèse' })
    assert.deepEqual(
      templateListResponseSchema.parse(search.body()).templates.map((template) => template.id),
      ['these-doctorat'],
    )
    const beamer = await client.get('/api/v1/templates').qs({ category: 'presentation' })
    const body = templateListResponseSchema.parse(beamer.body())
    assert.sameMembers(
      body.templates.map((template) => template.id),
      ['presentation-metropolis', 'presentation-sobre'],
    )
    assert.equal(body.categories.find((category) => category.id === 'cv')?.count, 2)
    const english = await client.get('/api/v1/templates').qs({ language: 'en' })
    assert.deepEqual(
      templateListResponseSchema.parse(english.body()).templates.map((template) => template.id),
      ['article-deux-colonnes'],
    )
    ;(await client.get('/api/v1/templates').qs({ category: 'poster' })).assertStatus(422)

    const one = await client.get('/api/v1/templates/cv-moderne')
    one.assertStatus(200)
    assert.include(templateResponseSchema.parse(one.body()).template, {
      id: 'cv-moderne',
      compiler: 'xelatex',
    })
    const missing = await client.get('/api/v1/templates/nope')
    missing.assertStatus(404)
    missing.assertBodyContains({ code: TEMPLATE_ERRORS.notFound })
  })

  test('fails cleanly without a catalog nor a fixture', async ({ client }) => {
    templatesConfig.fixturePath = null
    const response = await client.get('/api/v1/templates')
    response.assertStatus(503)
    response.assertBodyContains({ code: TEMPLATE_ERRORS.catalogUnavailable })
  })

  test('refuses to create a project from unpublished files', async ({ client }) => {
    const user = await createUser()
    const response = await client
      .post('/api/v1/projects/from-template')
      .json({ templateId: 'cv-moderne' })
      .loginAs(user)
    response.assertStatus(503)
    response.assertBodyContains({ code: TEMPLATE_ERRORS.catalogUnavailable })
  })
})

test.group('templates: published catalog', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())
  group.each.setup(async () => {
    bucket = new FakeBucket()
    const base = await bucket.start()
    templatesConfig.catalogUrl = `${base}/templates.json`
    templatesConfig.publicUrl = `${base}/`
    resetTemplateCatalogCache()
    return async () => {
      Object.assign(templatesConfig, saved)
      resetTemplateCatalogCache()
      await bucket.stop()
    }
  })

  test('builds public URLs and revalidates the cached catalog', async ({ client, assert }) => {
    const { files } = await seedBucket(bucket)
    const first = await client.get('/api/v1/templates')
    first.assertStatus(200)
    const [template] = templateListResponseSchema.parse(first.body()).templates
    assert.equal(
      template?.thumbnail.url,
      `${templatesConfig.publicUrl ?? ''}rapport-lua/rapport-lua.png?v=${files.thumbnail.sha256.slice(0, 12)}`,
    )
    assert.equal(template?.pdf.bytes, files.pdf.bytes)
    assert.equal(template?.zipBytes, files.zip.bytes)
    assert.notProperty(template ?? {}, 'addedLater')
    assert.notProperty(template ?? {}, 'files')

    // Copie fraîche : aucune nouvelle requête.
    await client.get('/api/v1/templates/rapport-lua')
    assert.equal(bucket.hitsOn('templates.json'), 1)

    // Copie expirée : requête conditionnelle, 304, catalogue gardé.
    templatesConfig.freshMs = 0
    ;(await client.get('/api/v1/templates')).assertStatus(200)
    assert.equal(bucket.hitsOn('templates.json'), 2)
    assert.equal(bucket.conditional, 1)
  })

  test('keeps serving the last valid catalog when the new one is invalid', async ({
    client,
    assert,
  }) => {
    await seedBucket(bucket)
    ;(await client.get('/api/v1/templates')).assertStatus(200)
    templatesConfig.freshMs = 0
    templatesConfig.retryMs = 0
    bucket.rawCatalog = JSON.stringify({ version: 2, templates: [] })
    const stale = await client.get('/api/v1/templates')
    stale.assertStatus(200)
    assert.lengthOf(templateListResponseSchema.parse(stale.body()).templates, 1)

    // Sans copie valide en mémoire : 503.
    resetTemplateCatalogCache()
    const failed = await client.get('/api/v1/templates')
    failed.assertStatus(503)
    failed.assertBodyContains({ code: TEMPLATE_ERRORS.catalogUnavailable })
    bucket.rawCatalog = '{not json'
    ;(await client.get('/api/v1/templates')).assertStatus(503)
    bucket.rawCatalog = null
    bucket.catalogStatus = 500
    ;(await client.get('/api/v1/templates')).assertStatus(503)
  })

  test('waits before retrying an unreachable catalog, even without a cached copy', async ({
    client,
    assert,
  }) => {
    await seedBucket(bucket)
    templatesConfig.retryMs = 60_000
    bucket.catalogStatus = 500
    ;(await client.get('/api/v1/templates')).assertStatus(503)
    assert.equal(bucket.hitsOn('templates.json'), 1)
    // Bucket rétabli, mais délai entre deux essais non écoulé : 503 sans nouvelle requête.
    bucket.catalogStatus = 200
    ;(await client.get('/api/v1/templates')).assertStatus(503)
    ;(await client.get('/api/v1/templates/rapport-lua')).assertStatus(503)
    assert.equal(bucket.hitsOn('templates.json'), 1)
  })

  test('refuses a catalog whose paths leave the public base', async ({ client, assert }) => {
    const { files } = await seedBucket(bucket)
    const user = await createUser()
    for (const path of ['http:169.254.169.254', 'javascript:alert(1)%2F%2F']) {
      resetTemplateCatalogCache()
      bucket.catalog = {
        ...(bucket.catalog as Record<string, unknown>),
        templates: [
          {
            ...(bucket.catalog as { templates: Record<string, unknown>[] }).templates[0],
            files: { ...files, zip: { ...files.zip, path } },
          },
        ],
      }
      const listed = await client.get('/api/v1/templates')
      listed.assertStatus(503)
      listed.assertBodyContains({ code: TEMPLATE_ERRORS.catalogUnavailable })
      ;(
        await client
          .post('/api/v1/projects/from-template')
          .json({ templateId: 'rapport-lua' })
          .loginAs(user)
      ).assertStatus(503)
    }
    // Le zip n'a jamais été demandé.
    assert.equal(bucket.hitsOn(files.zip.path), 0)
  })

  test('creates a project from a template, with the compiler and main document of the catalog', async ({
    client,
    assert,
  }) => {
    await seedBucket(bucket)
    const user = await createUser()
    ;(
      await client.post('/api/v1/projects/from-template').json({ templateId: 'rapport-lua' })
    ).assertStatus(401)

    const response = await client
      .post('/api/v1/projects/from-template')
      .json({ templateId: 'rapport-lua', name: '  Mon rapport  ' })
      .loginAs(user)
    response.assertStatus(201)
    response.assertBodyContains({
      project: { name: 'Mon rapport', compiler: 'lualatex', role: 'owner' },
    })
    const projectId = String(response.body().project.id)
    const project = await Project.findOrFail(projectId)
    const personal = await Workspace.query().where({ ownerId: user.id, type: 'personal' }).first()
    assert.equal(project.workspaceId, personal?.id)
    assert.equal(project.ownerId, user.id)

    const tree = await client.get(`/api/v1/projects/${projectId}/tree`).loginAs(user)
    const body = tree.body() as {
      mainDocumentId: string
      documents: { id: string; path: string }[]
    }
    assert.sameMembers(
      body.documents.map((document) => document.path),
      ['main.tex', 'report.tex', 'chapters/intro.tex'],
    )
    // L'import aurait retenu main.tex : le catalogue désigne report.tex.
    assert.equal(
      body.mainDocumentId,
      body.documents.find((document) => document.path === 'report.tex')?.id,
    )
    const intro = await Document.query().where({ projectId, name: 'intro.tex' }).firstOrFail()
    assert.equal(
      readDocumentText(new Uint8Array(intro.yjsState ?? Buffer.alloc(0))),
      '\\chapter{Introduction}\nBonjour.\n',
    )

    // Sans nom : titre du template ; dans un workspace donné (le sien).
    const named = await client
      .post('/api/v1/projects/from-template')
      .json({ templateId: 'rapport-lua', workspaceId: personal?.id })
      .loginAs(user)
    named.assertStatus(201)
    named.assertBodyContains({ project: { name: 'Rapport en LuaLaTeX' } })
  })

  test("refuses another user's workspace, unknown templates and invalid bodies", async ({
    client,
    assert,
  }) => {
    await seedBucket(bucket)
    const user = await createUser()
    const other = await createUser()
    const otherWorkspace = await Workspace.query()
      .where({ ownerId: other.id, type: 'personal' })
      .firstOrFail()
    ;(
      await client
        .post('/api/v1/projects/from-template')
        .json({ templateId: 'rapport-lua', workspaceId: otherWorkspace.id })
        .loginAs(user)
    ).assertStatus(404)
    const unknown = await client
      .post('/api/v1/projects/from-template')
      .json({ templateId: 'inconnu' })
      .loginAs(user)
    unknown.assertStatus(404)
    unknown.assertBodyContains({ code: TEMPLATE_ERRORS.notFound })
    ;(
      await client
        .post('/api/v1/projects/from-template')
        .json({ templateId: 'rapport-lua', name: 'a\nb' })
        .loginAs(user)
    ).assertStatus(422)
    // Aucun téléchargement pour une demande refusée.
    assert.equal(bucket.hitsOn('rapport-lua/rapport-lua.zip'), 0)
    assert.lengthOf(await Project.query().where('ownerId', user.id), 0)
  })

  test('refuses an archive that does not match the catalog', async ({ client, assert }) => {
    const { archive, files } = await seedBucket(bucket)
    const user = await createUser()
    const create = () =>
      client
        .post('/api/v1/projects/from-template')
        .json({ templateId: 'rapport-lua' })
        .loginAs(user)

    // Même taille, contenu modifié : sha256 différent.
    const tampered = Buffer.from(archive)
    tampered[tampered.length - 1] = (tampered.at(-1) ?? 0) ^ 0xff
    bucket.files.set(files.zip.path, tampered)
    const corrupted = await create()
    corrupted.assertStatus(502)
    corrupted.assertBodyContains({ code: TEMPLATE_ERRORS.integrity })

    // Plus long qu'annoncé : lecture interrompue.
    bucket.files.set(files.zip.path, Buffer.concat([archive, Buffer.alloc(1024)]))
    const longer = await create()
    longer.assertStatus(502)
    longer.assertBodyContains({ code: TEMPLATE_ERRORS.integrity })

    bucket.files.delete(files.zip.path)
    const missing = await create()
    missing.assertStatus(502)
    missing.assertBodyContains({ code: TEMPLATE_ERRORS.downloadFailed })

    assert.lengthOf(await Project.query().where('ownerId', user.id), 0)
  })

  test('applies the storage limit of the plan before downloading', async ({ client, assert }) => {
    await seedBucket(bucket)
    const user = await createUser()
    const filler = await client.post('/api/v1/projects').json({ name: 'Full' }).loginAs(user)
    await File.create({
      projectId: String(filler.body().project.id),
      folderId: null,
      name: `big-${randomUUID()}.pdf`,
      s3Key: `projects/${String(filler.body().project.id)}/files/${randomUUID()}`,
      sha256: 'a'.repeat(64),
      sizeBytes: FREE_STORAGE,
      mimeType: 'application/pdf',
    })
    const response = await client
      .post('/api/v1/projects/from-template')
      .json({ templateId: 'rapport-lua' })
      .loginAs(user)
    response.assertStatus(403)
    assert.equal(planLimitErrorSchema.parse(response.body()).limit.name, 'storage')
    assert.equal(bucket.hitsOn('rapport-lua/rapport-lua.zip'), 0)
  })
})
