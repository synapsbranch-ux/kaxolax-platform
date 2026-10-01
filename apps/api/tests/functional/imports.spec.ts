import { readDocumentText } from '@kaxolax/collab'
import testUtils from '@adonisjs/core/services/test_utils'
import { test } from '@japa/runner'
import type { ApiClient } from '@japa/api-client'
import yazl from 'yazl'
import Document from '#models/document'
import File from '#models/file'
import Project from '#models/project'
import Upload from '#models/upload'
import type User from '#models/user'
import Workspace from '#models/workspace'
import ObjectStorage from '#services/object_storage'
import { createUser } from '#tests/helpers'

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 7, 7])
const MAIN = [
  '\\documentclass{article}',
  '\\usepackage{graphicx}',
  '\\begin{document}',
  '\\input{sections/intro}',
  '\\includegraphics{figures/plot.png}',
  '\\cite{knuth}',
  '\\bibliographystyle{plain}',
  '\\bibliography{references}',
  '\\end{document}',
  '',
].join('\n')

async function zip(entries: Record<string, string | Buffer>): Promise<Buffer> {
  const archive = new yazl.ZipFile()
  for (const [name, content] of Object.entries(entries)) {
    archive.addBuffer(typeof content === 'string' ? Buffer.from(content) : content, name)
  }
  archive.end()
  const chunks: Buffer[] = []
  for await (const chunk of archive.outputStream) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks)
}

async function importArchive(
  client: ApiClient,
  user: User,
  filename: string,
  content: Buffer,
  body: { workspaceId?: string } = {},
) {
  const started = await client
    .post('/api/v1/imports')
    .json({ filename, sizeBytes: content.length })
    .loginAs(user)
  started.assertStatus(201)
  const { uploadId, url } = started.body() as { uploadId: string; url: string }
  const put = await fetch(url, { method: 'PUT', body: content })
  if (!put.ok) throw new Error(`S3 PUT failed: ${String(put.status)}`)
  const completed = await client
    .post(`/api/v1/imports/${uploadId}/complete`)
    .json(body)
    .loginAs(user)
  return { completed, uploadId }
}

test.group('zip import', (group) => {
  group.each.setup(() => testUtils.db().wrapInGlobalTransaction())

  test('creates a project with its tree, binaries in S3 and the main document', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const archive = await zip({
      'main.tex': MAIN,
      'references.bib': '@book{knuth, title={The \\TeX book}, author={Knuth}, year={1984}}\n',
      'sections/intro.tex': '\\section{Introduction}\nBonjour.\n',
      'figures/plot.png': PNG,
    })
    const { completed, uploadId } = await importArchive(client, user, 'Mon article.zip', archive)
    completed.assertStatus(201)
    completed.assertBodyContains({
      project: { name: 'Mon article', compiler: 'pdflatex', role: 'owner' },
    })
    const projectId = completed.body().project.id as string

    const tree = await client.get(`/api/v1/projects/${projectId}/tree`).loginAs(user)
    const body = tree.body() as {
      mainDocumentId: string
      folders: { path: string }[]
      documents: { id: string; path: string }[]
      files: { id: string; path: string; mimeType: string }[]
    }
    assert.sameMembers(
      body.folders.map((folder) => folder.path),
      ['figures', 'sections'],
    )
    assert.sameMembers(
      body.documents.map((document) => document.path),
      ['main.tex', 'references.bib', 'sections/intro.tex'],
    )
    assert.deepEqual(
      body.files.map((file) => [file.path, file.mimeType]),
      [['figures/plot.png', 'image/png']],
    )
    const main = body.documents.find((document) => document.path === 'main.tex')
    assert.equal(body.mainDocumentId, main?.id)

    const intro = await Document.query().where({ projectId, name: 'intro.tex' }).firstOrFail()
    assert.equal(
      readDocumentText(new Uint8Array(intro.yjsState ?? Buffer.alloc(0))),
      '\\section{Introduction}\nBonjour.\n',
    )
    const file = await File.query().where('projectId', projectId).firstOrFail()
    const stored = Buffer.concat(await (await new ObjectStorage().read(file.s3Key)).toArray())
    assert.deepEqual(stored, PNG)
    assert.equal((await Upload.findOrFail(uploadId)).status, 'completed')
    // Rattaché au workspace personnel de l'utilisateur.
    const personal = await Workspace.query().where({ ownerId: user.id, type: 'personal' }).first()
    assert.equal(completed.body().project.workspaceId, personal?.id)
    assert.equal((await Project.findOrFail(projectId)).workspaceId, personal?.id)
  })

  test("refuses to import into another user's workspace, then imports into a given one", async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const other = await createUser()
    const foreign = await Workspace.query().where('ownerId', other.id).firstOrFail()
    const archive = await zip({ 'main.tex': MAIN })
    const { completed, uploadId } = await importArchive(client, user, 'paper.zip', archive, {
      workspaceId: foreign.id,
    })
    completed.assertStatus(404)
    completed.assertBodyContains({ code: 'E_WORKSPACE_NOT_FOUND' })
    // Refus avant tout travail : l'upload reste utilisable.
    assert.equal((await Upload.findOrFail(uploadId)).status, 'pending')
    assert.lengthOf(await Project.query().where('ownerId', user.id), 0)

    const personal = await Workspace.query().where('ownerId', user.id).firstOrFail()
    const retried = await client
      .post(`/api/v1/imports/${uploadId}/complete`)
      .json({ workspaceId: personal.id })
      .loginAs(user)
    retried.assertStatus(201)
    retried.assertBodyContains({ project: { workspaceId: personal.id, spellcheckLanguage: 'en' } })
  })

  test('detects XeLaTeX projects and a main document other than main.tex', async ({ client }) => {
    const user = await createUser()
    const archive = await zip({
      'thesis/report.tex':
        '\\documentclass{report}\n\\usepackage{fontspec}\n\\begin{document}x\\end{document}\n',
      'thesis/chapter.tex': '\\chapter{Un}\n',
    })
    const { completed } = await importArchive(client, user, 'thesis.zip', archive)
    completed.assertStatus(201)
    completed.assertBodyContains({ project: { name: 'thesis', compiler: 'xelatex' } })
    const projectId = completed.body().project.id as string
    const tree = await client.get(`/api/v1/projects/${projectId}/tree`).loginAs(user)
    const report = (tree.body().documents as { id: string; path: string }[]).find(
      (document) => document.path === 'report.tex',
    )
    tree.assertBodyContains({ mainDocumentId: report?.id })
  })

  test('rejects a zip with ../ and a lying zip bomb without creating a project', async ({
    client,
    assert,
  }) => {
    const user = await createUser()
    const traversal = Buffer.from(
      (await zip({ 'main.tex': MAIN, 'xx/evil.tex': 'pwned' }))
        .toString('latin1')
        .replaceAll('xx/evil.tex', '../evil.tex'),
      'latin1',
    )
    const unsafe = await importArchive(client, user, 'evil.zip', traversal)
    unsafe.completed.assertStatus(422)
    unsafe.completed.assertBodyContains({ code: 'E_ZIP_UNSAFE_PATH' })
    assert.equal((await Upload.findOrFail(unsafe.uploadId)).status, 'failed')

    // 10 Mio de zéros, annoncés comme 1 000 octets dans le répertoire central.
    const honest = await zip({ 'main.tex': MAIN, 'bomb.bin': Buffer.alloc(10 * 1024 * 1024) })
    const lying = Buffer.from(honest)
    let offset = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]))
    offset = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]), offset + 4)
    lying.writeUInt32LE(1000, offset + 24)
    const bomb = await importArchive(client, user, 'bomb.zip', lying)
    bomb.completed.assertStatus(422)
    bomb.completed.assertBodyContains({ code: 'E_ZIP_TOO_LARGE' })

    const projects = await Project.query().where('ownerId', user.id)
    assert.lengthOf(projects, 0)
  })

  test('refuses files that are not zips', async ({ client }) => {
    const user = await createUser()
    const wrongName = await client
      .post('/api/v1/imports')
      .json({ filename: 'project.tar.gz', sizeBytes: 100 })
      .loginAs(user)
    wrongName.assertStatus(422)
    const { completed } = await importArchive(client, user, 'fake.zip', Buffer.from('not a zip'))
    completed.assertStatus(422)
    completed.assertBodyContains({ code: 'E_ZIP_INVALID' })
  })
})
